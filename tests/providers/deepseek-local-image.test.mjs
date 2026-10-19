import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import { build } from 'esbuild'

const root = process.cwd()

/**
 * 本地图片通道（ds-trim-gateway 路线 A）的回归测试。
 *
 * 覆盖两侧的接缝：
 *  - 网关产出的 `[[local-image:/abs/path]]` 标记必须被完整抽取并剥离
 *    （标记里带本地绝对路径，绝不能留在送给模型的正文里）；
 *  - 手拼的 multipart 必须能被真实 HTTP 服务端按字节解析出来
 *    （手拼的原因是不依赖 FormData/Blob 在 Electron 主进程里的可用性）。
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

test('抽取标记：路径被取出、正文被清干净', () => {
  const prompt = [
    '[当前用户问题]',
    '@图片_20251204161442.png 图里是什么内容',
    '<workspace-reference path="图片_20251204161442.png" kind="file" />',
    '[[local-image:/Users/zhangxianhe/Downloads/zero/测试/图片_20251204161442.png]]',
  ].join('\n')

  const { paths, cleaned } = localImage.extractLocalImages(prompt)

  assert.deepEqual(paths, ['/Users/zhangxianhe/Downloads/zero/测试/图片_20251204161442.png'])
  assert.doesNotMatch(cleaned, /local-image/)
  assert.doesNotMatch(cleaned, /\/Users\//, '本地绝对路径不得出现在送给模型的正文里')
  assert.match(cleaned, /图里是什么内容/)
})

test('抽取标记：去重并按上限截断', () => {
  const marker = (p) => `[[local-image:${p}]]`
  const prompt = [
    marker('/a/1.png'),
    marker('/a/2.png'),
    marker('/a/1.png'),
    marker('/a/3.png'),
    marker('/a/4.png'),
    marker('/a/5.png'),
  ].join('\n')

  assert.deepEqual(localImage.extractLocalImages(prompt).paths, ['/a/1.png', '/a/2.png', '/a/3.png', '/a/4.png'])
  assert.deepEqual(localImage.extractLocalImages(prompt, 2).paths, ['/a/1.png', '/a/2.png'])
})

test('抽取标记：没有标记时正文原样保留', () => {
  const prompt = '上证指数收于 3939.33 点。'
  const { paths, cleaned } = localImage.extractLocalImages(prompt)
  assert.deepEqual(paths, [])
  assert.equal(cleaned, prompt)
})

test('抽取标记：路径含 ] 这种畸形标记不会吞掉正文', () => {
  const { cleaned } = localImage.extractLocalImages('问题[[local-image:/a/b.png]]尾巴')
  assert.equal(cleaned, '问题尾巴')
})

test('multipart：手工拼的正文可被真实服务端按字节解析', async () => {
  const fileBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02])
  const { body, boundary } = localImage.buildMultipartBody(
    '图片_20251204161442.png', 'image/png', fileBytes, '----TESTBOUNDARY123')

  assert.equal(boundary, '----TESTBOUNDARY123')
  assert.ok(body.subarray(0, 2).toString() === '--')
  assert.ok(body.toString('latin1').includes(`Content-Type: image/png`))
  assert.ok(body.toString('utf8').includes('name="file"'))
  // 中文文件名按 utf8 写入，且不能带引号/换行把头部拆坏
  assert.ok(body.toString('utf8').includes('filename="图片_20251204161442.png"'))
  assert.ok(body.subarray(body.length - 4).toString('latin1') === '--\r\n')

  // 用一个真的 HTTP server 收一遍：证明 boundary / 分隔 / 字节都对得上
  const received = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        res.end('ok')
        server.close()
        resolve({ headers: req.headers, raw: Buffer.concat(chunks) })
      })
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address()
      await fetch(`http://127.0.0.1:${port}/v0/file/upload_file`, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.length),
        },
        body,
      }).catch(reject)
    })
  })

  assert.equal(received.headers['content-length'], String(body.length),
    'Content-Length 必须等于正文长度，否则服务端会截断')
  assert.match(received.headers['content-type'], /multipart\/form-data; boundary=----TESTBOUNDARY123/)

  // 从收到的原始字节里按 boundary 切出文件内容，必须与源文件逐字节一致
  const text = received.raw.toString('latin1')
  const head = text.indexOf('\r\n\r\n') + 4
  const tail = text.lastIndexOf('\r\n------TESTBOUNDARY123--')
  assert.deepEqual(
    received.raw.subarray(head, tail),
    fileBytes,
    '往返后文件字节必须完全一致')
})

test('multipart：文件名里的引号与换行不会破坏头部', () => {
  const { body } = localImage.buildMultipartBody('a"\r\nb.png', 'image/png', Buffer.from([1]), '--B')
  const head = body.toString('utf8').split('\r\n\r\n')[0]
  assert.equal(head.split('\r\n').length, 3, '头必须仍是三行')
  assert.ok(head.includes('filename="a___b.png"'))
})

test('MIME 按扩展名判定（大小写不敏感）', () => {
  assert.equal(localImage.imageMimeOf('/x/A.PNG'), 'image/png')
  assert.equal(localImage.imageMimeOf('/x/a.webp'), 'image/webp')
  assert.equal(localImage.imageMimeOf('/x/a.jpeg'), 'image/jpeg')
  assert.equal(localImage.imageMimeOf('/x/a.txt'), '')
})

test('适配器：两条来源都被消费、ref_file_ids 被真正回填', () => {
  const source = readFileSync(join(root, 'src/main/proxy/adapters/deepseek.ts'), 'utf8')

  assert.match(source, /import \{[\s\S]*?extractLocalImages[\s\S]*?\} from '\.\/localImage'/)
  assert.match(source, /const marker = extractLocalImages\(prompt\)/)
  assert.match(source, /prompt = marker\.cleaned/,
    '网关注入的标记必须从正文剥掉（里面是本地绝对路径）')
  assert.match(source, /collectWorkspaceImagePaths\(\[prompt\]\)/,
    '没有标记时要自己解析 <workspace-reference>（DSH 直连上游的路由不经过网关）')
  assert.match(source, /ref_file_ids: refFileIds/,
    'ref_file_ids 必须用上传结果，不能再写死空数组')
  assert.doesNotMatch(source, /ref_file_ids: \[\],/)
})

test('适配器：上传用独立 PoW（target_path 指向上传接口）', () => {
  const source = readFileSync(join(root, 'src/main/proxy/adapters/deepseek.ts'), 'utf8')

  assert.match(source, /getChallenge\(UPLOAD_TARGET_PATH\)/,
    '上传的 PoW 挑战必须按上传接口申请，复用 completion 的挑战会被服务端拒绝')
  assert.match(source, /calculateChallengeAnswer\(challenge, UPLOAD_TARGET_PATH\)/)
  assert.match(source, /target_path: targetPath/)
  assert.match(localImageSource(), /UPLOAD_TARGET_PATH = '\/api\/v0\/file\/upload_file'/)
})

test('适配器：单张上传失败只丢这张图，不阻断对话', () => {
  const source = readFileSync(join(root, 'src/main/proxy/adapters/deepseek.ts'), 'utf8')

  // 逐张 try/catch：失败的图跳过，返回成功的那几张
  assert.match(source, /for \(const absPath of absPaths\) \{[\s\S]*?try \{[\s\S]*?\} catch \(error\) \{[\s\S]*?console\.warn/)
  assert.doesNotMatch(source, /await this\.uploadLocalImages\(imagePaths, token[\s\S]{0,40}catch[\s\S]{0,80}throw/,
    '上传失败不得向上抛，否则整轮对话失败')
})

test('带图必须声明 vision（上传头 + completion 的 model_type）', async () => {
  // 实测文档：上传类型只有 default/expert/vision，带图请求不写 vision
  // 下游会退回纯文本语义 —— 表现就是模型对图片返回空内容且上游不报错。
  const result = await build({
    entryPoints: [join(root, 'src/main/proxy/adapters/providerModelOptions.ts')],
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  })
  const mod = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

  assert.equal(mod.resolveDeepSeekChatOptions({ model: 'DeepSeek-V4.1-Flash' }, '', true).modelType,
    'vision', '带图时必须 vision')
  assert.equal(mod.resolveDeepSeekChatOptions({ model: 'DeepSeek-V4.1-Flash' }, '', false).modelType,
    'default')
  assert.equal(mod.resolveDeepSeekChatOptions({ model: 'deepseek-v4-pro' }, '', false).modelType,
    'expert')
  assert.equal(mod.resolveDeepSeekChatOptions({ model: 'deepseek-v4-pro' }, '', true).modelType,
    'vision', '带图优先于 expert')

  const source = readFileSync(join(root, 'src/main/proxy/adapters/deepseek.ts'), 'utf8')
  assert.match(source, /\[MODEL_TYPE_HEADER\]: modelType/,
    '上传必须带上 x-model-type，否则这份文件会被当纯文本')
  assert.match(source, /resolveDeepSeekChatOptions\(request, prompt, hasImages\)/,
    'completion 的 model_type 必须由"是否带图"决定')
  assert.match(localImageSource(), /VISION_MODEL_TYPE = 'vision'/)
  assert.match(localImageSource(), /MODEL_TYPE_HEADER = 'x-model-type'/)
})

test('适配器：completion 的 PoW 在图片上传之后才申请', () => {
  const source = readFileSync(join(root, 'src/main/proxy/adapters/deepseek.ts'), 'utf8')
  const body = source.slice(source.indexOf('async chatCompletion'))

  const uploadAt = body.indexOf('uploadLocalImages(imagePaths, token')
  const challengeAt = body.indexOf("getChallenge('/api/v0/chat/completion')")
  assert.ok(uploadAt > -1 && challengeAt > -1, '两处调用都必须存在')
  assert.ok(uploadAt < challengeAt,
    'completion 的 PoW 挑战必须让位于上传之后：上传会申请新挑战，让先前签发的挑战失效')
})

test('错误体识别：DeepSeek 的 HTTP 200 JSON 错误不能被当成空流', async () => {
  const result = await build({
    entryPoints: [join(root, 'src/main/proxy/adapters/deepseekError.ts')],
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  })
  const mod = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

  assert.equal(mod.describeDeepSeekErrorLine('{"code":40301,"msg":"INVALID_POW_RESPONSE"}'),
    'code=40301 msg=INVALID_POW_RESPONSE')
  assert.equal(mod.describeDeepSeekErrorLine('{"code":40003,"msg":"Authorization Failed (invalid token)"}'),
    'code=40003 msg=Authorization Failed (invalid token)')
  assert.equal(mod.describeDeepSeekErrorLine(''), '')
  assert.equal(mod.describeDeepSeekErrorLine('event: message'), '')
  assert.equal(mod.describeDeepSeekErrorLine(': keep-alive'), '')
  assert.ok(mod.describeDeepSeekErrorLine('not json at all').length > 0)
  assert.equal(mod.describeDeepSeekErrorLine('data: {"v":"hi"}'), '',
    '正常 SSE 行不能被误报成错误')
})

test('流处理器：非 SSE 行会被记录，而不是静默跳过', () => {
  const source = readFileSync(join(root, 'src/main/proxy/adapters/deepseek-stream.ts'), 'utf8')
  assert.match(source, /if \(!line\.startsWith\('data:'\)\) \{[\s\S]*?describeDeepSeekErrorLine\(line\)[\s\S]*?reportUpstreamErrorBody\(detail\)/)
  assert.doesNotMatch(source, /if \(!line\.trim\(\) \|\| !line\.startsWith\('data:'\)\) continue/,
    '不能继续用一行 continue 把上游错误吞掉')
})

test('文件状态解析：能从 fetch_files 响应里认出 PENDING / SUCCESS', () => {
  const wrapper = { code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: {
    files: [{ id: 'file-a', status: 'SUCCESS', width: 64, height: 64 }] } } }
  assert.equal(localImage.extractFileStatus(wrapper, 'file-a'), 'SUCCESS')
  assert.equal(localImage.extractFileStatus(
    { data: { biz_data: { files: [{ id: 'file-b', status: 'PENDING' }] } } }, 'file-b'), 'PENDING')
  // 层级再深一层也要能捞到
  assert.equal(localImage.extractFileStatus(
    { data: { biz_data: { list: [{ file: { id: 'file-c', status: 'SUCCESS' } }] } } }, 'file-c'), 'SUCCESS')
  // 指定 id 优先，其次退回第一个
  assert.equal(localImage.extractFileStatus(
    { data: { biz_data: { files: [{ id: 'x', status: 'PENDING' }, { id: 'y', status: 'SUCCESS' }] } } }, 'y'),
    'SUCCESS')
  assert.equal(localImage.extractFileStatus({}, 'file-a'), '')
})

test('适配器：上传后必须轮询到文件就绪才引用', () => {
  const source = readFileSync(join(root, 'src/main/proxy/adapters/deepseek.ts'), 'utf8')

  // 上传返回的 status 最初是 PENDING、随后是 PARSING，两者都不能引用
  assert.match(source, /await this\.waitForFileReady\(fileId, token\)/,
    '上传成功后必须等待文件解析完成')
  assert.match(source, /\/v0\/file\/fetch_files\?file_ids=/,
    '轮询必须走网页端的 fetch_files 接口')
  assert.match(source, /READY_FILE_STATUSES\.includes\(status\.toUpperCase\(\)\)/,
    '只在 SUCCESS 这类终态才放行；把"不是 PENDING"当就绪会在 PARSING 阶段误判')
  assert.match(localImageSource(), /READY_FILE_STATUSES[^=]*=\s*\['SUCCESS'/,
    '终态集合必须包含 SUCCESS')
  assert.doesNotMatch(source, /status\.toUpperCase\(\) !== 'PENDING'/,
    'PARSING 不是就绪状态，不能这么判')
  // 就绪等待必须发生在缓存写入之前，缓存里存的才是可用的 id
  assert.ok(source.indexOf('await this.waitForFileReady(fileId, token)')
    < source.indexOf('uploadedImageCache.set(cacheKey'), '等待要在写缓存之前')
})

test('引用被拒（code 9）会换掉被污染的会话', () => {
  const source = readFileSync(join(root, 'src/main/proxy/adapters/deepseek-stream.ts'), 'utf8')
  assert.match(source, /function reportUpstreamErrorBody/,
    '错误体处理要收敛成一处')
  assert.match(source, /INVALID_REF_FILE_ID\.test\(detail\)[\s\S]*?clearDeepSeekSessionCache\(\)/,
    'code 9 会污染整个会话，必须清会话缓存')
  assert.match(readFileSync(join(root, 'src/main/proxy/adapters/deepseek.ts'), 'utf8'),
    /export function clearDeepSeekSessionCache\(\): void \{\s*sessionCache\.clear\(\)/)
})

function localImageSource() {
  return readFileSync(join(root, 'src/main/proxy/adapters/localImage.ts'), 'utf8')
}
