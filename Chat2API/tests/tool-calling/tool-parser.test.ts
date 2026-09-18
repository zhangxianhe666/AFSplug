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

// ── 参数归一化：复现 2026-09-10 GLM-5.3 连续三次被客户端挡下的真实故障 ──
// 会话记录：web_search 的 queries 被写成字符串 "[...]" → "queries" must be an array；
// 参数标签没被识别时 args 为空 → missing required property "queries"。
const webSearchTools = [
  {
    name: 'web_search',
    description: 'Search the web',
    parameters: {
      type: 'object',
      properties: { queries: { type: 'array', items: { type: 'string' } } },
      required: ['queries'],
    },
    source: 'openai' as const,
  },
  {
    name: 'read',
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' }, offset: { type: 'number' } },
      required: ['file_path'],
    },
    source: 'openai' as const,
  },
]

test('managed xml turns a JSON-string array into a real array (queries)', () => {
  const result = managedXmlProtocol.parse(
    '<tool_calls><invoke name="web_search"><parameter name="queries">["A股今日行情","深证成指"]</parameter></invoke></tool_calls>',
    { tools: webSearchTools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), {
    queries: ['A股今日行情', '深证成指'],
  })
})

test('managed xml wraps a bare string query into an array', () => {
  const result = managedXmlProtocol.parse(
    '<tool_calls><invoke name="web_search"><parameter name="queries">A股今日行情</parameter></invoke></tool_calls>',
    { tools: webSearchTools, protocol: 'managed_xml' },
  )

  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), {
    queries: ['A股今日行情'],
  })
})

test('managed xml backfills the declared array field from a singular alias', () => {
  const result = managedXmlProtocol.parse(
    '<tool_calls><invoke name="web_search"><parameter name="query">A股行情</parameter></invoke></tool_calls>',
    { tools: webSearchTools, protocol: 'managed_xml' },
  )

  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), {
    queries: ['A股行情'],
  })
})

test('managed xml coerces declared numbers and drops undeclared arguments', () => {
  const result = managedXmlProtocol.parse(
    '<tool_calls><invoke name="read"><parameter name="file_path">/tmp/a</parameter><parameter name="offset">5</parameter><parameter name="bogus">x</parameter></invoke></tool_calls>',
    { tools: webSearchTools, protocol: 'managed_xml' },
  )

  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), {
    file_path: '/tmp/a',
    offset: 5,
  })
})

test('managed xml leaves arguments untouched when the tool declares no properties', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath">/tmp/a</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { filePath: '/tmp/a' })
})

test('managed bracket normalizes arguments too', () => {
  const result = managedBracketProtocol.parse(
    '[function_calls][call:web_search]{"queries":"A股行情"}[/call][/function_calls]',
    { tools: webSearchTools, protocol: 'managed_bracket' },
  )

  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), {
    queries: ['A股行情'],
  })
})

// ── schema 驱动的宽容恢复：模型把参数名/工具名直接当标签写 ──
test('managed xml recovers a call the model wrote with bare parameter tags', () => {
  // GLM-5.3 实测原文：工具名和参数名都被当成标签，中间还夹着解释性文字。
  // 修复前严格正则与 tryExtractPartialToolCalls 都认不出，整块被当普通文本泄漏。
  const result = managedXmlProtocol.parse(
    '<tool_call>web_search调用失败，我重新查询一下今日A股行情。' +
      '<tool_call>web_search><queries>["A股今日行情 上证指数 深证成指 创业板指","今日A股市场 收盘 成交量 涨跌家数"]</queries></web_search>',
    { tools: webSearchTools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, 'web_search')
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), {
    queries: ['A股今日行情 上证指数 深证成指 创业板指', '今日A股市场 收盘 成交量 涨跌家数'],
  })
  // 恢复成功后原始 XML 必须从 content 剥离，不能再泄漏给客户端
  assert.doesNotMatch(result.content, /<tool_call>/)
  assert.doesNotMatch(result.content, /<queries>/)
})

test('managed xml does not recover when the tool name is ambiguous', () => {
  // 两个工具都声明了 query，且正文没有显式工具名 → 放弃，避免误判
  const ambiguous = [
    {
      name: 'video_search',
      description: 'Search videos',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      source: 'openai' as const,
    },
    {
      name: 'image_search',
      description: 'Search images',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      source: 'openai' as const,
    },
  ]
  const result = managedXmlProtocol.parse(
    '<tool_call>我帮你查一下<query>大熊猫</query>',
    { tools: ambiguous, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 0)
})

test('managed xml does not recover from prose that merely mentions a parameter name', () => {
  const result = managedXmlProtocol.parse(
    '关于 queries 这个参数，我的理解是要传一个数组，但这次我不调用工具。',
    { tools: webSearchTools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 0)
})
