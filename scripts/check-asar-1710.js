/**
 * 产物校验（v1.7.10）
 *
 * 每次都从打包好的 app.asar 里直接读编译后的文本，而不是只信源码——前面踩过
 * 「源码改了但 asar 里还是旧的」的坑（portable 内嵌 asar，手改无效）。
 */
const asar = require('@electron/asar')

const p = 'dist-1710/win-unpacked/resources/app.asar'
const files = asar.listPackage(p).filter((f) => f.endsWith('out\\main\\index.js'))
let txt = ''
for (const f of files) txt += asar.extractFile(p, f.replace(/^\\/, '')).toString('utf8')

const must = {
  '属性式调用恢复': '属性式调用已恢复',
  '三态泄漏判据': 'leaked_tool_call',
  '泄漏纠偏文案': '没有被识别成调用',
  '三态协议段落': 'Turn Protocol',
  '[done] 标记': '[done]',
  '三态判定日志': '三态：',
  'UNDECLARED 判据': 'undeclared_task',
  'DONE 核验判据': 'done_missing_file',
  '虚构阻塞判据': 'blocked_fake_limit',
  '关闭开关': 'AFS_DISABLE_TURN_STATE',
  '灰度开关': 'AFS_TURN_STATE_DRYRUN',
  '重开预算开关': 'AFS_TURN_STATE_RETRY',
  '未核验标注': '未经核验',
}

const mustNot = {
  '旧 macOS 硬编码': 'machine (macOS)',
  '旧裁剪文案': '内容不完整',
}

let fail = 0
for (const [k, v] of Object.entries(must)) {
  const ok = txt.includes(v)
  if (!ok) fail += 1
  console.log(`${ok ? 'OK  ' : 'MISS'} 含 ${k} (${v})`)
}

for (const [k, v] of Object.entries(mustNot)) {
  const ok = !txt.includes(v)
  if (!ok) fail += 1
  console.log(`${ok ? 'OK  ' : 'BAD '} 不含 ${k} (${v})`)
}

console.log(fail === 0 ? '\nasar 校验通过' : `\nasar 校验失败：${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
