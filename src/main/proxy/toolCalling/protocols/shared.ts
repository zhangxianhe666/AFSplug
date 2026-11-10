import type { NormalizedToolDefinition, NormalizedToolResult, ToolParseResult, ToolProtocolId } from '../types.ts'
import type { ToolProtocolDetection } from './base.ts'
import type { ToolCall } from '../../types.ts'

export function detectMarkers(buffer: string, markers: string[]): ToolProtocolDetection {
  let earliest = -1
  for (const marker of markers) {
    const index = buffer.indexOf(marker)
    if (index !== -1 && (earliest === -1 || index < earliest)) {
      earliest = index
    }
  }

  if (earliest !== -1) {
    return { matched: true, partial: false, markerStart: earliest }
  }

  for (let index = 0; index < buffer.length; index += 1) {
    const suffix = buffer.slice(index)
    if (markers.some((marker) => marker.startsWith(suffix))) {
      return { matched: false, partial: true, markerStart: index }
    }
  }

  return { matched: false, partial: false }
}

export function stripFencedCodeBlocks(content: string): string {
  return content.replace(/```[\s\S]*?```/g, '')
}

export function toolNames(tools: NormalizedToolDefinition[]): Set<string> {
  return new Set(tools.map((tool) => tool.name))
}

/** 规范化工具名用于模糊比较：小写 + 去下划线/连字符/冒号。冒号是命名空间分隔符（如
 * `namespace:tool`），模型常丢失它，故比较时忽略。 */
function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[_\-:]/g, '')
}

/**
 * 解析模型输出的工具名到已注册工具名。
 *
 * 精确匹配优先；失败时做模糊匹配（去下划线/连字符、大小写不敏感、子串包含），
 * 自动纠正模型的轻微幻觉（如 `run_bash` → `bash`、`Bash` → `bash`）。参考 Flask
 * tool gateway 的 `_fuzzy_match_tool`。返回修正后的注册名，无法匹配时返回 null。
 *
 * @param name - 模型输出的工具名（原始形态）
 * @param allowedNames - 已注册工具名集合
 * @returns 匹配到的注册工具名；无匹配返回 null
 */
export function resolveToolName(name: string, allowedNames: ReadonlySet<string>): string | null {
  if (allowedNames.has(name)) return name

  const normalized = normalizeToolName(name)
  if (!normalized) return null

  // 1) 去下划线/连字符 + 小写后完全相等
  for (const candidate of allowedNames) {
    if (normalizeToolName(candidate) === normalized) return candidate
  }

  // 2) 前后缀/删尾式幻觉（read_image_full → read_image、subagentf → subagent_fork）。
  //    子串匹配天然有短名误配风险（read ↔ read_image、skill ↔ skillx、
  //    write ↔ todo_write、browser ↔ browser_*），因此仅对较长的候选名（≥6 字符）
  //    启用子串规则；短工具名（bash/read/write/edit/glob/grep/skill/ralph 等）只走
  //    上面的精确 + 去分隔符匹配。
  const cands = [...allowedNames]
  // 2a) 模型名较短、是候选名的删尾前缀（read_image_full 的候选侧不在此；此处是
  //     subagentf → subagent_fork 这类）。若多个候选共享该前缀（browser →
  //     browser_auth/browser_click/...），歧义无法消解 → 拒绝。
  {
    const matches: string[] = []
    for (const candidate of cands) {
      const cn = normalizeToolName(candidate)
      if (cn.length < 6) continue
      if (cn.length > normalized.length && (cn.startsWith(normalized) || cn.endsWith(normalized))) {
        matches.push(candidate)
      }
    }
    if (matches.length === 1) return matches[0]!
    // 多个候选共享前缀（歧义）→ 不匹配；但若其中一个是"最短唯一"也难判断，直接拒绝
    if (matches.length > 1 && normalized.length >= 6) {
      // 仍可能是有效删尾（如 browser_reset → browser_reset_session 唯一）——此处
      // 无法区分，保守处理：若所有匹配共享同一更长后缀则不在此拒绝。
      // 为简单可靠：多个删尾候选时拒绝。
      return null
    }
  }
  // 2b) 模型名较长、以某候选名为前缀/后缀（模型加了动词/后缀）。取规范化后最长的
  //     唯一候选；多个候选同长（subagent_fork_extra 同时是 subagent 与 subagent_fork
  //     的扩展，均长 17）→ 歧义拒绝。
  {
    let best: string | undefined
    let bestLen = -1
    let bestCount = 0
    for (const candidate of cands) {
      const cn = normalizeToolName(candidate)
      if (cn.length < 6) continue
      if (normalized.length > cn.length && (normalized.startsWith(cn) || normalized.endsWith(cn))) {
        if (cn.length > bestLen) {
          bestLen = cn.length
          best = candidate
          bestCount = 1
        } else if (cn.length === bestLen) {
          bestCount += 1
        }
      }
    }
    if (bestCount === 1) return best ?? null
  }

  return null
}

