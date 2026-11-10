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

/** 工具结果里的失败标记。 */
const FAILURE_PATTERN =
  /(?:HTTP\s*[45]\d{2}|Access Denied|\b(?:403|404|429|500|502|503)\b|ENOENT|ECONNREFUSED|ETIMEDOUT|EACCES|command not found|not recognized as an internal|Permission denied|请求失败|调用失败|执行失败|请求超时|认证失败)/i

/**
 * 「已获取 / 已抓到」类断言。
 *
 * 只收「完成态 + 获取类动词」的组合：已完成、已获取、已抓取、成功获取、
 * 已通过 web_fetch 拉取到…… 单纯的「我会去抓」「需要抓取」不算。
 */
const FETCH_CLAIM_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'obtained', pattern: /已(?:经)?(?:成功)?(?:获取|获得|拿到|取到|查到|拉取到|抓取到)/ },
  { label: 'via_tool', pattern: /已(?:经)?(?:通过|用|使用)[^\n。；;]{0,18}?(?:抓取|获取|拉取|读取|查到|成功)/ },
  { label: 'success_verb', pattern: /(?:成功|已)(?:获取|抓取|拉取|查到|读取|访问)(?:到|了|成功)?/ },
]

/** 断言窗口内出现这些词，说明是否定/未完成语境，不当作「已完成」。 */
const CLAIM_NEGATION = /(?:尚未|未能|没有|没能|无法|失败|不成功|未获取|未完成)/

/** 用户这一轮在要产出（而不是问概念）。 */
const TASK_REQUEST =
  /(抓取|获取|查询|搜索|整理|汇总|写入|写进|保存|导出|新建|创建|生成|制作|做一|帮我|跑一下|运行|下载|爬|fetch|scrape|write|save|create|export|generate|download)/i

/** 正文自述「没做完」。 */
const GIVE_UP_PATTERN =
  /(未完成|未能|尚未完成|没能|无法完成|无法继续|无法完成该任务|本次任务未能|任务失败|暂时无法|抱歉)/

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
    results.push({ ok: !FAILURE_PATTERN.test(text), text })
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

  const userText = options.userText ?? ''
  if (!TASK_REQUEST.test(userText)) return verdict(false, 'not_task')

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

  // 没有「已获取」类断言，但上一次调用是失败的、正文自述没做完 → 失败即收工。
  if (lastFailure && GIVE_UP_PATTERN.test(text)) {
    return verdict(true, 'gave_up', { ...stats, matched: [text.slice(-80)] })
  }

  // 账本全空且没有任何断言：模型可能只是回了一句解释，交给客户端判断，不在这里重开。
  if (okCount === 0 && failures.length === 0) return verdict(false, 'no_claim', stats)

  return verdict(false, 'no_claim', stats)
}

/** 纠偏文案：只要求下一步一个动作，并明确「上游失败就换同类来源」。 */
export function progressNudge(verdict: LedgerVerdict, protocol?: ToolProtocolId): string {
  const hint =
    protocol === 'managed_xml'
      ? '<tool_call>{"name":"web_fetch","arguments":{"url":"…"}}</tool_call>'
      : '[function_calls][call:web_fetch]{"url":"…"}[/call][/function_calls]'
  const lines = ['（系统纠偏，不是用户提问）上一轮正文里的「已获取 / 已完成」没有对应的成功调用记录，任务还停在这一步。']
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
