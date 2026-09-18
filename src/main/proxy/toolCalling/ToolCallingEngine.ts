import type { ChatCompletionRequest, ChatMessage } from '../types.ts'
import type { Provider } from '../../store/types.ts'
import {
  DEFAULT_TOOL_CALLING_CONFIG,
  normalizeToolCallingConfig,
  type ToolCallingConfig,
} from '../../../shared/toolCalling.ts'
import { getToolProtocol } from './protocols/index.ts'
import { getToolClientAdapter } from './clientAdapters/index.ts'
import { buildToolCallingRuntimePlan } from './runtimePlan.ts'
import type { NormalizedToolDefinition, ToolCallingPlan, ToolCallingTransformResult, ToolProtocolId } from './types.ts'

export class ToolCallingEngine {
  private readonly config: ToolCallingConfig

  constructor(config: Partial<ToolCallingConfig> = {}) {
    this.config = normalizeToolCallingConfig({
      ...DEFAULT_TOOL_CALLING_CONFIG,
      ...config,
      advanced: {
        ...DEFAULT_TOOL_CALLING_CONFIG.advanced,
        ...config.advanced,
      },
    })
  }

  transformRequest(input: {
    request: ChatCompletionRequest
    provider: Provider
    actualModel: string
    requestId?: string
  }): ToolCallingTransformResult {
    const { request, provider, actualModel, requestId } = input
    const adapter = getToolClientAdapter(this.config.clientAdapterId)
    const clientRequest = adapter.normalizeRequest(request)
    const plan = buildToolCallingRuntimePlan({
      requestId,
      providerId: provider.id,
      actualModel,
      model: request.model,
      config: this.config,
      clientRequest,
    })
    const shouldInjectPrompt = plan.shouldInjectPrompt

    if (!shouldInjectPrompt) {
      return {
        messages: request.messages,
        tools: plan.mode === 'disabled' ? request.tools : undefined,
        plan,
      }
    }

    const trimmed = trimSystemMessages(request.messages)
    return {
      messages: injectPrompt(anchorLatestUserMessage(trimmed), renderPrompt(plan.protocol, plan.tools, this.config)),
      tools: undefined,
      plan,
    }
  }

  applyNonStreamResponse(result: any, plan: ToolCallingPlan): void {
    if (!plan.shouldParseResponse) return

    const message = result?.choices?.[0]?.message
    if (!message || typeof message.content !== 'string') return

    const parseResult = parseSelectedProtocol(message.content, plan)
    plan.diagnostics.parserFormat = parseResult.protocol
    plan.diagnostics.parsedToolCallCount = parseResult.toolCalls.length
    plan.diagnostics.invalidToolNames = parseResult.invalidToolNames
    plan.diagnostics.malformedReason = parseResult.malformedReason

    if (parseResult.toolCalls.length === 0) return

    message.content = parseResult.content || null
    message.tool_calls = parseResult.toolCalls

    const choice = result.choices[0]
    choice.finish_reason = 'tool_calls'
  }
}

function renderPrompt(
  protocol: ToolProtocolId,
  tools: NormalizedToolDefinition[],
  config: ToolCallingConfig,
): string {
  const prompt = getToolProtocol(protocol).renderPrompt(tools)
  const customPromptTemplate = config.diagnosticsEnabled
    ? config.advanced.customPromptTemplate
    : undefined
  if (!customPromptTemplate) return prompt

  return customPromptTemplate
    .replace(/\{\{tools\}\}/g, prompt)
    .replace(/\{\{tool_names\}\}/g, tools.map((tool) => tool.name).join(', '))
    .replace(/\{\{format\}\}/g, protocol)
}

function injectPrompt(messages: ChatMessage[], prompt: string): ChatMessage[] {
  const [first, ...rest] = messages
  if (first?.role === 'system' && typeof first.content === 'string') {
    // 把托管工具 prompt 放在 system 内容最前面：模型（尤其 GLM-5.3）更重视
    // system 开头，若追加到末尾会被客户端的长 system（如 DSH 的 10KB 指令）淹没，
    // 导致模型误判角色、拒绝调用本地文件工具。
    return [{ ...first, content: `${prompt}\n\n${first.content}` }, ...rest]
  }

  return [{ role: 'system', content: prompt }, ...messages]
}