export function createParseResult(input: {
  content: string
  toolCalls: ToolCall[]
  protocol: ToolProtocolId | 'unknown'
  rawMatches: string[]
  invalidToolNames?: string[]
  malformedReason?: string
}): ToolParseResult {
  return {
    content: input.content,
    toolCalls: input.toolCalls,
    protocol: input.protocol,
    rawMatches: input.rawMatches,
    malformedReason: input.malformedReason,
    invalidToolNames: input.invalidToolNames ?? [],
  }
}

export function buildToolCall(
  id: string,
  index: number,
  name: string,
  args: string,
  rawText?: string,
): ToolCall {
  return {
    id,
    index,
    type: 'function',
    function: {
      name,
      arguments: normalizeArguments(args),
    },
    ...(rawText ? { rawText } : {}),
  } as ToolCall
}

export function normalizeArguments(args: unknown): string {
  if (typeof args === 'string') {
    const trimmed = args.trim()
    if (!trimmed) return '{}'
    try {
      return JSON.stringify(JSON.parse(trimmed))
    } catch {
      return trimmed
    }
  }

  return JSON.stringify(args ?? {})
}

export function parseJsonValue(value: string): unknown {
  const trimmed = unwrapCdata(value).trim()
  if (!trimmed) return ''

  try {
    return JSON.parse(trimmed)
  } catch {
    return decodeXml(trimmed)
  }
}

export function unwrapCdata(value: string): string {
  const cdata = value.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/)
  return cdata ? cdata[1] : value
}

export function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function addParameter(target: Record<string, unknown>, name: string, value: unknown): void {
  const existing = target[name]
  if (existing === undefined) {
    target[name] = value
  } else if (Array.isArray(existing)) {
    target[name] = [...existing, value]
  } else {
    target[name] = [existing, value]
  }
}

/** 工具名 → 参数 JSON Schema 的索引，供参数归一化查询。 */
export function toolSchemaMap(
  tools: NormalizedToolDefinition[],
): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>()
  for (const tool of tools) {
    if (tool?.name) map.set(tool.name, (tool.parameters ?? {}) as Record<string, unknown>)
  }
  return map
}

/** 数组类参数在模型输出里常用的单数/同义写法，用于回填数组字段。 */
const ARRAY_ALIASES = ['query', 'queries', 'q', 'search', 'keyword', 'keywords', 'urls', 'url']

function coerceToArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value.length > 0 ? value : null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  // 模型常把数组写成 JSON 字符串（`["a","b"]`），先尝试还原
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed) && parsed.length > 0) return parsed
    } catch {
      // 无法还原则退化为单元素数组
    }
  }
  return [trimmed]
}

function defaultForType(type: unknown): unknown {
  switch (type) {
    case 'array':
      return []
    case 'boolean':
      return false
    case 'number':
    case 'integer':
      return 0
    default:
      return ''
  }
}

/**
 * 按工具的 JSON Schema 归一化模型解析出的参数。
 *
 * 为什么需要：协议层原先只做「能 JSON.parse 就 parse，否则当字符串」，不查 schema。
 * 实测 GLM-5.3 因此连续三次调用被客户端挡下：
 *   - 参数标签没被识别 → `args={}` → `missing required property "queries"`
 *   - 数组被写成字符串 `"[...]"` → `"queries" must be an array`
 * 归一化后自动做类型纠正与必填补齐，避免整轮工具调用白白浪费。
 *
 * 规则：
 * 1. 数组字段：字符串（含 JSON 字符串）→ 数组；空值尝试从同义单数字段回填
 * 2. 字符串字段：单元素数组 → 该元素
 * 3. 数字/布尔字段：可解析的字符串 → 对应类型
 * 4. 必填缺失 → 按类型补合理默认值
 * 5. 删除 schema 未声明的参数（仅当 schema 明确列出 properties 时）
 *
 * @param args - 已解析的参数对象
 * @param schema - 该工具的 parameters JSON Schema
 * @param toolName - 工具名（仅用于日志）
 * @returns 归一化后的新对象；无 schema 时原样返回
 */
