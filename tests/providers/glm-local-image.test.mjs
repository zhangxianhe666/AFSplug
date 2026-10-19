import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import { build } from 'esbuild'

const root = process.cwd()

/**
 * GLM 侧的本地图片通道（ds-trim-gateway 路线 A）回归测试。
 *
 * GLM 与 DeepSeek 的区别：GLM 的适配器**本来就有**一条图片附件通道
 * （`uploadFile` → `refs` → `messagesToPrompt` 的 image_url 部件），且
 * `uploadFile` 原生接受 base64 data URI。所以本地图片只需要把
 * `[[local-image:/abs/path]]` 读成 data URI 塞进那条通道，不需要新写上传。
 *
 * 这里既测可注入的纯逻辑，也用源码断言锁死接线位置——接错了功能就会静默失效。
 */
const localImage = await (async () => {
  const result = await build({
    entryPoints: [join(root, 'src/main/proxy/adapters/localImage.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
  })
  const code = result.outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
})()

function glmSource() {
  return readFileSync(join(root, 'src/main/proxy/adapters/glm.ts'), 'utf8')
}

// ───────────────────────── 纯逻辑 ─────────────────────────

test('resolveLocalImageUris：抽出路径、生成 URI、正文不留痕迹', () => {
  const seen = []
  const { cleaned, uris, found } = localImage.resolveLocalImageUris(
    '[当前用户问题]\n@图片.png 图里是什么内容\n[[local-image:/Users/me/Downloads/测试/图片.png]]',
    (absPath) => {
      seen.push(absPath)
      return `data:image/png;base64,AAAA`
    },
  )

  assert.deepEqual(seen, ['/Users/me/Downloads/测试/图片.png'], '必须把绝对路径原样交给读取器')
  assert.deepEqual(uris, ['data:image/png;base64,AAAA'])
  assert.equal(found, 1)
  assert.doesNotMatch(cleaned, /local-image/, '标记必须被剥掉')
  assert.doesNotMatch(cleaned, /\/Users\//, '本地绝对路径绝不能进正文')
  assert.match(cleaned, /图里是什么内容/)
})

test('resolveLocalImageUris：单张读取失败只跳过它，其余照常', () => {
  const { cleaned, uris, found } = localImage.resolveLocalImageUris(
    '看这两张\n[[local-image:/a/ok.png]]\n[[local-image:/a/bad.png]]',
    (absPath) => (absPath.endsWith('bad.png') ? '' : `data:image/png;base64,OK`),
  )

  assert.equal(found, 2, '命中张数要如实反映，便于日志观察')
  assert.deepEqual(uris, ['data:image/png;base64,OK'])
  assert.doesNotMatch(cleaned, /local-image/)
  assert.match(cleaned, /看这两张/)
})

test('resolveLocalImageUris：没有标记时正文原样返回', () => {
  const text = '普通问题，没有图片'
  const { cleaned, uris, found } = localImage.resolveLocalImageUris(text, () => 'x')
  assert.equal(cleaned, text)
  assert.deepEqual(uris, [])
  assert.equal(found, 0)
})

test('buildDataUri：格式正确且字节可还原', () => {
  const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const uri = localImage.buildDataUri('image/png', data)

  assert.match(uri, /^data:image\/png;base64,/)
  const roundTrip = Buffer.from(uri.split(',')[1], 'base64')
  assert.deepEqual(roundTrip, data, 'base64 必须能被 GLM 的 removeBase64Header 还原')
})

test('buildDataUri：MIME 为空时退化成 octet-stream', () => {
  const uri = localImage.buildDataUri('', Buffer.from([1, 2, 3]))
  assert.match(uri, /^data:application\/octet-stream;base64,/)
})

test('LOCAL_IMAGE_MARKER_PREFIX 与标记格式一致', () => {
  const { paths } = localImage.extractLocalImages(`${localImage.LOCAL_IMAGE_MARKER_PREFIX}/a/x.png]]`)
  assert.deepEqual(paths, ['/a/x.png'])
})

// ───────────────────────── 接线（源码断言）─────────────────────────

test('接线：两条来源都在上传前解析，且标记优先、不重复', () => {
  const source = glmSource()
  const markerAt = source.indexOf('this.extractMarkerImageUris(messages)')
  const refAt = source.indexOf('this.collectWorkspaceImageUris(messages)')
  const extractAt = source.indexOf('this.extractFileUrls(messages)')

  assert.ok(markerAt > -1, '必须消费网关注入的 [[local-image:…]] 标记')
  assert.ok(refAt > -1, '必须能自己解析 <workspace-reference>（DSH 直连上游的路由没有标记）')
  assert.ok(markerAt < extractAt && refAt < extractAt, '两条来源都要在上传之前解析完')
  // 有标记时跳过引用解析：两者指向同一批文件，重复上传只是白花时间
  assert.match(source,
    /markerImageUris\.length > 0\s*\?\s*\[\]\s*:\s*this\.collectWorkspaceImageUris\(messages\)/,
    '标记存在时不应再解析引用')
})

test('接线：本地图片与原生附件一起进入上传循环', () => {
  const source = glmSource()
  assert.match(source, /for \(const imageUrl of \[\.\.\.imageUrls, \.\.\.localImageUris\]\)/,
    '本地图片必须并入既有上传循环，而不是另起一套')
})

test('接线：本地文件走 data URI，命中 uploadFile 的 base64 分支', () => {
  const source = glmSource()

  assert.match(source, /readLocalImageAsDataUri/, '必须有读盘 → data URI 的转换')
  assert.match(source, /buildDataUri\(mime \|\| 'application\/octet-stream', fs\.readFileSync\(absPath\)\)/)
  // uploadFile 的 base64 判定
  assert.match(source, /if \(this\.isBase64Data\(fileUrl\)\)/, 'uploadFile 认 data URI')
})

test('安全：读盘失败/超限只记日志并跳过，不得抛出', () => {
  const source = glmSource()
  const body = source.slice(
    source.indexOf('private readLocalImageAsDataUri'),
    source.indexOf('private extractFileUrls'),
  )

  assert.match(body, /catch \(error\)[\s\S]*?return ''/, '读盘异常必须吞掉并返回空串')
  assert.match(body, /超出上限/, '超限要按上限挡掉')
  assert.match(body, /storeManager\.addLog/, '跳过原因必须落盘，否则无从排查')
  assert.doesNotMatch(body, /throw /, '本地图片的任何问题都不该中断整轮对话')
})

test('诊断：上传请求与响应都写入应用日志', () => {
  const source = glmSource()

  assert.match(source, /\[GLM\] 开始上传/, '上传前记一条')
  assert.match(source, /\[GLM\] 上传成功: source_id=/, '成功后记 source_id 与 file_url')
  assert.match(source, /\[GLM\] 上传失败: \$\{detail\}/, '失败要记下响应体')
  assert.match(source, /JSON\.stringify\(response\.data\)\.slice\(0, 400\)/,
    'GLM 的失败也常是 HTTP 200 + 业务错误码，响应体必须落盘')
})

test('诊断：图片上传失败退化为纯文本而不是中断', () => {
  const source = glmSource()
  const body = source.slice(source.indexOf('// Upload images'), source.indexOf('const preparedMessages'))

  assert.match(body, /catch \(error\)[\s\S]*?storeManager\.addLog\('error'/,
    '单张失败只记日志')
  assert.doesNotMatch(body, /throw /, '上传失败不得向上抛，否则整轮对话失败')
})

// ───────────────────────── 出口格式（踩过的坑）─────────────────────────

test('出口：发给 chatglm 的图片部件是原生 image 格式，不是 OpenAI 的 image_url', () => {
  const source = glmSource()
  const body = source.slice(
    source.indexOf('// Add image references'),
    source.indexOf('// Process messages'),
  )

  // chatglm 的线上协议是 { type:'image', image:[ <上传结果> … ] }
  assert.match(body, /type: 'image',/, 'chatglm 认的是 type:image')
  assert.match(body, /image: imageRefs,/, '所有图片放进同一个部件的 image 数组')
  // 发成 OpenAI 格式时模型收不到图，而上游不报错——这是本功能最初的失败原因
  // （只匹配代码，跳过上面解释性注释里的举例）
  assert.doesNotMatch(body, /content\.push\(\{\s*type: 'image_url'/,
    '不得发 OpenAI 的 image_url 部件')
})

test('出口：不得用 width/height 当图片引用哨兵（会覆盖上传结果自带的真实尺寸）', () => {
  const source = glmSource()

  // 上传结果本身带 width/height（服务端解析出来的真实尺寸），
  // 用同名字段作标记会把它覆盖成 0，出口再剔除就等于丢了
  assert.doesNotMatch(source, /width: 0,\s*\n\s*height: 0,/,
    'refs 里不该再塞 width:0/height:0 哨兵')
  assert.match(source, /typeof ref\.image_url === 'string' && ref\.image_url\.length > 0/,
    '图片 ref 的判据必须是 image_url')
  assert.match(source, /\.\.\.result,/, '上传结果整份保留（含真实 width/height）')
})

test('出口：图片载荷保留整份上传结果，不按字段挑', () => {
  const source = glmSource()
  const pushBody = source.slice(source.indexOf('// Upload images'))

  // 新版 chatglm 的上传响应已无 source_id（实测 undefined），
  // 按字段挑会把载荷挑空，必须原样带上整份 result
  assert.match(pushBody, /\.\.\.result,/, 'refs 要展开整份上传结果')
  assert.match(source, /\[GLM\] 上传响应原文:/, '上传响应原文必须落盘，才能看出字段名变化')
})
