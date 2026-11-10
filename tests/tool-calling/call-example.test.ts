import test from 'node:test'
import assert from 'node:assert/strict'

import { renderCallExample } from '../../src/main/proxy/toolCalling/callExample.ts'

test('managed_xml 的示例必须是 <tool_calls><invoke> 结构', () => {
  const text = renderCallExample('write', { path: 'C:\\tmp\\a.xlsx', content: 'x' }, 'managed_xml')
  assert.equal(
    text,
    '<tool_calls><invoke name="write"><parameter name="path">C:\\tmp\\a.xlsx</parameter><parameter name="content">x</parameter></invoke></tool_calls>',
  )
})

test('managed_bracket 的示例走 [function_calls][call:]', () => {
  const text = renderCallExample('web_fetch', { url: 'https://a' }, 'managed_bracket')
  assert.equal(text, '[function_calls][call:web_fetch]{"url":"https://a"}[/call][/function_calls]')
})

test('缺省协议按 XML 渲染（与 managedXml 的 parse 分支一致）', () => {
  const text = renderCallExample('read', { path: 'a.txt' }, undefined)
  assert.match(text, /^<tool_calls><invoke name="read">/)
})