export function normalizeToolArguments(
  args: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
  toolName: string,
): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return args
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
  if (Object.keys(props).length === 0 && required.length === 0) return args

  const out: Record<string, unknown> = { ...args }

  // 1) 类型纠正
  for (const [prop, spec] of Object.entries(props)) {
    if (!spec || typeof spec !== 'object') continue
    const type = spec.type
    const value = out[prop]

    if (type === 'array') {
      const coerced = coerceToArray(value)
      if (coerced) {
        if (!Array.isArray(value)) {
          console.log(`[toolArgs] ${toolName}.${prop}: 非数组 → 已纠正为数组`)
        }
        out[prop] = coerced
        continue
      }
      // 值为空：尝试从同义单数字段回填（如 queries ← query）
      let filled: unknown[] | null = null
      for (const alias of ARRAY_ALIASES) {
        if (alias === prop || out[alias] === undefined) continue
        filled = coerceToArray(out[alias])
        if (filled) break
      }
      if (filled) {
        out[prop] = filled
        console.log(`[toolArgs] ${toolName}.${prop}: 缺失/空 → 已从同义字段回填`)
      } else if (value !== undefined) {
        out[prop] = []
      }
      continue
    }

    if (value === undefined) continue

    if (type === 'string' && Array.isArray(value) && value.length === 1) {
      out[prop] = typeof value[0] === 'string' ? value[0] : String(value[0])
      console.log(`[toolArgs] ${toolName}.${prop}: 单元素数组 → 已解包为字符串`)
    } else if ((type === 'number' || type === 'integer') && typeof value === 'string') {
      const num = Number(value.trim())
      if (value.trim() !== '' && Number.isFinite(num)) {
        out[prop] = type === 'integer' ? Math.trunc(num) : num
        console.log(`[toolArgs] ${toolName}.${prop}: 字符串 → 已转为数字`)
      }
    } else if (type === 'boolean' && typeof value === 'string') {
      const lowered = value.trim().toLowerCase()
      if (lowered === 'true' || lowered === 'false') {
        out[prop] = lowered === 'true'
        console.log(`[toolArgs] ${toolName}.${prop}: 字符串 → 已转为布尔`)
      }
    }
  }

  // 2) 必填补齐
  for (const prop of required) {
    const value = out[prop]
    const missing =
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0)
    if (!missing) continue
    const spec = props[prop] ?? {}
    out[prop] = defaultForType(spec.type)
    console.log(`[toolArgs] ${toolName}: 缺少必填 '${prop}' → 已按类型补默认值`)
  }

  // 3) 删除 schema 未声明的参数（模型常额外编造同义字段）
  if (Object.keys(props).length > 0) {
    for (const key of Object.keys(out)) {
      if (!(key in props)) {
        delete out[key]
        console.log(`[toolArgs] ${toolName}: 删除未声明参数 '${key}'`)
      }
    }
  }

  return out
}

/** 模型用的占位参数名（argument1 / arg1 / args …），需要映射回真实的必填参数。 */
const PLACEHOLDER_PARAM_NAMES = new Set([
  'argument', 'arguments', 'argument1', 'argument2', 'arg', 'arg1', 'arg2',
  'param', 'param1', 'parameter', 'parameter1', 'value', 'input',
])

/**
 * 把占位参数名映射到 schema 中唯一的必填参数（或唯一参数）。
 *
 * 实测：模型会输出 `{"argument1":"ls /tmp"}` 或 `<parameter name="argument1">`，
 * 参数名对不上声明，归一化时被当作未声明字段删除、再补成空串，工具拿到的是空参数。
 * 只在「目标唯一」时映射，避免把多参数工具猜错。
 */
