import test from 'node:test'
import assert from 'node:assert/strict'

import { trimToolResults } from '../../src/main/proxy/toolCalling/toolBudget.ts'

function tool(content: string, extra: Record<string, unknown> = {}) {
  return { role: 'tool', content, ...extra } as any
}

test('短结果原样保留', () => {
  const messages = [{ role: 'user', content: 'hi' }, tool('ok: 3 files')]
  const out = trimToolResults(messages, { singleLimit: 6000, totalLimit: 18000 })
  assert.equal(out.trimmed, 0)
  assert.equal(out.messages[1].content, 'ok: 3 files')
})

test('单条超限时保留头尾、中间标注省略', () => {
  const body = `${'A'.repeat(4000)}${'M'.repeat(4000)}${'Z'.repeat(4000)}`
  const out = trimToolResults([tool(body)], { singleLimit: 3000, totalLimit: 18000 })
  const content = String(out.messages[0].content)
  assert.equal(out.trimmed, 1)
  assert.ok(content.startsWith('AAA'))
  assert.ok(content.endsWith('ZZZ'), '尾部要保留：JSON 的关键字段常在末尾')
  assert.match(content, /此处省略/)
  // 16:26 现场：原文案「内容不完整」被模型复述成「抓取工具多次被截断，无法完整解析」，
  // 据此放弃任务。提示语必须表明这两段数据可以照常用。
  assert.doesNotMatch(content, /内容不完整/, '不能告诉模型数据不可用')
  assert.match(content, /可以照常使用/)
  assert.match(content, /不要重新抓取/)
})

test('裁剪时把完整原文落到本地文件，模型可用 shell 精确读取', async () => {
  const body = `${'A'.repeat(4000)}${'M'.repeat(4000)}${'Z'.repeat(4000)}`
  const out = trimToolResults([tool(body)], { singleLimit: 3000, totalLimit: 18000 })
  const content = String(out.messages[0].content)
  const matched = content.match(/已保存到本机文件：([^ ]+?) ——/)
  assert.ok(matched, `提示语里必须给出文件路径，实际：${content.slice(0, 400)}`)
  const spill = matched![1].trim()
  const fs = await import('node:fs')
  assert.ok(fs.existsSync(spill), `落盘文件不存在：${spill}`)
  assert.equal(fs.readFileSync(spill, 'utf8').length, body.length, '落盘的必须是完整原文')
  assert.match(content, /不要重新抓取来源/)
  fs.unlinkSync(spill)
})

test('AFS_TOOL_RESULT_SPILL=0 时不落盘（降级为纯裁剪提示）', () => {
  const body = 'A'.repeat(9000)
  process.env.AFS_TOOL_RESULT_SPILL = '0'
  try {
    const out = trimToolResults([tool(body)], { singleLimit: 3000, totalLimit: 18000 })
    const content = String(out.messages[0].content)
    assert.doesNotMatch(content, /已保存到本机文件/)
    assert.match(content, /可以照常使用/)
  } finally {
    delete process.env.AFS_TOOL_RESULT_SPILL
  }
})

test('总量超预算时，更早的结果被整条折叠', () => {
  const old = tool('x'.repeat(5000))
  const recent = tool('y'.repeat(5000))
  const out = trimToolResults([old, recent], { singleLimit: 6000, totalLimit: 6000 })
  assert.equal(out.trimmed, 1)
  // 最近的一条必须完整保留
  assert.equal(out.messages[1].content.length, 5000)
  assert.match(String(out.messages[0].content), /已折叠/)
})

test('只处理 role=tool，不动 user / system', () => {
  const messages = [
    { role: 'system', content: 's'.repeat(9000) },
    { role: 'user', content: 'u'.repeat(9000) },
    tool('t'.repeat(9000)),
  ]
  const out = trimToolResults(messages, { singleLimit: 1000, totalLimit: 1000 })
  assert.equal(out.messages[0].content.length, 9000)
  assert.equal(out.messages[1].content.length, 9000)
  assert.ok(String(out.messages[2].content).length < 9000)
})

test('预算为 0 时整体关闭', () => {
  const messages = [tool('t'.repeat(9000))]
  const out = trimToolResults(messages, { singleLimit: 0, totalLimit: 0 })
  assert.equal(out.trimmed, 0)
  assert.equal(out.messages, messages)
})

test('parts 数组形态的 content 也能裁剪', () => {
  const messages = [tool(undefined as any, { content: [{ type: 'text', text: 'p'.repeat(9000) }] })]
  const out = trimToolResults(messages, { singleLimit: 1000, totalLimit: 1000 })
  assert.equal(out.trimmed, 1)
  assert.equal(typeof out.messages[0].content, 'string')
})
