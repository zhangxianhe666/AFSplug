import type { ToolCallingPlan, ToolProtocolId } from './types.ts'

/**
 * 沙箱人格兜底（v1.7.3）
 *
 * 背景：GLM / Kimi 的网页版 harness 会在服务端给每轮对话挂一个「原生工具」，
 * 常见的是 chatglm 的 `open_url` 和 `execute_sandbox_code`，Kimi 的是智能体沙箱。
 * AFS 发给上游的 `tools` 是 0（31 个客户端工具走文本注入），控制不了这份原生工具。
 *
 * 于是当原生工具是代码沙箱时，模型遇到「本工作区有哪些文件」这类问题会切到沙箱执行，
 * 然后把沙箱目录当成用户机器报出来：
 *
 *   GLM  → /mnt/data、kernel-ipc-1~5、.ipython/
 *   Kimi → /mnt/agents、.agent-gw.json、.websites-templates/
 *
 * 这一轮的特征是 `parsed=0`（一个工具调用都没有）+ 正文命中沙箱痕迹。这类回答不
 * 直接交给客户端，作废后重开一轮；重试一次能把 1/8 的失败率压到 1/64 量级。
 *
 * 判定保持保守：强特征（沙箱绝对路径 / 沙箱工具名）命中一条即重试；弱特征（「代码
 * 沙箱」这类口语词）要两条以上、且用户这轮问的是文件/目录，才重试，避免把正常的
 * 技术讨论误判成幻觉。
 */

/** 强特征：只可能来自沙箱泄漏，正常回答里不会出现。 */
export const SANDBOX_STRONG_MARKERS = [
  '/mnt/data',
  '/mnt/agents',
  'kernel-ipc',
  '.ipython',
  'execute_sandbox_code',
  '.agent-gw.json',
  '.websites-templates',
  'only real tool is open_url',
  'open_url is the only',
  'available tools list only includes',
  'only tool available',
  'the only available tool',
]

/** 弱特征：口语化的沙箱自述，单独出现不算。 */
export const SANDBOX_WEAK_MARKERS = [
  '代码沙箱',
  '代码解释器',
  'code sandbox',
  'code interpreter',
  'sandbox',
  '工具不可用',
  'tool unavailable',
  '工具调用返回为空',
  'no file tools',
]

/** 用户这轮是否在问文件/目录/工作区（弱特征重试的前置条件）。 */
const FILE_QUESTION_PATTERN =
  /(文件|目录|文件夹|工作区|路径|仓库|项目结构|代码库|file|files|directory|folder|workspace|path|tree|ls |dir )/i

export interface HallucinationVerdict {
  /** 是否应该作废这一轮并重开。 */
  retry: boolean
  /** 命中的特征，用于日志与测试断言。 */
  matched: string[]
  /** 判定依据：sandbox_marker / sandbox_weak / has_tool_calls … */
  reason: string
}

function verdict(retry: boolean, matched: string[], reason: string): HallucinationVerdict {
  return { retry, matched, reason }
}

/**
 * 环境变量 `AFS_DISABLE_SANDBOX_RETRY=1` 可关掉兜底，便于 A/B 对比。
 * 默认开启。
 */
export function isSandboxRetryEnabled(): boolean {
  return process.env.AFS_DISABLE_SANDBOX_RETRY !== '1'
}

/** 取出 assistant 正文（兼容字符串与 parts 数组）。 */
export function extractAssistantText(result: any): string {
  const content = result?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part === 'string' ? part : (part?.text ?? '')))
      .join('\n')
  }
  return ''
}

function hasToolCalls(result: any): boolean {
  const calls = result?.choices?.[0]?.message?.tool_calls
  return Array.isArray(calls) && calls.length > 0
}

/** 取最后一条 user 消息的文本，用于判断这轮是不是文件类问题。 */
export function lastUserText(messages: Array<{ role?: string; content?: unknown }> | undefined): string {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.role !== 'user') continue
    const content = message.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .map((part: any) => (typeof part === 'string' ? part : (part?.text ?? '')))
        .join('\n')
    }
  }
  return ''
}

