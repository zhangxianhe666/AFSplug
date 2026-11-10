import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import type { ToolProtocolId } from './types.ts'
import { renderCallExample } from './callExample.ts'

/**
 * 落盘核验（v1.7.4，第一层兜底）
 *
 * 和 hallucinationGuard 里的「话术黑名单」不同，这里不看模型说了什么词，只看**事实**：
 * 它声称写了一个文件，那个文件到底在不在。
 *
 * 为什么需要这一层：GLM / Kimi 走文本注入协议时，经常出现
 *   「已写入 Excel 文件 BU.xlsx」「已保存到 D:\xx\report.md」
 * 而实际上一个 tool_call 都没发。此时无论它用哪种措辞，文件系统都是同一个答案——
 * 不存在。所以存在性是**唯一不会被新话术绕过**的判据。
 *
 * 设计上的四条保守约束（避免误伤，也避免引入新的假阳性）：
 *
 * 1. 必须出现「创建/写入类断言」动词才判定。只是提到路径（示例、建议、代码块）不算。
 * 2. 只有**父目录存在**的路径才允许判定为「假」。父目录也不存在时，可能是远程客户端
 *    （AFS 与客户端不同机）或还没创建的深层目录，此时判 unverifiable，一律不重试。
 * 3. 目标文件**已存在**一律视为成功（幂等），绝不重试——否则重试会导致重复干活。
 * 4. 路径根在本机不存在（如 Windows 上的 /mnt/data）只记日志、不重试。这类是沙箱
 *    泄漏的典型特征，但单独一条不足以证明模型在瞎说（可能只是在举例），先观察。
 *
 * 环境变量：
 *   AFS_DISABLE_GROUNDING=1   关闭核验（回到旧行为）
 *   AFS_GROUNDING_DRYRUN=1    只记日志，不触发重试（灰度观察用）
 */

export type GroundingReason =
  | 'has_tool_calls'      // 真的调了工具，不做判定
  | 'no_text'             // 没有正文
  | 'no_claim'            // 没有创建类断言
  | 'no_target'           // 有断言但提取不到可核验的目标（相对路径且不知道工作目录等）
  | 'verified'            // 声称的文件确实存在
  | 'idempotent_ok'       // 目标已存在（可能上一轮就写好了），视为成功
  | 'missing_target'      // 声称写了，父目录在，文件不在 → 判假
  | 'unverifiable'        // 父目录不在 / 远程客户端 / 路径不完整，无法核验
  | 'alien_root'          // 路径根在本机不存在（沙箱泄漏特征），v1 只记日志

export interface GroundingVerdict {
  /** 是否判为「谎报落盘」并建议重open一轮。 */
  retry: boolean
  reason: GroundingReason
  /** 提取到的目标路径（用于日志）。 */
  targets: string[]
  /** 断言存在、实际不存在的路径。 */
  missing: string[]
  /** 存在但修改时间明显早于本轮（疑似旧文件），仅日志。 */
  stale: string[]
  /** 根目录在本机不存在的路径（沙箱特征），仅日志。 */
  alien: string[]
}

export interface GroundingOptions {
  /** 本轮请求的 messages，用于提取工作目录。 */
  messages?: Array<{ role?: string; content?: unknown }>
  /** 判定「旧文件」的时间窗，默认 30 分钟。 */
  staleWindowMs?: number
  /** 当前时间，测试可注入。 */
  now?: number
}

/** 创建 / 写入类断言。只有命中这些动词，才会去核验路径。 */
const CREATION_CLAIM =
  /(?:已(?:经)?(?:成功|顺利)?(?:写入|写进|写到|创建|新建|生成|保存|存到|放到|导出|建好|写好|做好)|写入(?:到|至|了)|保存(?:到|为|至|了)|(?:创建|新建|生成)了|已(?:经)?(?:成功|顺利)?(?:创建|生成|写入)|导出到|保存成功|写入成功|创建成功|生成成功|created|saved|written|exported)/i

