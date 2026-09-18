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

export function renderToolList(tools: NormalizedToolDefinition[]): string {
  return tools
    .map((tool) => {
      const parameters = JSON.stringify(tool.parameters ?? {})
      // Sanitize tool descriptions — Hermes uses "Linux environment" in the
      // terminal tool description even on macOS, which confuses some models.
      const desc = (tool.description || 'No description')
        .replace(/Linux environment/gi, 'local environment')
        .replace(/Linux container/gi, 'local environment')
        .replace(/in a Linux environment/gi, 'in a local environment')
      return `Tool \`${tool.name}\`: ${desc}. Arguments JSON schema: ${parameters}`
    })
    .join('\n')
}

export function genericToolResultBlock(result: NormalizedToolResult): string {
  return `[TOOL_RESULT for ${result.toolCallId}] ${result.content}`
}