/**
 * 判定这一轮是不是「沙箱幻觉」。
 *
 * 只会对 managed 模式（提示词注入 + 响应解析）生效；客户端工具调用成功时
 * `tool_calls` 非空，天然不会进来。
 */
export function detectSandboxHallucination(
  result: any,
  plan: ToolCallingPlan | undefined,
  userText?: string,
): HallucinationVerdict {
  if (!plan || plan.mode !== 'managed') return verdict(false, [], 'not_managed')
  if (!plan.shouldParseResponse) return verdict(false, [], 'parse_disabled')
  if (!plan.tools || plan.tools.length === 0) return verdict(false, [], 'no_tools')
  if (hasToolCalls(result)) return verdict(false, [], 'has_tool_calls')

  const text = extractAssistantText(result)
  if (!text.trim()) return verdict(false, [], 'empty_text')
  const lower = text.toLowerCase()

  const strong = SANDBOX_STRONG_MARKERS.filter((marker) => lower.includes(marker.toLowerCase()))
  if (strong.length > 0) return verdict(true, strong, 'sandbox_marker')

  const weak = SANDBOX_WEAK_MARKERS.filter((marker) => lower.includes(marker.toLowerCase()))
  const askingFiles = FILE_QUESTION_PATTERN.test(userText ?? '')
  if (weak.length >= 2 && askingFiles) return verdict(true, weak, 'sandbox_weak')

  return verdict(false, [], 'clean')
}

/**
 * 「拒绝调用工具」兜底（v1.7.3）
 *
 * 背景：Kimi / GLM 的网页版在长 system 下（DSH 的 5.7KB 指令 + 6KB 工具清单）
 * 会偶发人格漂移——这一轮明明注入了 30 个工具，模型却回一句「我没有获取实时天气
 * 数据的工具」，然后建议用户自己去搜索引擎查。实测同一 prompt 连测 12 次都正常，
 * 线上仍会零散复现，一次就丢掉整轮（用户侧看到的是「AFS 的 kimi 不能干活」）。
 *
 * 判定要三条同时成立，避免把正常回答误判成失败：
 *   1. managed 模式、本轮有工具、模型一个都没调用；
 *   2. 用户这轮问的是需要现取的信息（实时 / 外部 / 本地实况）；
 *   3. 正文出现明确的「我没有工具 / 无法联网」话术，且本轮确实存在能取信息的工具。
 *
 * 第 3 条里的工具检查很关键：模型抱怨没工具时，如果本轮工具清单里真的连
 * web_fetch / read / shell 都没有，重开一轮也是白烧 token。
 */

/** 用户这轮问的是「要现取」的信息（配合拒绝话术一起用，单独出现不触发）。 */
const LIVE_QUESTION_PATTERN =
  /(天气|气温|温度|下雨|降雨|降雪|空气质量|新闻|热点|股价|行情|汇率|油价|金价|比分|赛况|最新|今天|今日|现在|当前|实时|刚才|weather|forecast|news|price|stock|score|latest|today|current)/i

/** 明确的「我没有工具 / 上不了网」话术。 */
const TOOL_REFUSAL_MARKERS = [
  '我没有获取',
  '没有获取实时',
  '没有获取最新',
  '我没有可用',
  '没有可用工具',
  '没有内置',
  '没有联网',
  '无法直接访问',
  '无法访问外部',
  '无法联网',
  '无法获取实时',
  '无法获取最新',
  '无法获取到',
  '网络访问限制',
  '由于网络限制',
  '受限于网络',
  '不能访问互联网',
  "i don't have access",
  'i do not have access',
  'i have no access',
  'no internet access',
  'cannot access the internet',
]

/** 本轮是否真有「能取信息」的工具（网页抓取 / 读文件 / 跑命令）。 */
const INFORMATIVE_TOOL_PATTERN =
  /^(?:web_?fetch|fetch|fetch_url|url_fetch|open_?url|read|read_file|cat|shell|bash|sh|exec|run_command|command|grep|glob|ls|list_dir)$/i

