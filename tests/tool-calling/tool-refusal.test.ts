import test from 'node:test'
import assert from 'node:assert/strict'
import {
  detectPlanOnlyTurn,
  detectToolRefusal,
  isPlanOnlyRetryEnabled,
  isToolRefusalRetryEnabled,
} from '../../src/main/proxy/toolCalling/hallucinationGuard.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

const tools = [
  { name: 'web_fetch', parameters: { type: 'object' }, source: 'openai' as const },
  { name: 'read', parameters: { type: 'object' }, source: 'openai' as const },
]

function plan(overrides: Partial<ToolCallingPlan> = {}): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol: 'managed_bracket',
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    tools,
    ...overrides,
  } as ToolCallingPlan
}

function reply(content: string, toolCalls?: any[]) {
  return {
    choices: [{ index: 0, message: { role: 'assistant', content, tool_calls: toolCalls } }],
  }
}

test('refusal: kimi 的「我没有获取实时天气数据的工具」判为需要重试', () => {
  const verdict = detectToolRefusal(
    reply('我没有获取实时天气数据的工具。你可以通过搜索引擎查询"成都天气"。'),
    plan(),
    '成都今日天气如何',
  )

  assert.equal(verdict.retry, true)
  assert.equal(verdict.reason, 'tool_refusal')
  assert.ok(verdict.matched.length > 0)
})

test('refusal: 「无法直接访问…由于网络限制」同样重试', () => {
  const verdict = detectToolRefusal(
    reply('由于网络限制，我无法直接访问中国天气网，建议你打开手机天气 App 查看。'),
    plan(),
    '昆明今日天气如何',
  )

  assert.equal(verdict.retry, true)
})

test('refusal: 调用了工具（即使失败）不重试', () => {
  const verdict = detectToolRefusal(
    reply('抱歉，无法访问该站点。', [
      { id: 'call_0', type: 'function', function: { name: 'web_fetch', arguments: '{}' } },
    ]),
    plan(),
    '成都今日天气如何',
  )

  assert.equal(verdict.retry, false)
  assert.equal(verdict.reason, 'has_tool_calls')
})

test('refusal: 非实时问题里的「无法访问」不重试', () => {
  const verdict = detectToolRefusal(
    reply('我无法访问外部网络，也不掌握这个内部系统的实现细节。'),
    plan(),
    '帮我解释一下这段排序算法',
  )

  assert.equal(verdict.retry, false)
  assert.equal(verdict.reason, 'not_live_question')
})

test('refusal: 正常回答不重试', () => {
  const verdict = detectToolRefusal(
    reply('成都当前多云，气温约 14°C，今天体感偏凉。'),
    plan(),
    '成都今日天气如何',
  )

  assert.equal(verdict.retry, false)
  assert.equal(verdict.reason, 'clean')
})

test('refusal: 工具清单里没有能取信息的工具时不重试', () => {
  const verdict = detectToolRefusal(
    reply('我没有获取实时天气数据的工具。'),
    plan({ tools: [{ name: 'todo_write', parameters: { type: 'object' }, source: 'openai' as const }] } as any),
    '成都今日天气如何',
  )

  assert.equal(verdict.retry, false)
  assert.equal(verdict.reason, 'no_informative_tool')
})

test('refusal: 带命名空间前缀的工具名也能识别', () => {
  const verdict = detectToolRefusal(
    reply('我没有获取实时天气数据的工具。'),
    plan({
      tools: [{ name: 'default_api:web_fetch', parameters: { type: 'object' }, source: 'openai' as const }],
    } as any),
    '北京今日天气如何',
  )

  assert.equal(verdict.retry, true)
})

test('refusal: 非 managed 模式一律不重试', () => {
  const verdict = detectToolRefusal(reply('我没有获取实时天气数据的工具。'), plan({ mode: 'disabled' } as any), '今日天气')
  assert.equal(verdict.retry, false)
  assert.equal(verdict.reason, 'not_managed')
})

