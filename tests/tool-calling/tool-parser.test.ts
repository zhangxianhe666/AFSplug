import test from 'node:test'
import assert from 'node:assert/strict'
import { managedBracketProtocol } from '../../src/main/proxy/toolCalling/protocols/managedBracket.ts'
import { managedXmlProtocol } from '../../src/main/proxy/toolCalling/protocols/managedXml.ts'
import { anthropicToolUseProtocol } from '../../src/main/proxy/toolCalling/protocols/anthropicToolUse.ts'
import { codexResponsesProtocol } from '../../src/main/proxy/toolCalling/protocols/codexResponses.ts'
import { isToolResultFailure } from '../../src/main/proxy/toolCalling/protocols/shared.ts'

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

// —— 回归：GLM-5.3 实况输出的参数格式退化 ——
// 实测（2026-11-04）GLM-5.3 在长上下文下会把参数写成裸标签 `<command>x</command>`，
// 或把参数名写成占位符 `argument1`。旧解析只认 `<parameter name="X">`，参数整批丢失，
// 再被必填补齐成空串 → 工具以空参数执行，表现为「技能/命令调不起来」。

const bashTools = [
  {
    name: 'Bash',
    description: 'Run a shell command',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
    source: 'openai' as const,
  },
]

test('managed xml recovers bare-tag parameters inside a wrapped tool_calls block', () => {
  const result = managedXmlProtocol.parse(
    '<tool_calls><invoke name="Bash"><command>ls /tmp | head -3</command></invoke></tool_calls>',
    { tools: bashTools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), {
    command: 'ls /tmp | head -3',
  })
})

test('managed xml maps placeholder parameter names onto the single required parameter', () => {
  const result = managedXmlProtocol.parse(
    '<tool_calls><invoke name="Bash"><parameter name="argument1">pwd</parameter></invoke></tool_calls>',
    { tools: bashTools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { command: 'pwd' })
})

test('managed xml recovers bare-tag parameters from an unwrapped bare invoke', () => {
  const result = managedXmlProtocol.parse(
    '<invoke name="Bash"><command>whoami</command></invoke>',
    { tools: bashTools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, 'Bash')
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { command: 'whoami' })
})

test('managed xml parses an unwrapped plain invoke even when several tools share the parameter name', () => {
  // 回归：Skill / Bash 都用 `command` 参数。旧实现只认 <|CHAT2API|invoke> 形式的裸块，
  // 纯 XML 的 <invoke name="Bash"> 会落到 schema 宽容提取，因「候选多于 1 个」被整体放弃。
  const tools = [
    { name: 'Skill', description: 'load skill', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }, source: 'openai' as const },
    { name: 'Bash', description: 'run shell', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }, source: 'openai' as const },
  ]

  const result = managedXmlProtocol.parse('<invoke name="Bash"><command>ls /tmp</command></invoke>', {
    tools,
    protocol: 'managed_xml',
  })

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, 'Bash')
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { command: 'ls /tmp' })
})

