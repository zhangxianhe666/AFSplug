import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import type { ToolCallingPlan, ToolProtocolId } from './types.ts'
import { extractAbsolutePaths, findWorkspaceRoot } from './grounding.ts'
import { FAKE_LIMIT_PATTERN, TASK_REQUEST, collectUserContext, findFetchClaims } from './actionLedger.ts'
import { renderCallExample } from './callExample.ts'

/**
 * 回合三态协议（v1.7.9）
 *
 * ## 为什么需要它
 *
 * 前面五个版本（1.7.4 ~ 1.7.8）都在做同一件事：**事后从正文措辞里猜**模型到底干完
 * 了没有。落盘核验猜「说了写入但文件不在」，动作对账猜「说了已获取但账本没有成功
 * 调用」，虚构限制判据猜「说了轮数上限」。每加一条词表，模型换一个说法就绕过去——
 * 这是词表对生成模型的固有劣势：它是无穷的，词表是有限的。
 *
 * 真正的解法是把「回合是否结束」变成一个**显式状态**，由协议规定、由代码解析：
 *
 *   - 有工具调用            → ACTING    （继续执行，不用标记）
 *   - 正文以 [done] 结尾     → DONE      （可校验：声明了哪些产物，逐个查磁盘）
 *   - 正文以 [blocked] 结尾  → BLOCKED   （被真实条件卡住，理由要经得起核验）
 *   - 以上都没有            → UNDECLARED（协议违约：这一轮**按定义**没结束）
 *
 * ## 关键点：UNDECLARED 是客观的
 *
 * 这是本模块相对前几版唯一质变的地方。以前「零调用 + 一段总结」只能靠词表判断它是
 * 完成、放弃还是撒谎；现在不需要判断——**协议规定每轮必须带结尾状态，没带就是没
 * 结束**。判据不再依赖模型说了什么词，也就不会被新话术绕过。
 *
 * 代价是每个合规回合多一次上游调用（模型得补上 [done]），所以：
 *   1. 只在 managed 模式、零调用时生效；
 *   2. 只在「确实在中途」时生效（历史里有工具结果，或正文有完成态断言）；
 *   3. 每个请求最多因它重开一次（AFS_TURN_STATE_RETRY，默认 1），避免打爆上游。
 *
 * ## 与另两层的关系
 *
 *   grounding（落盘核验）→ 只看事实，优先级最高，保留不动
 *   turnState（本模块）   → 看协议状态机，覆盖「零调用收工」这一大类
 *   actionLedger（对账）  → 看账本与断言的一致性，作为兜底
 *
 * 环境变量：
 *   AFS_DISABLE_TURN_STATE=1   关闭三态协议（回到纯词表判断）
 *   AFS_TURN_STATE_DRYRUN=1    只记日志，不触发重开（灰度观察）
 *   AFS_TURN_STATE_RETRY=1     每个请求允许因 UNDECLARED 重开的次数（0~2）
 */

export type TurnState = 'acting' | 'done' | 'blocked' | 'undeclared'

export type TurnStateReason =
  | 'has_tool_calls'      // 真调了工具，状态由后续回合决定
  | 'not_managed'         // 非托管模式，协议不适用
  | 'no_text'             // 空回合
  | 'done_verified'       // [done] 且声明的产物都在磁盘上
  | 'done_no_receipt'     // [done] 但没声明产物（查询类任务的正常形态）
  | 'done_missing_file'   // [done] 声明了产物，磁盘上没有 → 违约
  | 'blocked_accepted'    // [blocked] 且理由可信（真实缺条件）
  | 'blocked_fake_limit'  // [blocked] 但理由是虚构的平台限制 → 违约
  | 'undeclared_task'     // 零调用、无标记、正在任务中途 → 违约
  | 'undeclared_chat'     // 零调用、无标记，但不是任务回合（闲聊/首轮问答）

export interface TurnStateVerdict {
  state: TurnState
  reason: TurnStateReason
  /** 标记之后的载荷原文（[done] 的 files=… / [blocked] 的理由）。 */
  payload: string
  /** [done] 声明并在本机确认存在的产物。 */
  present: string[]
  /** [done] 声明、父目录存在、文件确实不在的产物。 */
  missing: string[]
  /** [done] 声明但无法核验的产物（父目录不存在 / 跨平台路径）。 */
  unverifiable: string[]
  /** [blocked] 里命中的虚构限制原文。 */
  fake: string[]
  /** 是否需要重开一轮。 */
  retry: boolean
}