export function remapPlaceholderParams(
  args: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
  toolName: string,
): void {
  if (!schema || typeof schema !== 'object') return
  const props = Object.keys((schema.properties ?? {}) as Record<string, unknown>)
  if (props.length === 0) return

  const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
  const targets = required.length === 1 ? required : props.length === 1 ? props : []
  if (targets.length !== 1) return
  const target = targets[0]!

  for (const key of Object.keys(args)) {
    if (props.includes(key)) continue
    if (!PLACEHOLDER_PARAM_NAMES.has(key.toLowerCase())) continue
    if (args[target] !== undefined) {
      delete args[key]
      continue
    }
    const value = args[key]
    delete args[key]
    if (value === undefined || value === '') continue
    args[target] = value
    console.log(`[toolArgs] ${toolName}: 占位参数 '${key}' → 已映射为 '${target}'`)
  }
}

/** 工具清单超过该长度就改用紧凑渲染（见 renderToolListCompact）。 */
const TOOL_LIST_COMPACT_THRESHOLD = 6000

/**
 * 渲染工具清单（完整版）：带完整 JSON schema。
 *
 * 注意：工具多的时候全量 schema 会把 system 撑到 40KB+（实测 40 个工具 =
 * 41,390 字符），模型要读一万多字符才轮到真正要用的工具，注意力被严重稀释，
 * 表现为「有工具却不用、反而说工具不可用」。因此由 renderToolList 按体量自动
 * 降级到紧凑渲染。
 */
function renderToolListFull(tools: NormalizedToolDefinition[]): string {
  return tools
    .map((tool) => {
      const parameters = JSON.stringify(tool.parameters ?? {})
      return `Tool \`${tool.name}\`: ${sanitizeToolDescription(tool.description)}. Arguments JSON schema: ${parameters}`
    })
    .join('\n')
}

/**
 * 渲染工具清单（紧凑版）：`Tool \`name\`(a, b?): 一句话说明`。
 *
 * 保留工具名与参数名（模型调用真正需要的部分），丢掉完整 JSON schema 与冗长
 * 描述。40 个工具可压到 4~6KB，同时把 system 预算还给客户端自己的指令。
 *
 * 必填参数标 `*` 而不是裸写参数名：紧凑版没有 schema，模型分不清哪些参数必填，
 * 实测会给出 `description: ""` 这类空值，被客户端判为非法调用（invalid description:
 * expected a non-empty string），随后模型把「参数填错」误读成「工具不可用」。
 */
function renderToolListCompact(tools: NormalizedToolDefinition[]): string {
  return tools
    .map((tool) => {
      const properties = (tool.parameters?.properties ?? {}) as Record<string, unknown>
      const required = Array.isArray(tool.parameters?.required)
        ? (tool.parameters?.required as string[])
        : []
      const args = Object.keys(properties)
        .map((name) => (required.includes(name) ? `${name}*` : `${name}?`))
        .join(', ')
      const description = sanitizeToolDescription(tool.description)
      const shortDescription =
        description.length > 110 ? `${description.slice(0, 110)}…` : description
      return `Tool \`${tool.name}\`(${args}): ${shortDescription}`
    })
    .join('\n')
}