/** 文件后缀白名单：只核验「产物类」路径，避免把日志行、目录当目标。 */
const ARTIFACT_EXT = /\.(?:xlsx|xlsm|xls|csv|tsv|docx|doc|pptx|ppt|pdf|txt|md|json|ya?ml|py|js|ts|tsx|java|go|rs|html|htm|css|sh|ps1|zip|tar|gz|png|jpe?g|svg|mp4|wav)$/i

/** 绝对路径：Windows 盘符 或 POSIX。 */
const WIN_ABS = /(?:^|[\s("'`[（【:：,，=])([A-Za-z]:[\\/][^\s"'`<>|*?\r\n()（）[\]【】]*)/g
const POSIX_ABS = /(?:^|[\s("'`[（【:：,，=])(\/{1}[^\s"'`<>|*?\r\n()（）[\]【】]*)/g

/** 工作目录声明（我们自己的客户端注入格式，格式稳定）。 */
const WORKDIR_PATTERNS = [
  /working directory\s*[:：]\s*([^\n\r]+)/i,
  /(?:当前)?工作目录\s*[:：]\s*([^\n\r]+)/,
  /\bcwd\s*[:：]\s*([^\n\r]+)/i,
]

function envFlag(name: string): boolean {
  return process.env[name] === '1'
}

export function isGroundingEnabled(): boolean {
  return !envFlag('AFS_DISABLE_GROUNDING')
}

/** 灰度模式：只记日志，不重试。 */
export function isGroundingDryRun(): boolean {
  return envFlag('AFS_GROUNDING_DRYRUN')
}

function trimTrailing(raw: string): string {
  return raw.replace(/[.,;:!?，。；：、）)\]】》"']+$/, '').trim()
}

function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p)
}

/** 示例路径里常见的占位目录名，命中即认为是示范而非真实目标。 */
const PLACEHOLDER_SEGMENTS = new Set(['path', 'to', 'your', 'xxx', 'example', 'foo', 'bar'])

function hasPlaceholderSegment(p: string): boolean {
  return p
    .split(/[\\/]+/)
    .map((segment) => segment.toLowerCase())
    .some((segment) => PLACEHOLDER_SEGMENTS.has(segment))
}

/** 明显不是真实路径的片段：占位符、通配符、URL、过短。 */
function looksUsable(p: string): boolean {
  if (!p || p.length < 4) return false
  if (p.includes('://')) return false
  if (/[<>{}*?]|\$\{|\bxxx\b|\.\.\.|…/.test(p)) return false
  if (/^https?:/i.test(p)) return false
  if (hasPlaceholderSegment(p)) return false
  return true
}

/** 从一段文本里提取绝对路径。 */
export function extractAbsolutePaths(text: string): string[] {
  if (!text) return []
  const found: string[] = []
  for (const re of [WIN_ABS, POSIX_ABS]) {
    re.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = re.exec(text)) !== null) {
      // 被通配符截断的片段（如 C:\tmp\*.log）不是真实文件，直接丢弃
      const endInText = match.index + match[0].length
      const nextChar = text[endInText] ?? ''
      if (nextChar === '*' || nextChar === '<') continue
      const raw = trimTrailing(match[1] ?? '')
      if (!looksUsable(raw)) continue
      found.push(raw)
    }
  }
  return Array.from(new Set(found))
}

/** 从 messages 里找工作目录（只认我们自己的注入格式，找不到就返回 null）。 */
export function findWorkspaceRoot(
  messages?: Array<{ role?: string; content?: unknown }>,
): string | null {
  if (!Array.isArray(messages)) return null
  for (const message of messages.slice(0, 4)) {
    const content = message?.content
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((part: any) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('\n')
          : ''
    if (!text) continue
    for (const pattern of WORKDIR_PATTERNS) {
      const match = text.match(pattern)
      if (!match?.[1]) continue
      const candidate = trimTrailing(match[1].replace(/[\\/]+$/, ''))
      if (looksUsable(candidate)) return candidate
    }
  }
  return null
}

/** 取断言动词之后的一段文本（只看紧邻窗口，避免把后文的示例当成目标）。 */
function claimWindows(text: string): string[] {
  const windows: string[] = []
  const re = new RegExp(CREATION_CLAIM.source, 'gi')
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    windows.push(text.slice(match.index, match.index + 240))
    // 零宽匹配保护：断言都是定长词，不会为零，但保持一致习惯
    if (match[0].length === 0) re.lastIndex += 1
  }
  return windows
}

/** 从断言窗口里提取「裸文件名」（如 **BU.xlsx**），用于拼到工作目录下核验。 */
function extractBareFilenames(window: string): string[] {
  const names: string[] = []
  const re = /[`"'*【\s（(]*([\w\u4e00-\u9fa5][\w\u4e00-\u9fa5.\-（）() ]{0,60}?\.(?:xlsx|xlsm|xls|csv|tsv|docx|doc|pptx|ppt|pdf|txt|md|json|ya?ml|py|js|ts|html|htm|zip|png|jpe?g|svg))/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(window)) !== null) {
    const name = (match[1] ?? '').trim()
    if (name.length === 0) { re.lastIndex += 1; continue }
    if (!ARTIFACT_EXT.test(name)) continue
    if (name.includes('/') || name.includes('\\')) continue
    names.push(name)
  }
  return names.slice(0, 4)
}

interface PathState {
  target: string
  exists: boolean
  parentExists: boolean
  alien: boolean
  mtimeMs: number | null
}

function inspect(target: string): PathState {
  const win = isWindowsPath(target)
  const alien = win ? process.platform !== 'win32' : process.platform === 'win32'
  if (alien) {
    return { target, exists: false, parentExists: false, alien: true, mtimeMs: null }
  }
  let exists = false
  let mtimeMs: number | null = null
  try {
    const stat = statSync(target)
    exists = stat.isFile()
    mtimeMs = stat.mtimeMs
  } catch {
    exists = false
  }
  const dir = win ? path.win32.dirname(target) : path.posix.dirname(target)
  const parentExists = !!dir && dir !== target && existsSync(dir)
  return { target, exists, parentExists, alien: false, mtimeMs }
}

function emptyVerdict(reason: GroundingReason): GroundingVerdict {
  return { retry: false, reason, targets: [], missing: [], stale: [], alien: [] }
}

/**
 * 判定这一轮是否「谎报落盘」。
 *
 * 只有一条路径会触发重试：命中创建类断言 + 目标路径可核验（父目录存在）+ 文件不存在。
 */
export function detectFalseFileClaim(result: any, options: GroundingOptions = {}): GroundingVerdict {
  const calls = result?.choices?.[0]?.message?.tool_calls
  if (Array.isArray(calls) && calls.length > 0) return emptyVerdict('has_tool_calls')

  const content = result?.choices?.[0]?.message?.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part: any) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('\n')
        : ''
  if (!text.trim()) return emptyVerdict('no_text')
  if (!CREATION_CLAIM.test(text)) return emptyVerdict('no_claim')

  const workspace = findWorkspaceRoot(options.messages)
  const windows = claimWindows(text)

  // 逐个断言窗口提取目标：
  //   - 窗口里有绝对路径，就只认绝对路径（再从最后一段拼工作目录会造出幽灵目标，
  //     已存在的文件会被判成「不存在」，反而触发误重试）
  //   - 窗口里只有裸文件名，才用工作目录补全（BU 那类回复不带绝对路径）
  const workspaceIsAlien = !!workspace && (isWindowsPath(workspace) ? process.platform !== 'win32' : process.platform === 'win32')
  const absolute: string[] = []
  const resolved: string[] = []
  for (const window of windows) {
    const abs = extractAbsolutePaths(window)
    if (abs.length > 0) {
      absolute.push(...abs)
      continue
    }
    if (!workspace || workspaceIsAlien || !looksUsable(workspace)) continue
    for (const name of extractBareFilenames(window)) {
      resolved.push(
        isWindowsPath(workspace) ? path.win32.join(workspace, name) : path.posix.join(workspace, name),
      )
    }
  }

  const targets = Array.from(new Set([...absolute, ...resolved])).filter((p) => ARTIFACT_EXT.test(p))
  if (targets.length === 0) return emptyVerdict(absolute.length > 0 ? 'no_target' : 'no_target')

  const now = options.now ?? Date.now()
  const staleWindow = options.staleWindowMs ?? 30 * 60 * 1000

  const states = targets.map(inspect)
  const alien = states.filter((s) => s.alien).map((s) => s.target)
  const present = states.filter((s) => !s.alien && s.exists)
  const missing = states.filter((s) => !s.alien && !s.exists && s.parentExists).map((s) => s.target)
  const unverifiable = states.filter((s) => !s.alien && !s.exists && !s.parentExists)
  const stale = present
    .filter((s) => s.mtimeMs !== null && now - (s.mtimeMs as number) > staleWindow)
    .map((s) => s.target)

  const base: GroundingVerdict = {
    retry: false,
    reason: 'verified',
    targets: states.map((s) => s.target),
    missing,
    stale,
    alien,
  }

  // 幂等优先：只要有一个目标已存在，就认为工作确实落地过，不重试。
  if (present.length > 0) {
    return { ...base, reason: stale.length === present.length ? 'idempotent_ok' : 'verified' }
  }

  if (missing.length > 0) {
    if (!isGroundingEnabled() || isGroundingDryRun()) {
      return { ...base, retry: false, reason: 'missing_target' }
    }
    return { ...base, retry: true, reason: 'missing_target' }
  }

  if (alien.length > 0) return { ...base, reason: 'alien_root' }
  if (unverifiable.length > 0) return { ...base, reason: 'unverifiable' }
  return { ...base, reason: 'no_target' }
}

/** 纠偏文案：只写正向动作 + 可直接复制的调用块，不写否定句、不点名禁止物。 */
export function groundingNudge(targets: string[], protocol?: ToolProtocolId): string {
  const target = targets[0]
  // 16:02 现场：纠偏里写的是 <tool_call>{…}</tool_call>，而托管 XML 协议只认
  // <tool_calls><invoke …>，模型照抄也解析不出来。示例必须由协议渲染。
  //
  // 二进制格式另给一条可直接改的 python 命令：write 是文本写入，写 .xlsx 得到的
  // 是损坏文件，模型照做也会被打开时报错。
  const binaryTarget = /\.(xlsx|xls|xlsm|docx|pptx)$/i.test(target ?? '')
  const hint = binaryTarget
    ? renderCallExample(
        'pwsh',
        {
          command: `python -c "from openpyxl import Workbook;wb=Workbook();ws=wb.active;ws.append(['列1','列2']);wb.save(r'${target}')"`,
          description: '用 openpyxl 生成 Excel 文件',
        },
        protocol,
      )
    : renderCallExample(
        'write',
        { path: target ?? '<目标文件的绝对路径>', content: '<表格内容>' },
        protocol,
      )
  const lines = [
    '（系统纠偏，不是用户提问）你上一轮回复说文件已经生成，但磁盘上这个路径此刻不存在。',
  ]
  if (target) lines.push(`目标路径：${target}`)
  lines.push(
    '原因不是权限或沙箱：shell 与文件工具在同一台机器、同一个文件系统上，写工作区是允许的。上一轮只是没有真正发出写文件的调用。',
    '这一轮不要重述表格内容、不要解释流程，只输出一个工具调用块，把内容写进目标文件。',
    // write 是文本写入：直接写 .xlsx/.docx 会得到损坏文件，打开即报错。
    // 必须走 python 生成真正的二进制工作簿。
    '目标若是 .xlsx/.xls/.docx 这类二进制格式，用 shell 调用 python 生成（Excel 用 openpyxl，Word 用 python-docx），不要用 write 把文本直接写进去——那样文件打开会报错。',
    '路径含空格或中文时用引号包住整个路径。',
    '内容较多可以分段：先建工作簿并写入表头与前几行，再用 shell 追加后续行，不必一次生成全部。',
    '写完用 shell 列一次目标目录确认文件存在，再回报真实路径。',
    '调用格式：',
    hint,
  )
  return lines.join('\n')
}
