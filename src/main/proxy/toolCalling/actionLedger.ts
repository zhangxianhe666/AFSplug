import type { ToolProtocolId } from './types.ts'

/**
 * 动作对账（v1.7.5）
 *
 * v1.7.4 只用「文件落盘核验」判断假完成，解决了一类失败：
 *
 *   模型：「已写入 BU.xlsx」 → 磁盘上根本没有 → 重开一轮
 *
 * 但线上更常见的失败是另一种，落盘核验看不见：
 *
 *   第一轮：web_fetch(nba.com/games) → 403
 *   第二轮：「改用 ESPN 成功获取了数据，但 JSON 太长…本次任务未能全部完成」
 *          （实际上一次 ESPN 都没抓）
 *
 * 这一轮零 tool_calls，正文自称「已获取数据 + 任务未完成」，客户端把它当最终回答，
 * 回合结束，用户看到的是「什么都没有」。比 v1.7.3 更差——v1.7.3 至少会因为沙箱/
 * 话术判据重开一次，逼出第二轮真实调用。
 *
 * 这里不再猜措辞背后的意图，只做**账本对账**：
 *
 *   - 历史里每一次工具调用都有结果消息（role=tool），成功还是失败是可读的；
 *   - 正文说「已获取/已抓取/已拿到」时，账本里必须至少有一条成功的结果。
 *     账本是空的、或全是失败 → 这句「已获取」没有依据，本轮作废重开。
 *   - 正文没有这类断言，但历史最后一次调用是失败的、且正文自述「未完成/未能」，
 *     同样判为「失败了就收工」，重开一轮。
 *
 * 三条保守约束：
 *   1. 只在 managed 模式、本轮零 tool_calls 时判定；
 *   2. 用户这一轮确实在要产出（抓取 / 写文件 / 建表 / 跑命令），闲聊不判；
 *   3. 账本里只要有一次成功结果就放行——模型可能引用的是上一轮真实拿到的数据。
 */

export type LedgerReason =
  | 'has_tool_calls'    // 真的调了工具，不做判定
  | 'not_managed'       // 非托管模式
  | 'no_tools'          // 本轮没有注入工具
  | 'no_text'           // 没有正文
  | 'not_task'          // 用户没在要产出（闲聊）
  | 'no_claim'          // 没有任何「已获取 / 已完成」类断言
  | 'backed'            // 断言有账本支撑
  | 'unbacked_claim'    // 声称已获取数据，但账本里没有一次成功调用 → 假完成
  | 'gave_up'           // 最后一次调用失败 + 正文自述未完成 → 失败即收工
  | 'fake_limit'        // 虚构「轮数上限 / 沙盒无法读本地文件」并据此收工

export interface LedgerVerdict {
  /** 是否建议作废本轮、重开一轮。 */
  retry: boolean
  reason: LedgerReason
  /** 命中的断言片段（日志 / 测试用）。 */
  matched: string[]
  /** 账本统计：成功 / 失败的工具结果条数。 */
  okCount: number
  failCount: number
  /** 最后一条失败结果的摘要（用于纠偏提示）。 */
  lastFailure: string | null
}

export interface LedgerOptions {
  /** 本轮请求的 messages（含历史 tool 结果）。 */
  messages?: Array<{ role?: string; content?: unknown; name?: string }>
  /** 最后一条 user 消息，用于判断是否任务型请求。 */
  userText?: string
}

/**
 * 工具结果里的失败标记。
 *
 * HTTP 只认带 `HTTP` 前缀的状态码：裸 `\b403\b` 会命中正文数据里的场馆号、
 * 观众人数、球员身高之类的数字，把成功结果记成失败（16:26 的 fail=1 即此）。
 */
const FAILURE_PATTERN =
  /(?:HTTP[^0-9]{0,6}[45]\d{2}|Access Denied|ENOENT|ECONNREFUSED|ETIMEDOUT|EACCES|command not found|is not recognized as an internal or external command|识别为 cmdlet|Permission denied|Exit Code:\s*[1-9]\d*|请求失败|调用失败|执行失败|请求超时|认证失败)/i