function sanitizeToolDescription(description?: string): string {
  // Hermes uses "Linux environment" in the terminal tool description even on
  // macOS, which confuses some models.
  return (description || 'No description')
    .replace(/Linux environment/gi, 'local environment')
    .replace(/Linux container/gi, 'local environment')
    .replace(/in a Linux environment/gi, 'in a local environment')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 渲染工具清单：默认完整版，超过阈值自动降级为紧凑版。
 *
 * 阈值存在的原因是实测：40 个工具的全量 schema 有 41,390 字符，system 被撑到
 * 44KB 后 GLM 会「有工具却不用」。降到 6KB 以内后同一批工具能稳定调用。
 */
export function renderToolList(tools: NormalizedToolDefinition[], forceCompact = false): string {
  const full = renderToolListFull(tools)
  if (forceCompact || full.length > TOOL_LIST_COMPACT_THRESHOLD) {
    return renderToolListCompact(tools)
  }
  return full
}

/**
 * 工具结果里的「失败」特征。
 *
 * 背景：客户端工具失败时仍然以 status=completed 回传，失败信息只体现在正文
 * （`Exit Code: 1` / `No such file or directory` / `ModuleNotFoundError` ...）。
 * GLM 这类模型看到「有一段结果」就当成功，会直接回复「已完成 ✅」并捏造路径，
 * 实测导致用户按回复里的路径找不到文件。
 *
 * 因此这里只挑**语义明确指向执行失败**的特征，宁缺勿滥：像 `error` 这种词
 * 在正常输出里也常见（grep 结果、日志内容），不作为判据。
 */
const TOOL_FAILURE_PATTERNS: RegExp[] = [
  /Exit Code:\s*[1-9]\d*/, // 非零退出码（最可靠）
  /Signal:\s*SIG(?:TERM|KILL|SEGV|INT|ABRT)/, // 被信号杀死，如超时 137

  // ── 跨平台一致的运行时错误 ──────────────────────────────
  /ModuleNotFoundError/, // Python
  /Traceback \(most recent call last\)/, // Python
  /Cannot find module/, // Node
  /(?:^|\n)\s*(?:fatal|error):\s/i,

  // ── POSIX（macOS / Linux）────────────────────────────────
  /No such file or directory/,
  /command not found/,
  /Permission denied/,

  // ── Windows ────────────────────────────────────────────
  // 失败文案与 POSIX 完全不同，缺了这几条会导致 Windows 用户的失败结果
  // 不被标注，模型照旧回"已完成 ✅"。中英文系统各一套，都要覆盖。
  // cmd：'python' 不是内部或外部命令，也不是可运行的程序
  /不是内部或外部命令/,
  /is not recognized as an internal or external command/i,
  // PowerShell：无法将"xxx"项识别为 cmdlet …
  /识别为 cmdlet/,
  /is not recognized as the name of a cmdlet/i,
  /CommandNotFoundException/,
  // 文件/路径不存在
  /The system cannot find the file specified/i,
  /The system cannot find the path specified/i,
  /系统找不到指定的文件/,
  /系统找不到指定的路径/,
  // 权限不足
  /\bAccess is denied\b/i,
  /拒绝访问/,
]

export function isToolResultFailure(content: string): boolean {
  if (!content) return false
  return TOOL_FAILURE_PATTERNS.some((pattern) => pattern.test(content))
}

/**
 * 失败结果前置的硬性提示。用英文写是因为 system 提示本身是英文，模型对该语言
 * 下的指令跟随度更稳；同时保留 `[TOOL_ERROR]` 这个可被 prompt 规则引用的锚点。
 */
export const TOOL_FAILURE_BANNER =
  '[TOOL_ERROR] This tool call FAILED. The operation did NOT succeed and nothing was produced. ' +
  'Do not report it as done and do not state any output path as if it exists. ' +
  'Either retry with a corrected command/arguments, or tell the user exactly what failed.'

/** 给失败结果加上失败标记；成功结果原样返回。 */
export function decorateToolResult(content: string): string {
  return isToolResultFailure(content) ? `${TOOL_FAILURE_BANNER}\n${content}` : content
}

/**
 * 把中文/花体引号规范化为 ASCII 引号。
 *
 * 触发场景（实测）：GLM 输出 `<invoke name=“Bash”>` —— 属性值用了全角引号。
 * 严格正则 `<invoke name="([^"]+)"` 匹配不到，整段 XML 既不报错也不解析，
 * 最终作为普通文本透传给客户端，界面表现就是「模型没有调用工具」。
 *
 * 只替换引号类字符，保持字符串长度不变，因此可以在原文与规范化文本之间
 * 按相同下标对齐切片。
 */
const SMART_QUOTE_MAP: Record<string, string> = {
  '\u201c': '"', // 左双引号 “
  '\u201d': '"', // 右双引号 ”
  '\u201e': '"', // 双低引号 „
  '\u201f': '"', // 双高反引号 ‟
  '\u301d': '"', // 〝
  '\u301e': '"', // 〞
  '\u2018': "'", // 左单引号 ‘
  '\u2019': "'", // 右单引号 ’
}

export function normalizeSmartQuotes(value: string): string {
  return value.replace(/[\u201c\u201d\u201e\u201f\u301d\u301e\u2018\u2019]/g, (ch) => SMART_QUOTE_MAP[ch] ?? ch)
}

export function genericToolResultBlock(result: NormalizedToolResult): string {
  return `[TOOL_RESULT for ${result.toolCallId}] ${decorateToolResult(result.content)}`
}