test('refusal: 英文话术同样命中', () => {
  const verdict = detectToolRefusal(
    reply("I don't have access to live weather data for this city."),
    plan(),
    'weather in Chengdu today',
  )

  assert.equal(verdict.retry, true)
})

test('refusal: 开关默认开启，可用环境变量关闭', () => {
  const previous = process.env.AFS_DISABLE_TOOL_REFUSAL_RETRY
  try {
    delete process.env.AFS_DISABLE_TOOL_REFUSAL_RETRY
    assert.equal(isToolRefusalRetryEnabled(), true)
    process.env.AFS_DISABLE_TOOL_REFUSAL_RETRY = '1'
    assert.equal(isToolRefusalRetryEnabled(), false)
  } finally {
    if (previous === undefined) delete process.env.AFS_DISABLE_TOOL_REFUSAL_RETRY
    else process.env.AFS_DISABLE_TOOL_REFUSAL_RETRY = previous
  }
})

// ── 只说不做（plan_only）──────────────────────────────────────────────────

test('plan-only: 说完「让我用 python-docx 创建，然后创建文件：」就停下判为只说不做', () => {
  const verdict = detectPlanOnlyTurn(
    reply(
      '由于 COM 访问被拒绝，无法通过 Word 自动化创建文件。让我尝试使用 Python 的 python-docx 库来创建这个 Word 文档。\n\n首先检查当前目录，然后尝试用 Python 创建文件：',
    ),
    plan(),
    '本工作区内新建一个word，名为晚秋',
  )

  assert.equal(verdict.retry, true)
  assert.equal(verdict.reason, 'plan_only')
})

test('plan-only: 真的调了工具就不算', () => {
  const verdict = detectPlanOnlyTurn(
    reply('让我创建这个文件。', [{ id: 'call_0', type: 'function', function: { name: 'pwsh', arguments: '{}' } }]),
    plan(),
    '新建一个 word 文件',
  )
  assert.equal(verdict.retry, false)
})

test('plan-only: 已经汇报完成的不算', () => {
  const verdict = detectPlanOnlyTurn(reply('已完成！Word 文档 晚秋.docx 已成功创建工作区。'), plan(), '新建一个 word 文件')
  assert.equal(verdict.retry, false)
  assert.equal(verdict.reason, 'claims_completed')
})

test('plan-only: 用户只是闲聊/提问时不重试', () => {
  const verdict = detectPlanOnlyTurn(reply('让我想想。'), plan(), '你觉得晚秋这个标题怎么样')
  assert.equal(verdict.retry, false)
  assert.equal(verdict.reason, 'not_task_request')
})

test('plan-only: 长回答（>400 字）不重试，避免误伤正常分析', () => {
  const long = '这是一个很长的分析。'.repeat(60) + '让我继续。'
  const verdict = detectPlanOnlyTurn(reply(long), plan(), '帮我写一份分析')
  assert.equal(verdict.retry, false)
  assert.equal(verdict.reason, 'too_long')
})

test('plan-only: 结尾是正常陈述而不是过渡句时不重试', () => {
  const verdict = detectPlanOnlyTurn(reply('这个文件不能用 python-docx 生成，因为环境缺少 lxml。'), plan(), '新建一个 word')
  assert.equal(verdict.retry, false)
  assert.equal(verdict.reason, 'clean')
})

test('plan-only: 开关默认开启', () => {
  const previous = process.env.AFS_DISABLE_PLAN_ONLY_RETRY
  try {
    delete process.env.AFS_DISABLE_PLAN_ONLY_RETRY
    assert.equal(isPlanOnlyRetryEnabled(), true)
  } finally {
    if (previous !== undefined) process.env.AFS_DISABLE_PLAN_ONLY_RETRY = previous
  }
})

// ── 纠偏提示（v1.7.3 补丁）────────────────────────────────────────────────

test('nudge: plan-only 提示带上 bracket 调用块示例', async () => {
  const { planOnlyNudge } = await import('../../src/main/proxy/toolCalling/hallucinationGuard.ts')
  const text = planOnlyNudge('managed_bracket')
  assert.ok(text.includes('[function_calls]'))
  assert.ok(text.includes('[call:工具名]'))
  assert.ok(text.includes('不要复述计划'))
})