/**
 * 只看结果的头尾判断成败。
 *
 * 工具结果真正的错误摘要总在开头（`[TOOL_ERROR]` / `HTTP 403` / `Exit Code: 1`），
 * 正文数据中间的偶然命中不算。中间 4 万字符的 JSON 一个词判错，账本就失真。
 */
function isFailureText(text: string): boolean {
  if (!text) return false
  if (text.startsWith('[TOOL_ERROR]')) return true
  return FAILURE_PATTERN.test(text.slice(0, 400)) || FAILURE_PATTERN.test(text.slice(-400))
}

/**
 * 「已获取 / 已抓到」类断言。
 *
 * 只收「完成态 + 获取类动词」的组合：已完成、已获取、已抓取、成功获取、
 * 已通过 web_fetch 拉取到…… 单纯的「我会去抓」「需要抓取」不算。
 */
const FETCH_CLAIM_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'obtained', pattern: /已(?:经)?(?:成功)?(?:获取|获得|拿到|取到|查到|拉取到|抓取到)/ },
  { label: 'via_tool', pattern: /已(?:经)?(?:通过|用|使用)[^\n。；;]{0,18}?(?:抓取|获取|拉取|读取|查到|成功)/ },
  { label: 'success_verb', pattern: /(?:成功|已)(?:获取|抓取|拉取|查到|读取|访问|连上)(?:到|了|成功)?/ },
  // 「拿到了」「已经连上」「成功拿到」——都是同一件事的口语说法，缺了它们
  // 模型换个动词就能绕过对账。
  { label: 'got_it', pattern: /(?:拿到|取到|抓到)了/ },
  { label: 'connected', pattern: /(?:成功|能|可以)(?:连上|连通|访问)/ },
]

/** 断言窗口内出现这些词，说明是否定/未完成语境，不当作「已完成」。 */
const CLAIM_NEGATION = /(?:尚未|未能|没有|没能|无法|失败|不成功|未获取|未完成)/

/** 用户这一轮在要产出（而不是问概念）。 */
const TASK_REQUEST =
  /(抓取|获取|查询|搜索|整理|汇总|写入|写进|保存|导出|新建|创建|生成|制作|做一|帮我|跑一下|运行|下载|爬|fetch|scrape|write|save|create|export|generate|download|继续|接着|下一步|往下|go on|continue)/i

/** 正文自述「没做完」。 */
const GIVE_UP_PATTERN =
  /(未完成|未能|尚未完成|没能|无法完成|无法继续|无法完成该任务|本次任务未能|任务失败|暂时无法|抱歉)/

/**
 * 虚构的平台限制。
 *
 * GLM 网页版自带「代码沙盒 / 对话轮数」的产品语境。任务一卡住，它就把这套语境套到
 * 本机工具上，输出「沙盒无法读取主机临时文件」「工具调用已达本轮上限」，然后收工。
 *
 * 这两句在本机上都不成立，是可客观核验的事实：pwsh 与工作区共用同一个文件系统；
 * 代理层也没有任何轮数上限（代码里没有这个配置）。16:26 的现场是——ESPN 数据已经
 * HTTP 200 返回在上下文里，它仍以这句话结束回合，而当时的词表只认「未完成/无法完成」，
 * 一个字都没命中，判据返回 no_claim。
 */
const FAKE_LIMIT_PATTERN =
  /(?:(?:轮数|轮次|调用次数|工具调用|回合|对话轮)[^\n。；;]{0,14}(?:上限|限制|用完|耗尽|用尽|达到)|(?:已达|达到|超出|超过)[^\n。；;]{0,10}(?:上限|轮数|轮次)|(?:沙盒|沙箱)[^\n。；;]{0,16}(?:无法|不能|不支持|受限|读不到|读不了)|(?:无法|不能)(?:读取|访问)(?:主机|本地)(?:的)?(?:临时)?文件)/

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part === 'string' ? part : (part?.text ?? '')))
      .join('\n')
  }
  return ''
}

/** 本轮 assistant 正文。 */
function assistantText(result: any): string {
  return textOf(result?.choices?.[0]?.message?.content)
}