export type ToolRefusalVerdict = HallucinationVerdict

/** 环境变量 `AFS_DISABLE_TOOL_REFUSAL_RETRY=1` 可关掉兜底，便于 A/B 对比。默认开启。 */
export function isToolRefusalRetryEnabled(): boolean {
  return process.env.AFS_DISABLE_TOOL_REFUSAL_RETRY !== '1'
}

function baseToolName(name: string): string {
  const index = name.lastIndexOf(':')
  return index >= 0 ? name.slice(index + 1) : name
}

/**
 * 判定这一轮是不是「有工具却宣称没工具」。
 *
 * 只对 managed 模式生效；模型真的调了工具（哪怕调用结果失败）时 `tool_calls`
 * 非空，天然不会进来——那种情况重试也换不来更好的结果。
 */
export function detectToolRefusal(
  result: any,
  plan: ToolCallingPlan | undefined,
  userText?: string,
): ToolRefusalVerdict {
  if (!plan || plan.mode !== 'managed') return verdict(false, [], 'not_managed')
  if (!plan.shouldParseResponse) return verdict(false, [], 'parse_disabled')
  if (!plan.tools || plan.tools.length === 0) return verdict(false, [], 'no_tools')
  if (hasToolCalls(result)) return verdict(false, [], 'has_tool_calls')

  const askingLive = LIVE_QUESTION_PATTERN.test(userText ?? '')
  if (!askingLive) return verdict(false, [], 'not_live_question')

  const text = extractAssistantText(result)
  if (!text.trim()) return verdict(false, [], 'empty_text')
  const lower = text.toLowerCase()

  const matched = TOOL_REFUSAL_MARKERS.filter((marker) => lower.includes(marker.toLowerCase()))
  if (matched.length === 0) return verdict(false, [], 'clean')

  const hasInformativeTool = plan.tools.some((tool) => INFORMATIVE_TOOL_PATTERN.test(baseToolName(tool.name)))
  if (!hasInformativeTool) return verdict(false, matched, 'no_informative_tool')

  return verdict(true, matched, 'tool_refusal')
}

/**
 * 「只说不做」兜底（v1.7.3）
 *
 * 背景：让 Kimi 建一个 Word 文档，它回一句「让我尝试使用 python-docx 创建这个文档。
 * 首先检查当前目录，然后尝试用 Python 创建文件：」——然后就没了。这一轮 parsed=0，
 * 客户端把这句当最终回答，回合直接结束，用户必须再敲一句「继续」它才动。
 *
 * 根因在托管协议的形态：没有原生 function calling，模型必须主动写出
 * `[function_calls]…[/function_calls]` 才算一次工具调用。一旦它切回「聊天人格」，
 * 就会把行动计划当回答输出，看上去就是「干到一半断了」。
 *
 * 判定要同时满足（保守，宁可漏判）：
 *   1. managed 模式、本轮有工具、一个都没调；
 *   2. 用户在下一件具体的事（新建/生成/改/运行…）；
 *   3. 正文不长、没有任何「已完成」字样，且结尾停在「让我 / 接下来 / 首先检查」这类
 *      未完成的过渡句上。
 */
const TASK_REQUEST_PATTERN =
  /(新建|创建|生成|制作|写一|写个|帮我写|改一下|修改|删除|重命名|运行|执行|安装|下载|解压|整理|保存|导出|转换|做一|帮我|create|make|write|generate|build|run|install|download|rename|delete|edit|save|export|convert)/i