test('nudge: plan-only 在 xml 协议下换成 xml 示例', async () => {
  const { planOnlyNudge } = await import('../../src/main/proxy/toolCalling/hallucinationGuard.ts')
  const text = planOnlyNudge('managed_xml')
  assert.ok(text.includes('<tool_call>'))
  assert.ok(!text.includes('[function_calls]'))
})

test('nudge: 工具否决提示点名它其实有联网能力', async () => {
  const { toolRefusalNudge } = await import('../../src/main/proxy/toolCalling/hallucinationGuard.ts')
  const text = toolRefusalNudge('managed_bracket')
  assert.ok(text.includes('web_fetch'))
  assert.ok(text.includes('没有「联网」开关'))
  assert.ok(text.includes('wttr.in'))
})

test('nudge: 沙箱提示点名 /mnt 路径不许出现', async () => {
  const { sandboxNudge } = await import('../../src/main/proxy/toolCalling/hallucinationGuard.ts')
  const text = sandboxNudge('managed_bracket')
  assert.ok(text.includes('/mnt/data'))
  assert.ok(text.includes('不要输出 /mnt'))
})

// ── Kimi「没开联网」话术（v1.7.3 补丁 2）──────────────────────────────────

test('refusal: Kimi 说「网络搜索功能已被禁用，点击联网按钮」判为需要重试', () => {
  const verdict = detectToolRefusal(
    reply('我需要联网查询今日北京天气。当前网络搜索功能已被禁用，您可以在输入框中点击"联网"按钮重新启用后，我就能为您查询了。'),
    plan(),
    '今日北京天气如何',
  )

  assert.equal(verdict.retry, true)
  assert.equal(verdict.reason, 'tool_refusal')
  assert.ok(verdict.matched.includes('search_disabled'))
  assert.ok(verdict.matched.includes('enable_online_button'))
})

test('refusal: Kimi 说「web_fetch 需要您提供具体 URL，我无法主动搜索」也要重试', () => {
  const verdict = detectToolRefusal(
    reply('我无法查询天气信息，因为当前可用的工具（如 `web_fetch`）需要您提供具体的 URL，而我无法主动搜索网络来获取天气数据。'),
    plan(),
    '今日北京天气如何',
  )

  assert.equal(verdict.retry, true)
  assert.equal(verdict.reason, 'tool_refusal')
})

test('refusal: 全角引号与「开启联网功能」变体同样命中', () => {
  const verdict = detectToolRefusal(
    reply('联网搜索功能已经关闭，请先在输入框开启联网功能后再试。'),
    plan(),
    '今天上海天气',
  )
  assert.equal(verdict.retry, true)
})

test('refusal: 正常给出结论（没有拒绝话术）不重试', () => {
  const verdict = detectToolRefusal(
    reply('北京今天晴，气温 5℃，西北风 6km/h，湿度 58%。'),
    plan(),
    '今日北京天气如何',
  )
  assert.equal(verdict.retry, false)
  assert.equal(verdict.reason, 'clean')
})

test('refusal: 非实时问题里的「无法搜索」不触发重试', () => {
  const verdict = detectToolRefusal(
    reply('这个仓库里没有搜索功能，所以我无法搜索历史记录。'),
    plan(),
    '这个项目支持哪些搜索方式',
  )
  assert.equal(verdict.retry, false)
  assert.equal(verdict.reason, 'not_live_question')
})

test('refusal: 本轮没有能取信息的工具时不重试（省 token）', () => {
  const verdict = detectToolRefusal(
    reply('网络搜索功能已被禁用，请点击联网按钮。'),
    plan({ tools: [{ name: 'present_files', parameters: { type: 'object' }, source: 'openai' }] } as any),
    '今日北京天气如何',
  )
  assert.equal(verdict.retry, false)
  assert.equal(verdict.reason, 'no_informative_tool')
})
