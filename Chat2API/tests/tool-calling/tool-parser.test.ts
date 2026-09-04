import test from 'node:test'
import assert from 'node:assert/strict'
import { managedBracketProtocol } from '../../src/main/proxy/toolCalling/protocols/managedBracket.ts'
import { managedXmlProtocol } from '../../src/main/proxy/toolCalling/protocols/managedXml.ts'
import { anthropicToolUseProtocol } from '../../src/main/proxy/toolCalling/protocols/anthropicToolUse.ts'
import { codexResponsesProtocol } from '../../src/main/proxy/toolCalling/protocols/codexResponses.ts'

const tools = [
  {
    name: 'default_api:read_file',
    description: 'Read a file',
    parameters: { type: 'object' },
    source: 'openai' as const,
  },
]

test('managed bracket parses valid tool call', () => {
  const result = managedBracketProtocol.parse(
    '[function_calls]\n[call:default_api:read_file]{"filePath":"/tmp/a"}[/call]\n[/function_calls]',
    { tools, protocol: 'managed_bracket' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, 'default_api:read_file')
  assert.equal(result.content, '')
})

test('managed xml parses valid Chat2API tool call', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, 'default_api:read_file')
})

test('managed xml parses canonical XML compatibility form', () => {
  const result = managedXmlProtocol.parse(
    '<tool_calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/a</parameter></invoke></tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).filePath, '/tmp/a')
})

test('managed xml ignores fenced tool examples', () => {
  const result = managedXmlProtocol.parse(
    '```xml\n<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath">fake</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>\n```',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 0)
})

test('unknown tool name is rejected', () => {
  const result = managedBracketProtocol.parse(
    '[function_calls][call:missing_tool]{"x":1}[/call][/function_calls]',
    { tools, protocol: 'managed_bracket' },
  )

  assert.equal(result.toolCalls.length, 0)
  assert.deepEqual(result.invalidToolNames, ['missing_tool'])
})

test('managed XML parser rejects undeclared tool names and records invalid names', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="missing_tool">{}</|CHAT2API|invoke></|CHAT2API|tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 0)
  assert.deepEqual(result.invalidToolNames, ['missing_tool'])
})

test('anthropic adapter parses antml function calls', () => {
  const result = anthropicToolUseProtocol.parse(
    '<antml:function_calls><antml:invoke name="default_api:read_file"><antml:parameters>{"filePath":"/tmp/a"}</antml:parameters></antml:invoke></antml:function_calls>',
    { tools, protocol: 'anthropic_tool_use' },
  )

  assert.equal(result.toolCalls.length, 1)
})

test('codex responses adapter parses response item function call', () => {
  const result = codexResponsesProtocol.parse(
    JSON.stringify({
      type: 'function_call',
      call_id: 'call_1',
      name: 'default_api:read_file',
      arguments: '{"filePath":"/tmp/a"}',
    }),
    { tools, protocol: 'codex_responses' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].id, 'call_1')
})

test('managed xml recovers a tool call when a parameter close tag is malformed', () => {
  // GLM-5.2 实测输出：description 参数闭合标签损坏（混入其它格式的 </arg_value>），
  // 整个块未闭合。只要 command 参数完整，就应恢复工具调用而非泄漏整段 XML。
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter><|CHAT2API|parameter name="description"><![CDATA[Read a file</arg_value>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, 'default_api:read_file')
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).filePath, '/tmp/a')
})

test('managed xml does not fabricate a call from bare text that merely mentions an invoke tag', () => {
  // 宽容提取必须要求至少一个完整闭合的 parameter，避免把普通文本误判为工具调用。
  const result = managedXmlProtocol.parse(
    '请参考 <|CHAT2API|invoke name="default_api:read_file"> 的格式说明，但不要真的调用。',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 0)
})

test('managed xml fuzzy-corrects hallucinated tool names (case, underscore, substring)', () => {
  // 模型轻微幻觉工具名（大小写/下划线/前后缀），模糊匹配应纠正为注册名。
  const cases: Array<[string, string]> = [
    ['<|CHAT2API|tool_calls><|CHAT2API|invoke name="Default_api:Read_File"><|CHAT2API|parameter name="filePath">/tmp/a</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>', 'default_api:read_file'],
    ['<|CHAT2API|tool_calls><|CHAT2API|invoke name="defaultapireadfile"><|CHAT2API|parameter name="filePath">/tmp/a</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>', 'default_api:read_file'],
  ]
  for (const [xml, expected] of cases) {
    const result = managedXmlProtocol.parse(xml, { tools, protocol: 'managed_xml' })
    assert.equal(result.toolCalls.length, 1, `should recover from: ${xml}`)
    assert.equal(result.toolCalls[0].function.name, expected)
  }
})

test('managed xml still rejects tool names that cannot be matched', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="totally_unrelated_tool"><|CHAT2API|parameter name="x">1</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 0)
  assert.deepEqual(result.invalidToolNames, ['totally_unrelated_tool'])
})

test('managed bracket fuzzy-corrects tool name case', () => {
  const result = managedBracketProtocol.parse(
    '[function_calls][call:Default_api:Read_File]{"filePath":"/tmp/a"}[/call][/function_calls]',
    { tools, protocol: 'managed_bracket' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, 'default_api:read_file')
})