function hasToolCalls(result: any): boolean {
  const calls = result?.choices?.[0]?.message?.tool_calls
  return Array.isArray(calls) && calls.length > 0
}

/** 汇总历史里的工具结果（只认 role=tool）。 */
export function collectToolResults(
  messages?: Array<{ role?: string; content?: unknown; name?: string }>,
): { ok: boolean; text: string }[] {
  const results: { ok: boolean; text: string }[] = []
  if (!Array.isArray(messages)) return results
  for (const message of messages) {
    if (!message || message.role !== 'tool') continue
    const text = textOf(message.content)
    results.push({ ok: !isFailureText(text), text })
  }
  return results
}

/** 找出正文里「已获取」类断言，排除否定语境。 */
export function findFetchClaims(text: string): string[] {
  const claims: string[] = []
  if (!text) return claims
  for (const { pattern } of FETCH_CLAIM_PATTERNS) {
    const re = new RegExp(pattern.source, 'gi')
    let match: RegExpExecArray | null
    while ((match = re.exec(text)) !== null) {
      // 只向断言之后看一小段：往前提会撞上前一句「很抱歉，本次任务未能全部完成」，
      // 把紧跟着的「成功获取了数据」也当成否定语境一起丢掉。
      const window = text.slice(match.index, match.index + match[0].length + 12)
      if (!CLAIM_NEGATION.test(window)) claims.push(text.slice(match.index, match.index + match[0].length + 12).trim())
      if (match[0].length === 0) re.lastIndex += 1
    }
  }
  return Array.from(new Set(claims)).slice(0, 3)
}

/**
 * 最近几条 user 消息拼成的任务上下文。
 *
 * 工具失败后客户端常常只发一句「继续」，此时只看最后一条 user 消息会判成
 * 「不是任务型请求」直接放行——15:05 那次就是这么漏掉的。
 */
export function collectUserContext(
  messages?: Array<{ role?: string; content?: unknown }>,
  limit = 3,
): string {
  if (!Array.isArray(messages)) return ''
  const texts: string[] = []
  for (let i = messages.length - 1; i >= 0 && texts.length < limit; i--) {
    const message = messages[i]
    if (!message || (message.role !== 'user' && message.role !== 'human')) continue
    const text = textOf(message.content).trim()
    if (text) texts.push(text)
  }
  return texts.reverse().join('\n')
}

function verdict(
  retry: boolean,
  reason: LedgerReason,
  extra: Partial<LedgerVerdict> = {},
): LedgerVerdict {
  return {
    retry,
    reason,
    matched: [],
    okCount: 0,
    failCount: 0,
    lastFailure: null,
    ...extra,
  }
}

/**
 * 判定这一轮是不是「没干成事却报完成 / 失败即收工」。
 *
 * 调用方负责传入 plan，并保证只在 managed 模式调用（disabled 模式下模型本来就
 * 没有工具可用，判它「没调工具」没有意义）。
 */