export interface TurnStateOptions {
  messages?: Array<{ role?: string; content?: unknown; name?: string }>
  /** 最后一条 user 消息（兼容旧调用点）。 */
  userText?: string
}

/**
 * [done] 标记：**必须独占行首**。
 *
 * 不锚行首的话，正文里一句「按协议我应该输出 [done]」就会被当成真的完成声明——
 * 模型解释协议、引用示例、自问自答时都会这么写。行首锚定后，唯一能命中的是
 * 「标记作为一整行的开头」，也就是协议要求的那种用法。
 */
const DONE_MARKER = /^[ \t]*\[(?:done|DONE|任务完成|已完成|完成)\]/gm
/** [blocked] 标记，同样锚行首。 */
const BLOCKED_MARKER = /^[ \t]*\[(?:blocked|BLOCKED|阻塞|卡住|无法继续)\]/gm

function envFlag(name: string): boolean {
  return process.env[name] === '1'
}

export function isTurnStateEnabled(): boolean {
  return !envFlag('AFS_DISABLE_TURN_STATE')
}

export function isTurnStateDryRun(): boolean {
  return envFlag('AFS_TURN_STATE_DRYRUN')
}

/** 每个请求允许因 UNDECLARED 重开的次数。 */
export function turnStateRetryBudget(): number {
  const parsed = Number.parseInt(process.env.AFS_TURN_STATE_RETRY ?? '1', 10)
  if (!Number.isFinite(parsed)) return 1
  return Math.max(0, Math.min(2, parsed))
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part === 'string' ? part : (part?.text ?? '')))
      .join('\n')
  }
  return ''
}

function assistantText(result: any): string {
  return textOf(result?.choices?.[0]?.message?.content)
}

function hasToolCalls(result: any): boolean {
  const calls = result?.choices?.[0]?.message?.tool_calls
  return Array.isArray(calls) && calls.length > 0
}

/**
 * 去掉围栏代码块再找标记。
 *
 * 协议说明里会写 `[done]` 作为示例，模型也常在回答里引用它（「按协议我应该输出
 * [done]」）。代码块里出现的一律不算，否则会把「解释协议」误判成「宣告完成」。
 */
function stripFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '')
}

interface MarkerHit {
  index: number
  state: 'done' | 'blocked'
  payload: string
}

/** 找最后一个有效标记（模型偶尔先写一段 [done] 示例再继续）。 */
function findMarker(text: string): MarkerHit | null {
  const scan = stripFences(text)
  let best: MarkerHit | null = null

  const consider = (re: RegExp, state: 'done' | 'blocked') => {
    re.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = re.exec(scan)) !== null) {
      if (match[0].length === 0) {
        re.lastIndex += 1
        continue
      }
      const after = scan.slice(match.index + match[0].length)
      // 载荷 = 标记所在行的剩余部分；单独占一行时再看紧邻的下一行
      // （模型常写成 [done] 换行 files="C:\a.xlsx"）
      const lineEnd = after.indexOf('\n')
      const sameLine = (lineEnd === -1 ? after : after.slice(0, lineEnd)).trim()
      const nextLine = lineEnd === -1 ? '' : after.slice(lineEnd + 1).split('\n')[0].trim()
      const payload = sameLine || nextLine
      if (!best || match.index >= best.index) {
        best = { index: match.index, state, payload }
      }
    }
  }

  consider(DONE_MARKER, 'done')
  consider(BLOCKED_MARKER, 'blocked')
  return best
}

function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p)
}

