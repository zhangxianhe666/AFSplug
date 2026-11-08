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
    // user 侧链接保留地址、只换表达（见 rewriteUserUrls 注释）。指引里点名 WebFetch
    // 的前提是这一轮确实有该工具，否则会指向不存在的工具名。
    const hasWebFetch = plan.tools.some((tool) => tool.name === 'WebFetch')
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

/**
 * 需要摘除 system 裸链接的 provider。
 *
 * 实测（2026-11-04，GLM-5.3 / chatglm.cn）：客户端 system 里只要出现一个
 * http(s) 链接（本例是「参考文档见 https://www.workbuddy.cn/docs/...」），模型
 * 立刻切到「网页助手」人格——声称自己"只有一个 open_url 工具""open_url 多次
 * 返回空""工具调用轮数已达上限（3/3）"，然后放弃本地工具、只输出一段 PPT 文案。
 *
 * 对照实验（同一客户端 system、同一用户消息、同一 22 个工具）：
 *   原始文本（含链接）        → 3/3 失败，无 tool_calls
 *   链接换成 example.com      → 失败
 *   链接替换为 [链接]         → 2/2 成功，正常调用 Skill
 *   只截到链接之前（无链接）  → 成功
 *
 * 成因：chatglm 网页版自身的 agent harness 里确有 open_url 工具，prompt 中的
 * URL 会把它召回，模型遂以"网页工具"的视角解读本应在本地执行的工具清单。
 * 这是模型侧的先验，靠提示词否定句压不住（相反对抗句会被复述）。
 *
 * 只处理 system：用户消息里的链接可能是任务本体（"帮我抓这个页面"），
 * 替换掉会改变语义。
 */
const URL_DEFUSE_PROVIDERS = new Set(['glm'])

const BARE_URL_PATTERN = /https?:\/\/[^\s<>"'）】\]]+/g

function defuseSystemUrls(
  messages: ChatMessage[],
  providerId: string,
  log: (message: string) => void,
): ChatMessage[] {
  if (!URL_DEFUSE_PROVIDERS.has(providerId)) return messages
  let replaced = 0
  const next = messages.map((msg) => {
    if (msg.role !== 'system' || typeof msg.content !== 'string') return msg
    const content = msg.content.replace(BARE_URL_PATTERN, () => {
      replaced += 1
      return '[链接]'
    })
    return content === msg.content ? msg : { ...msg, content }
  })
  if (replaced > 0) {
    log(`[ToolCalling] 已从 system 摘除 ${replaced} 个裸链接（防模型切到"网页助手"人格）`)
  }
  return next
}

/**
 * user 侧链接「保留但改写」。
 *
 * 与 system 不同，用户贴的链接就是任务本体（"总结这个页面""按这篇文章做 PPT"），
 * 抹成 `[链接]` 等于把任务目标删掉。但裸 URL 留在 user 里仍会召回 chatglm 网页版
 * 自带的 `open_url` 先验——模型会以为自己能直接开网页，于是不调 WebFetch 就编内容。
 *
 * 折中做法：URL 一个字符不改，只换一层表达——包成 `<user_link>…</user_link>`，
 * 让它读起来是「用户提供的一个待处理对象」，而不是「一句可执行的网址」。
 * 同时在最后一条命中的 user 消息末尾追加正向工具指引（模型注意力最强处），
 * 指向真正能抓网页的工具。
 *
 * 两处保持原样不动：
 *   - 代码块（``` 围栏内）：可能是配置、命令、示例，改了就是损坏内容
 *   - markdown 链接 `[文字](url)` 的圆括号内：包裹会破坏 markdown 语法
 */
// URL 字符集直接排除中文标点：中文语境里链接后面常紧跟句号逗号（"看这个
// https://a.com/x。"），不排除的话标点会被吞进地址，改写后模型拿到的就是脏 URL。
// 中文本身仍允许（维基等站点的路径里有中文），只挡标点。
const USER_LINK_TAG_PATTERN = /https?:\/\/[^\s<>"'）】\]。，、；：！？》」』【】]+/g

const CODE_FENCE_PATTERN = /(```[\s\S]*?```)/

function rewriteUserUrls(
  messages: ChatMessage[],
  providerId: string,
  hasWebFetch: boolean,
  log: (message: string) => void,
): ChatMessage[] {
  if (!URL_DEFUSE_PROVIDERS.has(providerId)) return messages

  let rewritten = 0
  let lastHit = -1

  const next = messages.map((msg, index) => {
    if (msg.role !== 'user') return msg

    let hit = false
    const rewriteText = (text: string): string => {
      // 按代码围栏切段，奇数下标是围栏内部，跳过。
      const segments = text.split(CODE_FENCE_PATTERN)
      for (let i = 0; i < segments.length; i += 2) {
        segments[i] = segments[i].replace(USER_LINK_TAG_PATTERN, (url: string, offset: number, whole: string) => {
          // markdown 链接目标 `[文字](url)`：保持原样，包裹会破坏语法
          if (whole.slice(Math.max(0, offset - 2), offset) === '](') return url
          hit = true
          rewritten += 1
          return `<user_link>${url}</user_link>`
        })
      }
      return segments.join('')
    }

    if (typeof msg.content === 'string') {
      const content = rewriteText(msg.content)
      if (!hit) return msg
      lastHit = index
      return { ...msg, content }
    }

    // 带附件时 content 是部件数组，只改文本部件，图片等原样保留。
    if (Array.isArray(msg.content)) {
      const content = msg.content.map((part) => {
        if (part.type !== 'text' || typeof part.text !== 'string') return part
        const text = rewriteText(part.text)
        return text === part.text ? part : { ...part, text }
      })
      if (!hit) return msg
      lastHit = index
      return { ...msg, content }
    }

    return msg
  })

  if (lastHit >= 0) {
    const hint = hasWebFetch
      ? '\n\n[System reminder: the <user_link> entries above are URLs the user supplied. Fetch them with the WebFetch tool, then answer from what it returns.]'
      : '\n\n[System reminder: the <user_link> entries above are URLs the user supplied. Read them with an available fetch tool before answering.]'
    const target = next[lastHit]
    next[lastHit] = Array.isArray(target.content)
      ? { ...target, content: [...target.content, { type: 'text' as const, text: hint }] }
      : { ...target, content: `${target.content ?? ''}${hint}` }
    log(`[ToolCalling] 已改写 user 消息中的 ${rewritten} 个链接为 <user_link>（保留地址，避免召回 open_url 人格）`)
  }

  return next
}

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