export function detectUnbackedProgress(
  result: any,
  plan: { mode?: string; tools?: unknown[] } | undefined,
  options: LedgerOptions = {},
): LedgerVerdict {
  if (!plan || plan.mode !== 'managed') return verdict(false, 'not_managed')
  if (!plan.tools || plan.tools.length === 0) return verdict(false, 'no_tools')
  if (hasToolCalls(result)) return verdict(false, 'has_tool_calls')

  const text = assistantText(result)
  if (!text.trim()) return verdict(false, 'no_text')

  // 任务上下文 = 最后一条 user + 最近几条历史 user。工具失败后客户端往往只发
  // 一句「继续」，只看最后一条会判成闲聊，判据静默失效。
  const userContext = `${options.userText ?? ''}\n${collectUserContext(options.messages)}`
  if (!TASK_REQUEST.test(userContext)) return verdict(false, 'not_task')

  const results = collectToolResults(options.messages)
  const okCount = results.filter((item) => item.ok).length
  const failures = results.filter((item) => !item.ok)
  const lastFailure = failures.length > 0 ? failures[failures.length - 1].text : null
  const stats = { okCount, failCount: failures.length, lastFailure: lastFailure?.slice(0, 240) ?? null }

  const claims = findFetchClaims(text)
  if (claims.length > 0) {
    if (okCount > 0) return verdict(false, 'backed', { ...stats, matched: claims })
    return verdict(true, 'unbacked_claim', { ...stats, matched: claims })
  }

  // 虚构限制优先于通用「收工」判据：这句话本身就是「我不干了」的明确信号，
  // 而且不依赖账本成败——16:26 账本里恰恰有一次成功，按兜底逻辑会被放行。
  const fakeLimit = text.match(FAKE_LIMIT_PATTERN)
  if (fakeLimit) {
    return verdict(true, 'fake_limit', { ...stats, matched: [fakeLimit[0].slice(0, 60)] })
  }

  // 没有「已获取」类断言，但正文自述没做完 → 失败即收工。
  //
  // 不再要求「账本里必须有一条失败记录」：工具结果的 messages 形态由客户端决定
  // （有的客户端把结果包成 role=tool，有的塞进 user），账本读空时如果还要求
  // lastFailure，判据就会在真实会话里静默失效——15:03 那次正是如此。
  // 只要「这一轮零调用 + 任务型请求 + 自述未完成」，就是空转回合。
  const stalled = lastFailure !== null || okCount === 0
  if (stalled && GIVE_UP_PATTERN.test(text)) {
    return verdict(true, 'gave_up', { ...stats, matched: [text.slice(-80)] })
  }

  return verdict(false, 'no_claim', stats)
}

/** 纠偏文案：只要求下一步一个动作，并明确「上游失败就换同类来源」。 */
export function progressNudge(verdict: LedgerVerdict, protocol?: ToolProtocolId): string {
  const hint =
    protocol === 'managed_xml'
      ? '<tool_call>{"name":"web_fetch","arguments":{"url":"…"}}</tool_call>'
      : '[function_calls][call:web_fetch]{"url":"…"}[/call][/function_calls]'

  // 虚构限制要逐条拆掉，不能只说「继续」。
  // 模型是在一个具体的错误认知上收工的，只喊继续它会用同样的理由再收一次工。
  if (verdict.reason === 'fake_limit') {
    return [
      `（系统纠偏，不是用户提问）你上一轮用「${verdict.matched[0] ?? '轮数上限 / 沙盒限制'}」这个理由停下了，这个理由不成立：`,
      '- 工具调用没有轮数上限，可以一路调用到任务做完为止；',
      '- pwsh 与文件工具在同一台机器、同一个文件系统上，一方写的文件另一方立刻能读写；',
      '- 前面那几次调用是成功的，返回的数据就在上面的工具结果里，属于当前可用的真实数据。',
      '现在直接接着做，不要再抓一次同样的数据。本轮只输出一个工具调用块，完成剩下那一步：把已有数据写进用户要求的文件（内容多就分批写，先写表头，再追加行）。',
      '如果你认为自己缺的是某个具体字段，只补抓那个字段。',
      '调用格式：',
      hint,
    ].join('\n')
  }

  const lines = [
    verdict.reason === 'unbacked_claim'
      ? '（系统纠偏，不是用户提问）上一轮正文里的「已获取 / 已完成」没有对应的成功调用记录，任务还停在这一步。'
      : '（系统纠偏，不是用户提问）上一轮工具失败后直接停下了，任务还停在这一步，前面的数据仍然有效。',
  ]
  if (verdict.lastFailure) {
    lines.push(`上一轮的工具结果是这样的失败信息：${verdict.lastFailure.replace(/\s+/g, ' ').slice(0, 160)}`)
    lines.push('这类失败通常是目标站点拒绝直连。换一个同类公开来源或换查询参数，再取一次，通常就能拿到数据。')
  }
  lines.push(
    '现在继续，本轮只做一件最小的事：输出一个工具调用块，把这一步的数据真正取回来。',
    '拿到结果后，下一步再写入文件；内容多可以分段写，不必一次生成全部。',
    '调用格式：',
    hint,
  )
  return lines.join('\n')
}
