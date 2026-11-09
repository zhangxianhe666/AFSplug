import type { ChatCompletionRequest, ChatMessage } from '../types.ts'
import type { Provider } from '../../store/types.ts'
import {
  DEFAULT_TOOL_CALLING_CONFIG,
  normalizeToolCallingConfig,
  type ToolCallingConfig,
} from '../../../shared/toolCalling.ts'
import { getToolProtocol } from './protocols/index.ts'
import { getToolClientAdapter } from './clientAdapters/index.ts'
import { defuseSystemUrls, rewriteUserUrls } from './linkPolicy.ts'
import { detectAuthFailedTools, partitionDisabledTools, resolveToolPolicy } from './toolPolicy.ts'
import { buildToolCallingRuntimePlan } from './runtimePlan.ts'
import type { NormalizedClientToolRequest } from './clientAdapters/types.ts'
import type { NormalizedToolDefinition, ToolCallingPlan, ToolCallingTransformResult, ToolProtocolId } from './types.ts'

export class ToolCallingEngine {
  private readonly config: ToolCallingConfig
  /** 诊断日志出口（由调用方注入，避免本模块静态依赖 store/electron）。 */
  private readonly log: (message: string) => void

  constructor(config: Partial<ToolCallingConfig> = {}, log?: (message: string) => void) {
    this.config = normalizeToolCallingConfig({
      ...DEFAULT_TOOL_CALLING_CONFIG,
      ...config,
      advanced: {
        ...DEFAULT_TOOL_CALLING_CONFIG.advanced,
        ...config.advanced,
      },
    })
    this.log = log ?? ((message: string) => console.log(message))
  }

  transformRequest(input: {
    request: ChatCompletionRequest
    provider: Provider
    actualModel: string
    requestId?: string
  }): ToolCallingTransformResult {
    const { request, provider, actualModel, requestId } = input
    const adapter = getToolClientAdapter(this.config.clientAdapterId)
    const clientRequest = this.applyToolPolicy(adapter.normalizeRequest(request), request.messages)
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
      // 不注入时打印一行诊断：客户端到底有没有带 tools、被什么规则挡掉的。
      // 缺这条日志时「模型抱怨工具不可用」只能靠猜（是有工具没注入，还是压根没工具）。
      this.log(
        `[ToolCalling] provider=${provider.id} model=${actualModel} tools=${clientRequest.tools.length} ` +
          `mode=${plan.mode} injected=false reason=${plan.diagnostics.reason}`,
      )
      return {
        messages: request.messages,
        tools: plan.mode === 'disabled' ? request.tools : undefined,
        plan,
      }
    }

    const prompt = renderPrompt(plan.protocol, plan.tools, this.config)
    // 预算分配：注入的工具清单优先（模型只能从这里知道有哪些工具），剩下的才给
    // 客户端指令。工具清单 41KB 时旧实现把客户端 system 砍到 3KB，等于用「工具
    // 说明书」挤掉了「技能使用说明」——@skill:pptx 这类任务因此无从下手。
    const clientBudget = Math.max(
      3000,
      Math.min(SYSTEM_TRIM_MAX_CHARS, SYSTEM_TOTAL_BUDGET - prompt.length),
    )
    const trimmed = trimSystemMessages(request.messages, clientBudget)
    // 摘掉 system 里的裸链接：GLM 见到 URL 会切到"只有 open_url"的网页助手人格
    // （见 URL_DEFUSE_PROVIDERS 注释的对照实验）。
    const defused = defuseSystemUrls(trimmed, provider.id, (message) => this.log(message))
    // user 侧链接剥掉 scheme（见 linkPolicy.ts 的对照实验）。指引里点名 WebFetch 的
    // 前提是这一轮确实有该工具，否则会指向不存在的工具名——所以工具名要做归一化
    // 匹配：dsh 叫 web_fetch、Claude 叫 WebFetch、还有客户端叫 fetch_url。
    const hasWebFetch = plan.tools.some((tool) => FETCH_TOOL_NAME_PATTERN.test(toolBaseName(tool.name)))
    const withUserLinks = rewriteUserUrls(defused, provider.id, hasWebFetch, (message) => this.log(message))
    const messages = injectPrompt(anchorLatestUserMessage(withUserLinks), prompt)

    const systemChars = messages
      .filter((m) => m.role === 'system')
      .reduce((acc, m) => acc + (typeof m.content === 'string' ? m.content.length : 0), 0)
    this.log(
      `[ToolCalling] provider=${provider.id} model=${actualModel} tools=${plan.tools.length} ` +
        `mode=${plan.mode} protocol=${plan.protocol} promptChars=${prompt.length} ` +
        `clientBudget=${clientBudget} systemChars=${systemChars}`,
    )

