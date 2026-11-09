import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SANDBOX_STRONG_MARKERS,
  SANDBOX_WEAK_MARKERS,
  detectSandboxHallucination,
  extractAssistantText,
  isSandboxRetryEnabled,
  lastUserText,
} from '../../src/main/proxy/toolCalling/hallucinationGuard.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

function makePlan(overrides: Partial<ToolCallingPlan> = {}): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol: 'managed_xml',
    clientAdapterId: 'openai',
    providerId: 'glm',
    tools: [{ name: 'pwsh', description: 'shell', parameters: {}, source: 'openai' }],
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['pwsh']),
    diagnostics: {
      clientAdapterId: 'openai',
      providerId: 'glm',
      toolSource: 'openai',
      mode: 'managed',
      protocol: 'managed_xml',
      toolCount: 1,
      injected: true,
      reason: 'ok',
    },
    ...overrides,
  } as ToolCallingPlan
}

function makeResult(content: string | null, toolCalls?: any[]): any {
  return {
    choices: [
      {
        index: 0,
        finish_reason: toolCalls ? 'tool_calls' : 'stop',
        message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
      },
    ],
  }
}

const sandboxAnswer = makeResult(
  '你好！根据我的检查，当前工作区文件情况如下：\n' +
    '## 工作区文件列表（/mnt/data 目录）\n' +
    '| kernel-ipc-1 ~ kernel-ipc-5 | 文件 |\n| .ipython/ | 目录 |',
)

test('GLM 沙箱目录回答命中强特征并触发重试', () => {
  const v = detectSandboxHallucination(sandboxAnswer, makePlan(), '本工作区有哪些文件')
  assert.equal(v.retry, true)
  assert.equal(v.reason, 'sandbox_marker')
  assert.ok(v.matched.includes('/mnt/data'))
})

test('Kimi 沙箱目录回答同样命中', () => {
  const result = makeResult('当前工作目录是 /mnt/agents，包含 .agent-gw.json、.websites-templates/')
  const v = detectSandboxHallucination(result, makePlan({ providerId: 'kimi' }), '本工作区有哪些文件')
  assert.equal(v.retry, true)
  assert.ok(v.matched.includes('/mnt/agents'))
})

test('声称只有 open_url 也属于作废对象', () => {
  const result = makeResult('open_url is the only real tool available in this environment, and it failed.')
  const v = detectSandboxHallucination(result, makePlan(), '本工作区有哪些文件')
  assert.equal(v.retry, true)
  assert.ok(v.matched.some((m) => m.includes('open_url')))
})

test('正常工具调用不触发重试', () => {
  const result = makeResult(null, [
    { id: 'call_1', type: 'function', function: { name: 'pwsh', arguments: '{"command":"ls"}' } },
  ])
  const v = detectSandboxHallucination(result, makePlan(), '本工作区有哪些文件')
  assert.equal(v.retry, false)
  assert.equal(v.reason, 'has_tool_calls')
})

test('普通闲聊回答不触发重试', () => {
  const result = makeResult('你好，今天想聊点什么？')
  const v = detectSandboxHallucination(result, makePlan(), '你好')
  assert.equal(v.retry, false)
})

test('单个弱特征不触发重试', () => {
  const result = makeResult('这段代码在 sandbox 里跑过没问题。')
  const v = detectSandboxHallucination(result, makePlan(), '本工作区有哪些文件')
  assert.equal(v.retry, false)
})

test('两个弱特征但用户没问文件时不重试', () => {
  const result = makeResult('代码沙箱（code sandbox）是一种隔离执行环境。')
  const v = detectSandboxHallucination(result, makePlan(), '解释一下隔离执行')
  assert.equal(v.retry, false)
})

test('两个弱特征且用户在问文件时重试', () => {
  const result = makeResult('当前环境只有一个代码沙箱，工具不可用。')
  const v = detectSandboxHallucination(result, makePlan(), '本工作区有哪些文件')
  assert.equal(v.retry, true)
  assert.equal(v.reason, 'sandbox_weak')
})

test('非 managed 模式不参与判定', () => {
  const v = detectSandboxHallucination(sandboxAnswer, makePlan({ mode: 'disabled' }), '本工作区有哪些文件')
  assert.equal(v.retry, false)
  assert.equal(v.reason, 'not_managed')
})

test('没有注入工具时不参与判定', () => {
  const v = detectSandboxHallucination(sandboxAnswer, makePlan({ tools: [] }), '本工作区有哪些文件')
  assert.equal(v.retry, false)
  assert.equal(v.reason, 'no_tools')
})

test('空正文不触发重试', () => {
  const v = detectSandboxHallucination(makeResult(''), makePlan(), '本工作区有哪些文件')
  assert.equal(v.retry, false)
  assert.equal(v.reason, 'empty_text')
})

test('parts 数组正文能被提取并判定', () => {
  const result: any = {
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: [{ type: 'text', text: '目录 /mnt/data 下有 kernel-ipc-1' }] },
      },
    ],
  }
  assert.ok(extractAssistantText(result).includes('/mnt/data'))
  assert.equal(detectSandboxHallucination(result, makePlan(), '文件').retry, true)
})

test('lastUserText 取最后一条 user 消息', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '早' },
    { role: 'assistant', content: '早' },
    { role: 'user', content: '本工作区有哪些文件' },
  ]
  assert.equal(lastUserText(messages), '本工作区有哪些文件')
  assert.equal(lastUserText(undefined), '')
})

test('标记表保持去重且非空', () => {
  assert.equal(new Set(SANDBOX_STRONG_MARKERS).size, SANDBOX_STRONG_MARKERS.length)
  assert.equal(new Set(SANDBOX_WEAK_MARKERS).size, SANDBOX_WEAK_MARKERS.length)
  assert.ok(SANDBOX_STRONG_MARKERS.length > 0)
})

test('环境变量可关闭兜底', () => {
  const previous = process.env.AFS_DISABLE_SANDBOX_RETRY
  process.env.AFS_DISABLE_SANDBOX_RETRY = '1'
  assert.equal(isSandboxRetryEnabled(), false)
  delete process.env.AFS_DISABLE_SANDBOX_RETRY
  assert.equal(isSandboxRetryEnabled(), true)
  if (previous !== undefined) process.env.AFS_DISABLE_SANDBOX_RETRY = previous
})