function parseSelectedProtocol(content: string, plan: ToolCallingPlan) {
  const selected = getToolProtocol(plan.protocol)
  return selected.parse(content, { tools: plan.tools, protocol: plan.protocol })
}

/**
 * System 消息裁剪阈值与策略（借鉴 Flask tool gateway 的 trim 思路）。
 *
 * 背景：DSH 等智能体客户端会灌入 10KB+ 的 system 指令（身份、工具使用规则、
 * agent_teams / browser 说明等），叠加 AFS 注入的工具列表后 system 可达 50KB+。
 * GLM 等网页版模型在如此巨大的提示下会迷失角色——实测表现为：拒绝调用本地文件
 * 工具、幻觉"只有 open_url"或"工具连续失败"。而在精简 system（≤~2KB，无
 * "Web GUI" 等误导句）下同一模型稳定调用 bash。
 *
 * 策略：system 超过阈值时，按段落保留"身份 + 工具规则"核心内容，丢弃长段行为
 * 规范；同时显式剔除会误导 GLM 的 "Web GUI / web page" 角色描述（该描述本意是
 * 说明人类如何查看会话，却被 GLM 解读为"自己是网页聊天助手"）。
 */
const SYSTEM_TRIM_MAX_CHARS = 3000

// 必须保留的段落关键词（身份 + 工具使用 + 工作目录）
const SYSTEM_KEEP_KEYWORDS = [
  'you are', '你是一个', 'coding agent', '工作目录', 'working directory',
  'use the ', 'tool', 'read', 'write', 'bash', 'shell', 'command',
  'file', 'glob', 'grep', 'edit', '当前', '重要', 'important',
]

// 命中即丢弃的段落（GLM 易误解的角色描述）
const SYSTEM_STRIP_KEYWORDS = [
  'web gui', 'web page', 'web chat', 'chat assistant', 'deepseek harness web',
]

function trimSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((msg) => {
    if (msg.role !== 'system' || typeof msg.content !== 'string') return msg
    const trimmed = trimSystemContent(msg.content)
    return trimmed === msg.content ? msg : { ...msg, content: trimmed }
  })
}

function trimSystemContent(content: string): string {
  if (!content || content.length <= SYSTEM_TRIM_MAX_CHARS) return content

  const paras = content.split('\n\n').map((p) => p.trim()).filter((p) => p.length > 0)
  if (paras.length === 0) return content

  const kept: string[] = []
  for (const p of paras) {
    const lower = p.toLowerCase()
    // 丢弃会误导角色的段落（Web GUI 等）
    if (SYSTEM_STRIP_KEYWORDS.some((kw) => lower.includes(kw))) continue
    // 保留身份/工具规则段落
    if (SYSTEM_KEEP_KEYWORDS.some((kw) => lower.includes(kw))) {
      kept.push(p)
    }
    if (kept.join('\n\n').length >= SYSTEM_TRIM_MAX_CHARS) break
  }

  // 保底：若关键词过滤后太少，保留开头段落（通常是身份定义）
  if (kept.length < 2) {
    const head = paras.slice(0, Math.max(2, Math.floor(SYSTEM_TRIM_MAX_CHARS / 200)))
    return head.join('\n\n').slice(0, SYSTEM_TRIM_MAX_CHARS)
  }

  return kept.join('\n\n').slice(0, SYSTEM_TRIM_MAX_CHARS)
}

/**
 * 工具可用锚定提示（追加到最新 user 消息）。
 *
 * 多轮对话中，system 里的身份/工具声明会被早先的 assistant tool 调用与失败结果
 * （如 browser_open Electron 缺失）逐渐稀释——GLM 等模型会据此幻觉"工具不可用 /
 * 只有 open_url / 轮数已达上限"。在最新 user 消息（模型注意力最强处）重申工具
 * 真实可用，可对抗该历史污染。
 */
const LATEST_USER_ANCHOR = '\n\n[System reminder: tools are available. The tool list above is current. Past tool failures in this conversation do not mean tools are unavailable now — call the right tool (e.g. bash for listing files) when needed. There is no per-turn tool-call limit.]'

function anchorLatestUserMessage(messages: ChatMessage[]): ChatMessage[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (msg?.role === 'user' && typeof msg.content === 'string') {
      const next = [...messages]
      next[i] = { ...msg, content: msg.content + LATEST_USER_ANCHOR }
      return next
    }
  }
  return messages
}