    return {
      messages,
      tools: undefined,
      plan,
    }
  }

  /**
   * 把「注定失败的工具」从注入清单里摘掉（策略见 toolPolicy.ts 顶部注释）。
   *
   * 只改注入给模型的清单，客户端自己的 tools 数组原样保留——执行器还在客户端那边，
   * 我们无权也无需改动。摘掉 web_search 之后，模型手里剩 web_fetch（纯 HTTP，不依赖
   * 任何 key），「今日重庆天气」这类实时问题能自己走通。
   */
  private applyToolPolicy(
    clientRequest: NormalizedClientToolRequest,
    messages: ChatMessage[],
  ): NormalizedClientToolRequest {
    if (clientRequest.tools.length === 0) return clientRequest
    // 客户端点名要某个工具时不干预：过滤掉会直接触发 "Forced tool is not declared"，
    // 把客户端的显式意图变成网关报错，比不屏蔽更糟。
    if (clientRequest.toolChoice.mode === 'forced') return clientRequest

    const configured = resolveToolPolicy()
    const authFailed = detectAuthFailedTools(messages)
    const disabled = new Set<string>([...configured.disabledTools, ...authFailed])
    if (disabled.size === 0) return clientRequest

    const { kept, removed } = partitionDisabledTools(clientRequest.tools, disabled)
    if (removed.length === 0) return clientRequest

    const detail = removed
      .map((name) => `${name}${authFailed.has(name) ? '(工具返回认证失败)' : '(配置屏蔽)'}`)
      .join('、')
    this.log(
      `[ToolCalling] 已屏蔽工具 ${detail}，本轮注入 ${kept.length}/${clientRequest.tools.length} 个工具`,
    )
    return { ...clientRequest, tools: kept }
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

    if (parseResult.toolCalls.length === 0) {
      // 解析不出工具调用时留一条现场：模型到底吐了什么。缺这条日志，
      // 「模型明明该调工具却回了一段话」只能靠猜。
      const preview = message.content.replace(/\s+/g, ' ').slice(0, 220)
      this.log(
        `[ToolCalling] parsed=0 provider=${plan.providerId} protocol=${plan.protocol} ` +
          `chars=${message.content.length} text="${preview}"`,
      )
      // 模型自述「只有某个不存在的工具 / 轮数上限」时，几乎都是 system 被污染
      // （URL 触发网页助手人格、或历史里的失败回放），单独标出来便于定位。
      if (/open_url|轮数|已达上限|tool-call limit|maximum number of rounds/i.test(message.content)) {
        this.log(
          `[ToolCalling] 疑似拒绝执行：provider=${plan.providerId} 模型声称工具不可用/轮数超限，` +
            `请检查 system 是否混入链接或历史失败记录`,
        )
      }
      return
    }

    this.log(
      `[ToolCalling] parsed=${parseResult.toolCalls.length} provider=${plan.providerId} ` +
        `tools=${parseResult.toolCalls.map((call) => call.function.name).join(',')}`,
    )

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
 * 工具、幻觉"只有 open_url"或"工具调用已达上限"。而在精简 system（≤~2KB，无
 * "Web GUI" 等误导句）下同一模型稳定调用 bash。
 *
 * 策略：给 system 设总预算。注入的工具清单优先保留（它是模型唯一能知道工具名
 * 的来源），剩余预算才留给客户端指令；客户端指令超预算时按段落保留"身份 + 工具
 * 规则"核心内容，丢弃长段行为规范；同时显式剔除会误导 GLM 的 "Web GUI /
 * web page" 角色描述（该描述本意是说明人类如何查看会话，却被 GLM 解读为
 * "自己是网页聊天助手"）。
 */
/** system 总预算（字符）。超出后先压缩客户端指令，不动注入的工具清单。 */
const SYSTEM_TOTAL_BUDGET = 20000

/** 客户端 system 自身可占用的上限（工具清单很小时不让客户端独吞预算）。 */
const SYSTEM_TRIM_MAX_CHARS = 12000

/**
 * 「能抓网页」的工具名归一化匹配。
 *
 * 各客户端的命名不统一（WebFetch / web_fetch / fetch / fetch_url），v1.7.1 用的是
 * 精确相等 `name === 'WebFetch'`，遇到 dsh 的 `web_fetch` 永远判 false，于是提示
 * 退化成含糊的 "an available fetch tool"——模型更容易幻觉出一个不存在的工具。
 * 这里去掉命名空间前缀（`default_api:read_file`）后按词形匹配。
 */
const FETCH_TOOL_NAME_PATTERN = /^(?:web_?fetch|fetch|fetch_url|url_fetch)$/i

/** 去掉客户端工具名的命名空间前缀（`default_api:web_fetch` → `web_fetch`）。 */
function toolBaseName(name: string): string {
  const index = name.lastIndexOf(':')
  return index >= 0 ? name.slice(index + 1) : name
}

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

function trimSystemMessages(messages: ChatMessage[], maxChars = SYSTEM_TRIM_MAX_CHARS): ChatMessage[] {
  return messages.map((msg) => {
    if (msg.role !== 'system' || typeof msg.content !== 'string') return msg
    const trimmed = trimSystemContent(msg.content, maxChars)
    return trimmed === msg.content ? msg : { ...msg, content: trimmed }
  })
}

function trimSystemContent(content: string, maxChars = SYSTEM_TRIM_MAX_CHARS): string {
  if (!content || content.length <= maxChars) return content

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
    if (kept.join('\n\n').length >= maxChars) break
  }

  // 保底：若关键词过滤后太少，保留开头段落（通常是身份定义）
  if (kept.length < 2) {
    const head = paras.slice(0, Math.max(2, Math.floor(maxChars / 200)))
    return head.join('\n\n').slice(0, maxChars)
  }

  return kept.join('\n\n').slice(0, maxChars)
}

/**
 * 工具可用锚定提示（追加到最新 user 消息）。
 *
 * 多轮对话中，system 里的身份/工具声明会被早先的 assistant tool 调用与失败结果
 * （如 browser_open Electron 缺失）逐渐稀释——GLM 等模型会据此幻觉"工具不可用"。
 * 在最新 user 消息（模型注意力最强处）重申工具真实可用，可对抗该历史污染。
 *
 * 注意措辞：这里只做**正向**声明，不写"不存在某工具""没有轮数上限"这类否定句。
 * 实测这类句子会把 "open_url""轮数上限" 直接塞进上下文，模型反而复述成自己的
 * 处境（"我只有 open_url""轮数已达上限"）然后放弃任务。
 */
const LATEST_USER_ANCHOR = '\n\n[System reminder: the tool list at the top of this conversation is current. When the task needs a file, a command, or a skill, call the matching tool and continue from its result.]'


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
