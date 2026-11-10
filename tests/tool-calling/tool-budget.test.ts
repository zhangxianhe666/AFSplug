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
  assert.match(content, /中间省略/)
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