test('managed xml does not double-parse an invoke wrapped in tool_calls', () => {
  const result = managedXmlProtocol.parse(
    '<tool_calls><invoke name="Bash"><parameter name="command">pwd</parameter></invoke></tool_calls>',
    { tools: bashTools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { command: 'pwd' })
})

// ── 工具失败结果标注 ───────────────────────────────────────────────
// 真实回归：GLM 拿到 `Exit Code: 1 / ModuleNotFoundError` 的工具结果后仍回复
// 「PPT 已生成完毕 ✅」并给出不存在的路径，用户按路径找不到文件。

test('tool result with non-zero exit code is marked as failure', () => {
  const result = managedXmlProtocol.formatToolResult({
    toolCallId: 'call_1',
    content: 'Command: python3 build.py\nStdout: Traceback (most recent call last):\n  File "build.py", line 1\nModuleNotFoundError: No module named \'pptx\'\n\nExit Code: 1',
  })

  assert.match(result, /\[TOOL_ERROR\]/)
  assert.match(result, /did NOT succeed/)
})

test('tool result reporting a missing file is marked as failure', () => {
  const content = 'Command: ls -la "AI发展.pptx"\nStdout: ls: AI发展.pptx: No such file or directory\nExit Code: 1'
  const result = managedXmlProtocol.formatToolResult({ toolCallId: 'call_2', content })

  assert.match(result, /\[TOOL_ERROR\]/)
})

test('tool result killed by signal (timeout 137) is marked as failure', () => {
  const content = 'Command: python3 build.py\nStdout: (empty)\nStderr: (empty)\nExit Code: 137\nSignal: SIGTERM'
  const result = managedXmlProtocol.formatToolResult({ toolCallId: 'call_3', content })

  assert.match(result, /\[TOOL_ERROR\]/)
})

test('successful tool result is not marked as failure', () => {
  const content = 'Command: ls -la "AI发展.pptx"\nStdout: -rw-r--r--  1 user staff 7262 Nov  5 12:05 AI发展.pptx\nExit Code: 0'
  const result = managedXmlProtocol.formatToolResult({ toolCallId: 'call_4', content })

  assert.ok(!result.includes('[TOOL_ERROR]'))
})

test('ordinary text mentioning "error" is not treated as a failure', () => {
  const content = 'Command: grep -rn "error" logs/\nStdout: src/a.ts:12: // error handling\nExit Code: 0'
  const result = managedBracketProtocol.formatToolResult({ toolCallId: 'call_5', content })

  assert.ok(!result.includes('[TOOL_ERROR]'))
})

test('protocol prompt forbids claiming success without verification', () => {
  for (const protocol of [managedXmlProtocol, managedBracketProtocol]) {
    const prompt = protocol.renderPrompt(tools)
    assert.match(prompt, /\[TOOL_ERROR\]/)
    assert.match(prompt, /present_files/)
  }
})

// ── 全角引号容错 ─────────────────────────────────────────────────
// 真实回归（11-05 12:17）：GLM 输出 `<invoke name=“Bash”>`（中文全角引号），
// 严格正则匹配失败，整段 XML 当普通文本透传，界面表现为「模型没有调用工具」。

test('managed xml parses tool call written with full-width quotes', () => {
  const result = managedXmlProtocol.parse(
    '<tool_calls><invoke name=“Bash”><parameter name=“command”>ls /tmp</parameter></invoke></tool_calls>',
    { tools: bashTools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, 'Bash')
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { command: 'ls /tmp' })
  // 工具块不应作为正文残留
  assert.equal(result.content, '')
})

test('managed xml parses bare invoke written with full-width quotes', () => {
  const result = managedXmlProtocol.parse('<invoke name=“Bash”><command>pwd</command></invoke>', {
    tools: bashTools,
    protocol: 'managed_xml',
  })

  assert.equal(result.toolCalls.length, 1)
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { command: 'pwd' })
})

test('plain prose with Chinese quotes is left untouched', () => {
  const text = '第 1 页标题是“AI 短剧制作”，副标题“从创意到成片”。'
  const result = managedXmlProtocol.parse(text, { tools: bashTools, protocol: 'managed_xml' })

  assert.equal(result.toolCalls.length, 0)
  assert.equal(result.content, text)
})

test('hallucinated tool_result block is stripped from reply content', () => {
  const result = managedXmlProtocol.parse(
    '校验脚本缺 schema 文件，继续渲染。\n\nUser: <tool_result tool_call_id="call_0">Command: soffice.py\nStdout: Generated 2 PDF page(s)</tool_result>\n\n收尾：文件已生成。',
    { tools: bashTools, protocol: 'managed_xml' },
  )

  assert.ok(!result.content.includes('<tool_result'))
  assert.ok(!result.content.includes('Generated 2 PDF page(s)'))
  assert.match(result.content, /校验脚本缺 schema 文件/)
  assert.match(result.content, /文件已生成/)
})

// ── Windows 失败文案 ───────────────────────────────────────────────
// 背景：TOOL_FAILURE_PATTERNS 原先只覆盖 POSIX 文案（No such file or directory /
// command not found / Permission denied），Windows 的 cmd 与 PowerShell 输出完全
// 不同，导致同一套「假成功」防护在 Windows 上失效。这里逐条锁住各变体。

test('windows cmd: Chinese "不是内部或外部命令" is a failure', () => {
  assert.ok(isToolResultFailure('"python" 不是内部或外部命令，也不是可运行的程序或批处理文件。'))
})

test('windows cmd: English "is not recognized as an internal or external command" is a failure', () => {
  assert.ok(
    isToolResultFailure(
      "'python' is not recognized as an internal or external command,\noperable program or batch file.",
    ),
  )
})