/** 结尾停在「准备动手但没动手」的过渡句上。 */
const PLAN_TAIL_PATTERN =
  /(让我|我来|我先|我这就|我马上|接下来|下面我|现在(?:我)?(?:就)?(?:来|去|检查|执行|创建|运行)|首先(?:我)?(?:检查|看|确认|执行)|然后(?:我)?(?:执行|创建|运行|检查)|let me|i'?ll|i will|first,? i|next,? i|now i)\s*[^\n。.!！?？]{0,50}\s*$/i

/** 已经给出结果的说法，出现就不算「只说不做」。 */
const COMPLETED_PATTERN =
  /(已完成|已创建|已生成|已保存|已修改|已删除|已执行|创建成功|成功创建|保存成功|完成[了。！!]|done|completed|successfully|finished)/i

export function detectPlanOnlyTurn(
  result: any,
  plan: ToolCallingPlan | undefined,
  userText?: string,
): ToolRefusalVerdict {
  if (!plan || plan.mode !== 'managed') return verdict(false, [], 'not_managed')
  if (!plan.shouldParseResponse) return verdict(false, [], 'parse_disabled')
  if (!plan.tools || plan.tools.length === 0) return verdict(false, [], 'no_tools')
  if (hasToolCalls(result)) return verdict(false, [], 'has_tool_calls')
  if (!TASK_REQUEST_PATTERN.test(userText ?? '')) return verdict(false, [], 'not_task_request')

  const text = extractAssistantText(result).trim()
  if (!text) return verdict(false, [], 'empty_text')
  if (text.length > 400) return verdict(false, [], 'too_long')
  if (COMPLETED_PATTERN.test(text)) return verdict(false, [], 'claims_completed')

  const tail = text.slice(-120)
  if (!PLAN_TAIL_PATTERN.test(tail)) return verdict(false, [], 'clean')

  return verdict(true, [tail.slice(-40)], 'plan_only')
}

/** 环境变量 `AFS_DISABLE_PLAN_ONLY_RETRY=1` 可关掉兜底。默认开启。 */
export function isPlanOnlyRetryEnabled(): boolean {
  return process.env.AFS_DISABLE_PLAN_ONLY_RETRY !== '1'
}

/**
 * 重试时追加的纠偏消息。
 *
 * 只重发一模一样的 messages，模型有很高概率再犯一次同样的错（同样的输入 → 同样的
 * 输出分布）。所以重试必须换掉上下文里的一句话，明确告诉它：上一轮错在哪、现在
 * 必须发出调用块。
 */
function callFormatHint(protocol: ToolProtocolId | undefined): string {
  if (protocol === 'managed_xml') {
    return '<tool_call>{"name":"工具名","arguments":{...}}</tool_call>'
  }
  return '[function_calls]\n[call:工具名]{"参数":"值"}[/call]\n[/function_calls]'
}

export function planOnlyNudge(protocol?: ToolProtocolId): string {
  return [
    '（系统纠偏，不是用户提问）你上一轮把「行动计划」当成最终回答交了出去，实际一个工具调用都没有发出，回合因此被中断，任务停在半路。',
    '现在立刻继续执行，不要复述计划、不要解释打算怎么做、不要等用户确认。',
    '本轮回复只能包含工具调用块，格式：',
    callFormatHint(protocol),
    '先做最小可验证的一步（一条命令或一次文件写入），拿到结果块后再继续下一步，直到任务真正完成。',
  ].join('\n')
}

export function toolRefusalNudge(protocol?: ToolProtocolId): string {
  return [
    '（系统纠偏，不是用户提问）你上一轮回答「没有可用工具」，这是错的：本轮的完整工具清单就在上文 system 里，shell、文件读写、web_fetch 等工具你都可以调用。',
    '不要建议用户自己去搜索，也不要声称无法联网。请直接调用工具取数据，格式：',
    callFormatHint(protocol),
    '需要实时信息就用 web_fetch 打开一个具体网址；需要本地信息就用 shell 或文件工具。拿到结果后再回答。',
  ].join('\n')
}

export function sandboxNudge(protocol?: ToolProtocolId): string {
  return [
    '（系统纠偏，不是用户提问）你上一轮跑到了服务端的 python 沙箱里，把 /mnt/data、/mnt/agents 这类沙箱目录当成了用户机器的目录，那份回答是错的。',
    '这里没有可用的代码沙箱，文件和命令都在用户本机执行。请只使用上文 system 里列出的工具，格式：',
    callFormatHint(protocol),
    '要看目录就用文件/命令工具列出真实路径；要读文件就直接读。不要输出 /mnt 下的任何路径。',
  ].join('\n')
}