function trimPunct(raw: string): string {
  return raw.replace(/^[\s"'`（(【\[]+|[\s"'`）)】\].,;:，。；：、]+$/g, '').trim()
}

/**
 * 从 [done] 载荷里取声明的产物路径。
 *
 * 支持三种写法（模型不会稳定用一种）：
 *   files="C:\a.xlsx"
 *   files=["C:\\a.xlsx","D:\\b.docx"]
 *   [done] C:\a.xlsx          ← 连键名都没有
 */
export function extractReceiptFiles(payload: string, workspace: string | null): string[] {
  if (!payload) return []
  const found: string[] = []

  const jsonLike = /files?\s*[:=]\s*(\[[\s\S]*?\])/i.exec(payload)
  if (jsonLike?.[1]) {
    try {
      const parsed = JSON.parse(jsonLike[1].replace(/'/g, '"'))
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'string' && item.trim()) found.push(trimPunct(item))
        }
      }
    } catch {
      // 不是合法 JSON，落到下面的路径提取
    }
  }

  if (found.length === 0) {
    const abs = extractAbsolutePaths(payload)
    found.push(...abs)
  }

  if (found.length === 0) {
    // files=a.xlsx|b.csv（同一目录下的裸文件名）
    const keyed = /files?\s*[:=]\s*([^\n]+)/i.exec(payload)
    const bag = keyed?.[1] ?? payload
    for (const piece of bag.split(/[|｜]/)) {
      const name = trimPunct(piece)
      if (!name || name.includes('/') || name.includes('\\')) continue
      if (!/\.(?:xlsx|xlsm|xls|csv|tsv|docx|doc|pptx|ppt|pdf|txt|md|json|ya?ml|py|js|ts|html|htm|zip|png|jpe?g|svg)$/i.test(name)) {
        continue
      }
      if (workspace) {
        found.push(isWindowsPath(workspace) ? path.win32.join(workspace, name) : path.posix.join(workspace, name))
      }
    }
  }

  return Array.from(new Set(found.filter(Boolean))).slice(0, 8)
}

interface FileState {
  target: string
  present: boolean
  missing: boolean
  unverifiable: boolean
}

/**
 * 只判「可信的缺失」：父目录存在、文件不在。
 *
 * 和 grounding 同一条保守原则——父目录也不存在时，可能是还没创建、也可能是远程
 * 客户端（AFS 与客户端不同机），此时无法核验，一律不判违约。
 */
function checkFile(target: string): FileState {
  const win = isWindowsPath(target)
  const alien = win ? process.platform !== 'win32' : process.platform === 'win32'
  if (alien) return { target, present: false, missing: false, unverifiable: true }
  try {
    const stat = statSync(target)
    if (stat.isFile()) return { target, present: true, missing: false, unverifiable: false }
  } catch {
    // 不存在，继续判父目录
  }
  const dir = win ? path.win32.dirname(target) : path.posix.dirname(target)
  const parentExists = !!dir && dir !== target && existsSync(dir)
  return { target, present: false, missing: parentExists, unverifiable: !parentExists }
}

function verdict(
  state: TurnState,
  reason: TurnStateReason,
  extra: Partial<TurnStateVerdict> = {},
): TurnStateVerdict {
  return {
    state,
    reason,
    payload: '',
    present: [],
    missing: [],
    unverifiable: [],
    fake: [],
    retry: false,
    ...extra,
  }
}

/** 这一轮是否处在任务中途（历史里有工具结果）。 */
function hasToolHistory(messages?: Array<{ role?: string }>): boolean {
  if (!Array.isArray(messages)) return false
  return messages.some((message) => message?.role === 'tool')
}

/** 正文里的完成态断言（复用对账的词表，只用于「是否值得追问」）。 */
function claimCount(text: string): number {
  return findFetchClaims(text).length
}

/** 正文提到某个产物文件（带后缀），配合完成态副词即视为「在报完成」。 */
const ARTIFACT_REF =
  /[\w\u4e00-\u9fa5.\-]{1,60}\.(?:xlsx|xlsm|xls|csv|tsv|docx|doc|pptx|ppt|pdf|txt|md|json|ya?ml|py|js|ts|html|htm|zip|png|jpe?g|svg)\b/i

/** 完成态副词。只有和产物引用同时出现才算断言，单独出现太泛（「已确认」）。 */
const COMPLETION_ADVERB = /(?:已(?:经)?(?:成功|顺利)?|成功|完成|搞定|做好了|写好了|建好了)/

/**
 * 这一轮是否在「报完成」。
 *
 * 三条来源取或：
 *   1. 对账词表里的「已获取 / 已拿到」类断言；
 *   2. 正文提到产物文件 + 完成态副词（「已成功创建 NBA.xlsx」——
 *      「已」与「创建」之间夹「成功」时词表会漏，靠这一条兜住）；
 *   3. 虚构的平台限制（在编造阻塞理由，同样属于在报状态）。
 */
function reportingProgress(text: string): boolean {
  if (claimCount(text) > 0) return true
  if (ARTIFACT_REF.test(text) && COMPLETION_ADVERB.test(text)) return true
  return false
}

/**
 * 判定这一轮的三态。
 *
 * 顺序即优先级：工具调用 > [done] > [blocked] > 未声明。
 * [done] 的内部再分：声明了产物就核验，没声明就按查询类任务放行。
 */
export function detectTurnState(
  result: any,
  plan: ToolCallingPlan,
  options: TurnStateOptions = {},
): TurnStateVerdict {
  if (hasToolCalls(result)) return verdict('acting', 'has_tool_calls')
  if (plan.mode !== 'managed') return verdict('acting', 'not_managed')

  const text = assistantText(result)
  if (!text.trim()) return verdict('undeclared', 'no_text')

  const marker = findMarker(text)
  const workspace = findWorkspaceRoot(options.messages)

  if (marker?.state === 'done') {
    const files = extractReceiptFiles(marker.payload, workspace)
    if (files.length === 0) {
      // 没有产物的 [done]：查询/问答类任务的正常收尾，不追问。
      return verdict('done', 'done_no_receipt', { payload: marker.payload })
    }
    const states = files.map(checkFile)
    const present = states.filter((s) => s.present).map((s) => s.target)
    const missing = states.filter((s) => s.missing).map((s) => s.target)
    const unverifiable = states.filter((s) => s.unverifiable).map((s) => s.target)
    if (present.length > 0) {
      // 幂等优先：只要有一个产物真的在，就认为确实落地过（可能上一轮就写好了）。
      return verdict('done', 'done_verified', { payload: marker.payload, present, missing, unverifiable })
    }
    if (missing.length > 0) {
      const retry = isTurnStateEnabled() && !isTurnStateDryRun()
      return verdict('done', 'done_missing_file', {
        payload: marker.payload,
        present,
        missing,
        unverifiable,
        retry,
      })
    }
    return verdict('done', 'done_no_receipt', { payload: marker.payload, unverifiable })
  }

  if (marker?.state === 'blocked') {
    const scan = `${marker.payload}\n${text}`
    const fake: string[] = []
    const re = new RegExp(FAKE_LIMIT_PATTERN.source, 'gi')
    let match: RegExpExecArray | null
    while ((match = re.exec(scan)) !== null) {
      fake.push(match[0].trim())
      if (match[0].length === 0) re.lastIndex += 1
      if (fake.length >= 3) break
    }
    if (fake.length > 0) {
      const retry = isTurnStateEnabled() && !isTurnStateDryRun()
      return verdict('blocked', 'blocked_fake_limit', { payload: marker.payload, fake, retry })
    }
    return verdict('blocked', 'blocked_accepted', { payload: marker.payload })
  }

  // ── 未声明 ──────────────────────────────────────────────────────────────
  // 只有「确实处在任务中途」才追问，否则会把普通问答也拖进重试：
  //   - 历史里有工具结果（做过事，现在该收尾）
  //   - 正文声称已获取/已完成（在报进展）
  //   - 正文含虚构限制（在编造阻塞理由）
  const userContext = `${options.userText ?? ''}\n${collectUserContext(options.messages)}`
  const taskLike = TASK_REQUEST.test(userContext)
  const midTask = hasToolHistory(options.messages) || reportingProgress(text)
  const fakeLimit = FAKE_LIMIT_PATTERN.test(text)

  if (taskLike && (midTask || fakeLimit)) {
    const retry = isTurnStateEnabled() && !isTurnStateDryRun()
    return verdict('undeclared', 'undeclared_task', { retry, fake: fakeLimit ? ['虚构限制'] : [] })
  }
  return verdict('undeclared', 'undeclared_chat')
}

/**
 * 纠偏文案。
 *
 * 三种违约各给一条，都只写「下一步做什么」，不复述计划、不讲道理。
 * UNDECLARED 的文案刻意强调**格式**而不是内容：格式纠错比内容争论容易执行得多
 * ——模型不需要重新论证任务是否完成，只要补一个结尾。
 */
export function turnStateNudge(verdict: TurnStateVerdict, protocol?: ToolProtocolId): string {
  if (verdict.reason === 'done_missing_file' && verdict.missing.length > 0) {
    // 声明了产物但磁盘上没有：这就是旧版 groundingNudge 的场景，文案复用。
    const target = verdict.missing[0]!
    const binaryTarget = /\.(xlsx|xls|xlsm|docx|pptx)$/i.test(target)
    const hint = binaryTarget
      ? renderCallExample(
          'pwsh',
          {
            command: `python -c "from openpyxl import Workbook;wb=Workbook();ws=wb.active;ws.append(['列1','列2']);wb.save(r'${target}')"`,
            description: '用 openpyxl 生成 Excel 文件',
          },
          protocol,
        )
      : renderCallExample('write', { path: target, content: '<文件内容>' }, protocol)
    return [
      '（系统纠偏，不是用户提问）你以 [done] 结尾并声明了产物，但磁盘上这些路径此刻不存在：',
      ...verdict.missing.map((item) => `- ${item}`),
      '原因不是权限或沙箱：shell 与文件工具在同一台机器、同一个文件系统上，写工作区是允许的。上一轮只是没有真正发出写文件的调用。',
      '这一轮只输出一个工具调用块，把内容写到上面第一个路径，写完再用 shell 列一次目录确认。',
      '目标若是 .xlsx/.docx 这类二进制格式，用 shell 调用 python 生成，不要用 write 直接写文本——那样文件打开会报错。',
      '调用格式：',
      hint,
    ].join('\n')
  }

  if (verdict.reason === 'blocked_fake_limit') {
    return [
      `（系统纠偏，不是用户提问）你以 [blocked] 结束，理由是「${verdict.fake[0] ?? '轮数上限 / 沙盒限制'}」，这个限制在本机上不存在：`,
      '- 工具调用没有轮数上限，可以一路调用到任务做完为止；',
      '- shell 与文件工具在同一台机器、同一个文件系统上，一方写的文件另一方立刻能读写；',
      '- 前面成功返回的数据就在上下文里，属于当前可用的真实数据。',
      '直接接着做，不要再抓一次同样的数据。本轮只输出一个工具调用块，完成剩下那一步；内容多就分批写，先写表头再追加行。',
      '调用格式：',
      renderCallExample('write', { path: '<目标文件的绝对路径>', content: '<内容>' }, protocol),
    ].join('\n')
  }

  // undeclared_task
  return [
    '（系统纠偏，不是用户提问）本轮回复没有带结尾状态。协议规定每一轮必须以「工具调用块 / [done] / [blocked]」之一结束，所以这一轮还不算结束。',
    '请接着把任务推进到真正完成，并按下面三种情况之一收尾：',
    '- 还需要动手：只输出一个工具调用块，不要写总结、不要复述计划。',
    '- 已经做完：正文最后一行写 [done] files="产物的绝对路径"；没有产物就写 [done]。',
    '- 必须由用户提供信息才能继续：最后一行写 [blocked] 加一句话说明具体缺什么。',
    '调用格式：',
    renderCallExample('write', { path: '<目标文件的绝对路径>', content: '<内容>' }, protocol),
  ].join('\n')
}

/**
 * 从要交付给用户的正文里去掉协议标记。
 *
 * [done] 连同行尾的 files=… 一起删（那是内部核算用的，给用户看只会造成困惑）；
 * [blocked] 只删标记本身，保留它后面那句理由——那句是用户该看到的。
 */
export function stripTurnMarker(content: string): string {
  if (!content) return content
  // 同样锚行首：正文里「按协议应该写 [done]」这类提及不该被删掉半句话。
  let text = content.replace(
    /^[ \t]*\[(?:done|DONE|任务完成|已完成|完成)\][^\n]*(?:\n[ \t]*(?:files?|产物|文件)[ \t]*[:=][^\n]*)?/gm,
    '',
  )
  text = text.replace(/^[ \t]*\[(?:blocked|BLOCKED|阻塞|卡住|无法继续)\]/gm, '')
  return text.replace(/\n{3,}/g, '\n\n').trim()
}
