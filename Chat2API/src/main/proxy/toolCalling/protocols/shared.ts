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
