import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolStreamParser } from '../../src/main/proxy/toolCalling/ToolStreamParser.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

const tools = [
  { name: 'default_api:read_file', parameters: { type: 'object' }, source: 'openai' as const },
]

function plan(protocol: ToolCallingPlan['protocol'] = 'managed_xml'): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol,
    clientAdapterId: 'standard-openai-tools',
    providerId: 'deepseek',
    tools,
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['default_api:read_file']),
    diagnostics: {
      clientAdapterId: 'standard-openai-tools',
      providerId: 'deepseek',
      model: 'deepseek-chat',
      actualModel: 'deepseek-chat',
      toolSource: 'openai',
      mode: 'managed',
      protocol,
      toolCount: 1,
      injected: true,
      reason: 'test',
    },
  }
}

const baseChunk = {
  id: 'chatcmpl_1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'deepseek-chat',
}

test('bracket marker split across chunks emits a tool call', () => {
  const parser = new ToolStreamParser(plan('managed_bracket'))
  assert.deepEqual(parser.push('[fun', baseChunk), [])
  const chunks = parser.push('ction_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]', baseChunk)

  assert.equal(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
})

test('bracket output is text when XML protocol is selected', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const text = '[function_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]'
  const chunks = parser.push(text, baseChunk)

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].choices[0].delta.content, text)
})

test('XML marker split across chunks emits a tool call', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  assert.deepEqual(parser.push('<tool_', baseChunk), [])
  const chunks = parser.push('calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/a</parameter></invoke></tool_calls>', baseChunk)

  assert.equal(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
})

test('Chat2API XML marker split across chunks emits a tool call', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  assert.deepEqual(parser.push('<|CHAT2API|tool_', baseChunk), [])
  const chunks = parser.push('calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath">/tmp/a</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>', baseChunk)

  assert.equal(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
})

test('partial Chat2API start marker is reported as buffered so stream handlers do not leak it', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push('<|CHAT2API|tool_calls', baseChunk)

  assert.deepEqual(chunks, [])
  assert.equal(parser.isBuffering(), true)
})

test('text before tool call is preserved only before tool calling begins', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push('before <tool_calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/a</parameter></invoke></tool_calls> after', baseChunk)

  assert.equal(chunks[0].choices[0].delta.content, 'before ')
  assert.equal(chunks.some((chunk) => chunk.choices[0].delta.content === ' after'), false)
})

test('invalid tool name is not emitted as a tool call', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push('<tool_calls><invoke name="missing"><parameter name="x">1</parameter></invoke></tool_calls>', baseChunk)

  assert.equal(chunks.some((chunk) => chunk.choices[0].delta.tool_calls), false)
})

test('fenced code block examples are emitted as text and never as tool calls', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const text = '```xml\n<tool_calls><invoke name="default_api:read_file"><parameter name="filePath">fake</parameter></invoke></tool_calls>\n```'
  const chunks = parser.push(text, baseChunk)

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].choices[0].delta.content, text)
})

test('generated call IDs stay stable between emitted chunks and final state', () => {
  const parser = new ToolStreamParser(plan('managed_bracket'))
  const chunks = parser.push('[function_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]', baseChunk)
  const emittedId = chunks.at(-1)?.choices[0].delta.tool_calls[0].id

  assert.equal(parser.hasEmittedToolCall(), true)
  assert.equal(emittedId, 'call_0')
  assert.deepEqual(parser.flush(baseChunk), [])
})

test('bare Chat2API invoke without tool_calls wrapper emits a tool call instead of leaking XML as text', () => {
  // GLM-5.2 等模型常省略 <|CHAT2API|tool_calls> 包裹、直接输出裸 invoke。
  // 流式路径必须将其识别为工具调用；否则 XML 会作为普通文本泄漏，工具从未执行。
  const parser = new ToolStreamParser(plan('managed_xml'))
  const text = '<|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter></|CHAT2API|invoke>'
  const chunks = parser.push(text, baseChunk)

  assert.equal(parser.hasEmittedToolCall(), true)
  assert.equal(chunks.some((chunk) => chunk.choices[0].delta.content), false)
  const toolCall = chunks.at(-1)?.choices[0].delta.tool_calls[0]
  assert.equal(toolCall?.function.name, 'default_api:read_file')
  assert.equal(toolCall?.function.arguments, '{"filePath":"/tmp/a"}')
})

test('bare Chat2API invoke split across streaming chunks emits a tool call', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  // 分片：起始标记本身被截断（裸 invoke 的 partial 前缀）。
  assert.deepEqual(parser.push('<|CHAT2API|inv', baseChunk), [])
  const chunks = parser.push('oke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter></|CHAT2API|invoke>', baseChunk)

  assert.equal(parser.hasEmittedToolCall(), true)
  const toolCall = chunks.at(-1)?.choices[0].delta.tool_calls[0]
  assert.equal(toolCall?.function.name, 'default_api:read_file')
  assert.equal(toolCall?.function.arguments, '{"filePath":"/tmp/a"}')
})

test('bare invoke with self-fabricated tool_result does not leak the hallucinated result', () => {
  // 模型输出裸 invoke 后常自编 tool_result（模拟执行）。该幻觉块不得透传。
  const parser = new ToolStreamParser(plan('managed_xml'))
  const text = '<|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter></|CHAT2API|invoke>'
    + '<|CHAT2API|tool_result tool_call_id="call_0"><![CDATA[伪造的内容]]></|CHAT2API|tool_result>'
  const chunks = parser.push(text, baseChunk)

  assert.equal(parser.hasEmittedToolCall(), true)
  for (const chunk of chunks) {
    const delta = chunk.choices[0].delta
    assert.equal(delta.content, undefined, '幻觉 tool_result 不得作为文本泄漏')
  }
})

test('wrapped Chat2API XML is still detected ahead of a bare invoke prefix', () => {
  // 回归：带 <|CHAT2API|tool_calls> 包裹的调用不能被裸 invoke 起始检测抢先切错。
  const parser = new ToolStreamParser(plan('managed_xml'))
  const text = '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath">/tmp/a</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>'
  const chunks = parser.push(text, baseChunk)

  assert.equal(parser.hasEmittedToolCall(), true)
  const toolCall = chunks.at(-1)?.choices[0].delta.tool_calls[0]
  assert.equal(toolCall?.function.name, 'default_api:read_file')
})