test('windows powershell: English cmdlet error is a failure', () => {
  assert.ok(
    isToolResultFailure(
      "python : The term 'python' is not recognized as the name of a cmdlet, function, script file, or operable program.",
    ),
  )
})

test('windows powershell: Chinese "识别为 cmdlet" is a failure', () => {
  assert.ok(isToolResultFailure('无法将“python”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。'))
})

test('windows: "The system cannot find the file specified" is a failure', () => {
  assert.ok(isToolResultFailure('ERROR: The system cannot find the file specified.'))
  assert.ok(isToolResultFailure('系统找不到指定的文件。'))
})

test('windows: missing path is a failure', () => {
  assert.ok(isToolResultFailure('The system cannot find the path specified.'))
  assert.ok(isToolResultFailure('系统找不到指定的路径。'))
})

test('windows: access denied is a failure', () => {
  assert.ok(isToolResultFailure('Access is denied.'))
  assert.ok(isToolResultFailure('拒绝访问。'))
})

test('windows success output is not treated as failure', () => {
  const dirListing = [
    '    Directory: C:\\Users\\me\\project',
    '',
    'Mode                 LastWriteTime         Length Name',
    '----                 -------------         ------ ----',
    '-a---          2026/11/8    13:50           7262 报告.pptx',
  ].join('\n')
  assert.ok(!isToolResultFailure(dirListing))
})

test('windows failure result is decorated with the failure banner', () => {
  const content = [
    'Command: python build.py',
    'Stdout: (empty)',
    "Stderr: 'python' is not recognized as an internal or external command,",
    'Exit Code: 9009',
  ].join('\n')

  const result = managedXmlProtocol.formatToolResult({ toolCallId: 'call_win', content })
  assert.match(result, /\[TOOL_ERROR\]/)
  assert.match(result, /\[TOOL_ERROR\][\s\S]*not recognized as an internal or external command/)
})

// ── 属性式 invoke ───────────────────────────────────────────────────────────
// 输入全部取 11-11 19:5x 现场 GLM-5.3 的逐字输出：模型把参数写成 XML 属性，
// 严格 pattern 于是一块都认不出，parsed=0，整段 XML 当正文透传给 DSH。

const globTools = [
  {
    name: 'glob',
    description: 'Find files whose paths match a glob pattern.',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string' } },
      required: ['pattern'],
    },
    source: 'openai' as const,
  },
]

test('managed xml recovers attribute-style invoke (live GLM output)', () => {
  const result = managedXmlProtocol.parse(
    '<tool_calls><invoke name="glob" pattern="**/*.xls*" path="C:\\Users\\37806\\Desktop\\文件"></invoke></tool_calls>',
    { tools: globTools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, 'glob')
  const args = JSON.parse(result.toolCalls[0].function.arguments)
  assert.equal(args.pattern, '**/*.xls*')
  assert.equal(args.path, 'C:\\Users\\37806\\Desktop\\文件')
  assert.equal(result.content, '')
})

test('managed xml recovers self-closing attribute invoke', () => {
  const result = managedXmlProtocol.parse(
    '<tool_calls><invoke name="glob" pattern="**/*.xlsx" /></tool_calls>',
    { tools: globTools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).pattern, '**/*.xlsx')
})

test('managed xml recovers mixed parameter attribute (live GLM output)', () => {
  const result = managedXmlProtocol.parse(
    '<tool_calls><invoke name="glob" parameter="pattern">**/*.xls*</parameter><parameter name="path">C:\\Users\\37806\\Desktop\\文件</parameter></invoke></tool_calls>',
    { tools: globTools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  const args = JSON.parse(result.toolCalls[0].function.arguments)
  assert.equal(args.pattern, '**/*.xls*')
  assert.equal(args.path, 'C:\\Users\\37806\\Desktop\\文件')
})

test('attribute invoke keeps surrounding prose in content', () => {
  const result = managedXmlProtocol.parse(
    "I'll look for spreadsheet files in the workspace.\n\n<tool_calls><invoke name=\"glob\" pattern=\"**/*.xlsx\"></invoke></tool_calls>",
    { tools: globTools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.match(result.content, /look for spreadsheet files/)
  assert.ok(!result.content.includes('<invoke'))
})

test('attribute value containing > is not cut at the tag boundary', () => {
  const result = managedXmlProtocol.parse(
    '<tool_calls><invoke name="glob" pattern="**/*.xlsx" path="C:\\a > b"></invoke></tool_calls>',
    { tools: globTools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).path, 'C:\\a > b')
})
