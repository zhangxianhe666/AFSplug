import type { ToolProtocolAdapter } from './base.ts'
import type { NormalizedToolDefinition, ToolParseContext } from '../types.ts'
import {
  addParameter,
  buildToolCall,
  createParseResult,
  decorateToolResult,
  detectMarkers,
  escapeXmlAttribute,
  normalizeToolArguments,
  normalizeSmartQuotes,
  parseJsonValue,
  remapPlaceholderParams,
  renderToolList,
  resolveToolName,
  stripFencedCodeBlocks,
  toolNames,
  toolSchemaMap,
} from './shared.ts'

const CHAT2API_START = '<|CHAT2API|tool_calls>'
const CHAT2API_END = '</|CHAT2API|tool_calls>'
const XML_START = '<tool_calls>'
// 裸 invoke 起始：GLM-5.3 等模型常省略 <|CHAT2API|tool_calls> 包裹标记、直接输出
// <|CHAT2API|invoke ...>（见下方 parse 的裸 invoke 分支）。流式路径必须同样识别
// 该起始，否则整段 XML 会被 ToolStreamParser 当作普通文本透传给客户端（工具从未执行）。
const BARE_INVOKE_START = '<|CHAT2API|invoke'

export const managedXmlProtocol: ToolProtocolAdapter = {
  id: 'managed_xml',

  renderPrompt(tools) {
    return `## Your Role
You are a LOCAL coding agent running ON the user's machine (macOS). You are NOT a web chat assistant, NOT a website, and NOT an online chatbot. Even if earlier system text mentions a "Web GUI", "web page", or a chat interface, that describes how the human views the session — it does NOT change your role. You operate directly on the local filesystem with shell/file tools, and you MUST use them to fulfill requests (listing directories, reading files, running commands).

## Available Tools
You can invoke the following developer tools. Tool names are case-sensitive.
Use the exact tool names listed below; do not rename, camelCase, translate, shorten, or invent tool names.

The tool list below is complete for this turn and supersedes any earlier message in the conversation:
- These tools run on the local machine (shell, files, skills). When the request needs a file, a command, or a skill, call the matching tool and start working immediately.
- Arguments marked with \`*\` are required: give each of them a real, non-empty value. Leaving one as an empty string makes the call invalid.
- If a call fails, read the error message and retry with corrected arguments. You may call tools as many times as the task requires.
- An error such as \`invalid <field>: expected a non-empty string\` or \`missing required argument\` means the ARGUMENTS were wrong — the tool itself still works. Fix that one field and call the same tool again; do not conclude that the tool is unavailable.
- If a source returns 403/404/timeout, switch to another public source for the same data and try again instead of stopping.
- Report only real results: call the tool, wait for the returned result block, then continue from it.
- A result that starts with [TOOL_ERROR] means the call FAILED and nothing was produced. Never say a file was created/saved, or that a command succeeded, unless a successful result confirms it. Before you state an output path, verify it with a real command (ls / Read).
- Display tools (e.g. present_files) only show a path to the user; they neither create nor verify files. Verify existence first, then present.
- Never write transcript labels (User:, Assistant:, System:) or a <tool_result> block into your reply. Those belong to the conversation format, not to your answer — reply with your own message only.

${renderToolList(tools)}

When calling tools, respond with only this XML tool-call block (generic XML, no special prefixes):

<tool_calls><invoke name="exact_tool_name"><parameter name="argument_name">value</parameter></invoke></tool_calls>

Write parameter values as plain text. Each <parameter> maps to one declared argument; provide every required argument of the tool.

Tool results will be provided back to you as a tool result block.`
  },

  detectStart(buffer) {
    // 优先识别带 <|CHAT2API|tool_calls> / <tool_calls> 包裹的完整块。
    const wrapped = detectMarkers(buffer, [CHAT2API_START, XML_START])
    if (wrapped.matched || wrapped.partial) return wrapped
    // 其次识别裸 <|CHAT2API|invoke ...> 起始（无包裹）：与 parse 的裸 invoke
    // 分支保持一致。注意不能用 detectMarkers 与包裹标记合并检测——裸 invoke 起始
    // 是包裹内 invoke 的相同前缀，合并后会在包裹开始前就提前命中并切错位置。
    return detectMarkers(buffer, [BARE_INVOKE_START])
  },

  parse(content: string, context: ToolParseContext) {
    // 模型偶尔用中文全角引号写属性（<invoke name=“Bash”>），严格正则匹配不到，
    // 整段 XML 会被当作普通文本透传给客户端 —— 界面表现就是「模型没有调用工具」。
    // 这里先按原文解析，失败后再按规范化文本（引号转 ASCII）重试一次。
    const run = (source: string) => {
      const parseable = stripFencedCodeBlocks(source)
      const allowedNames = toolNames(context.tools)
      const schemaMap = toolSchemaMap(context.tools)
      const rawMatches: string[] = []
      const invalidToolNames: string[] = []
      const toolCalls: ReturnType<typeof buildToolCall>[] = []

      /**
       * 按工具 schema 归一化参数（类型纠正 + 必填补齐 + 删未声明字段）。
       * 统一在出口处对全部解析路径生效（严格 / 裸 invoke / 宽容恢复）。
       */
      const normalizeCalls = (calls: ReturnType<typeof buildToolCall>[]) => {
        for (const call of calls) {
          let parsed: unknown
          try {
            parsed = JSON.parse(call.function.arguments)
          } catch {
            continue
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
          const schema = schemaMap.get(call.function.name)
          if (!schema) continue
          remapPlaceholderParams(parsed as Record<string, unknown>, schema, call.function.name)
          const normalized = normalizeToolArguments(
            parsed as Record<string, unknown>,
            schema,
            call.function.name,
          )
          // 必填参数仍为空时大声记一笔：客户端会以「缺参数」拒绝执行，
          // 属于参数解析没兜住，需要按这条日志回头补解析规则。
          const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
          const emptyRequired = required.filter((key) => {
            const v = normalized[key]
            return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
          })
          if (emptyRequired.length > 0) {
            console.warn(
              `[managedXml] ${call.function.name}: 必填参数 ${emptyRequired.join(', ')} 为空（原始参数键: ${Object.keys(parsed as object).join(', ') || '无'}）`,
            )
          }
          call.function.arguments = JSON.stringify(normalized)
        }
        return calls
      }

      parseBlocks(parseable, {
        blockPattern: /<\|CHAT2API\|tool_calls>([\s\S]*?)<\/\|CHAT2API\|tool_calls>/g,
        invokePattern: /<\|CHAT2API\|invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/\|CHAT2API\|invoke>/g,
        parameterPattern: /<\|CHAT2API\|parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/\|CHAT2API\|parameter>/g,
        rawMatches,
        invalidToolNames,
        allowedNames,
        toolCalls,
        schemaMap,
      })

      parseBlocks(parseable, {
        blockPattern: /<tool_calls>([\s\S]*?)<\/tool_calls>/g,
        invokePattern: /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g,
        parameterPattern: /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g,
        rawMatches,
        invalidToolNames,
        allowedNames,
        toolCalls,
        schemaMap,
      })

      // 裸 invoke 块：模型常省略 <tool_calls> / <|CHAT2API|tool_calls> 包裹标记，
      // 直接输出 invoke 块（GLM-5.3 文本模式常见行为）。先从 parseable 剥离已匹配的
      // 包裹块，避免同一个 invoke 被重复解析。
      let remaining = parseable
      for (const raw of rawMatches) remaining = remaining.replace(raw, '')

      const barePasses: Array<{ invokePattern: RegExp; parameterPattern: RegExp }> = [
        {
          invokePattern: /<\|CHAT2API\|invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/\|CHAT2API\|invoke>/g,
          parameterPattern: /<\|CHAT2API\|parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/\|CHAT2API\|parameter>/g,
        },
        {
          // 纯 XML 写法的裸 invoke：`<invoke name="Bash"><command>ls</command></invoke>`。
          // 旧实现只认带 <|CHAT2API|> 前缀的裸 invoke，这种写法会落到「宽容提取」，
          // 而多个工具的 schema 里都有 command 时会因「无法确定工具名」被整体放弃。
          invokePattern: /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g,
          parameterPattern: /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g,
        },
      ]

      for (const pass of barePasses) {
        const matches: RegExpExecArray[] = []
        let bareMatch: RegExpExecArray | null
        pass.invokePattern.lastIndex = 0
        while ((bareMatch = pass.invokePattern.exec(remaining)) !== null) matches.push(bareMatch)

        for (const invokeMatch of matches) {
          rawMatches.push(invokeMatch[0])
          const rawName = invokeMatch[1].trim()
          const name = resolveToolName(rawName, allowedNames) ?? rawName
          if (!allowedNames.has(name)) {
            invalidToolNames.push(rawName)
            continue
          }
          if (name !== rawName) {
            // 模型轻微幻觉工具名（如 run_bash / Bash），模糊纠正后执行
            console.log(`[managedXml] 工具名模糊纠正: '${rawName}' → '${name}'`)
          }
          const args: Record<string, unknown> = {}
          const schema = schemaMap.get(name)
          let parameterMatch: RegExpExecArray | null
          pass.parameterPattern.lastIndex = 0
          while ((parameterMatch = pass.parameterPattern.exec(invokeMatch[2])) !== null) {
            addParameter(args, parameterMatch[1].trim(), parseJsonValue(parameterMatch[2]))
          }
          if (schema) extractSchemaTagParams(invokeMatch[2], schema, name, args)
          remapPlaceholderParams(args, schema, name)
          toolCalls.push(
            buildToolCall(
              `call_${toolCalls.length}`,
              toolCalls.length,
              name,
              JSON.stringify(args),
              invokeMatch[0],
            ),
          )
        }

        // 已消费的 invoke 从剩余文本中移除，防止下一轮重复匹配
        for (const invokeMatch of matches) remaining = remaining.replace(invokeMatch[0], '')
      }

      if (toolCalls.length === 0) {
        // 严格解析未产出任何工具调用。若内容实际包含工具调用起始标记（模型输出
        // 未闭合/损坏——例如某个 parameter 的闭合标签写错、或流被截断，导致整块
        // 无法被严格正则匹配），则宽容提取：识别 invoke 名称 + 至少一个完整闭合
        // 的 parameter，尽力恢复工具调用，避免整段 XML 作为普通文本泄漏给客户端。
        tryExtractPartialToolCalls(parseable, allowedNames, rawMatches, invalidToolNames, toolCalls, schemaMap)

        // 仍然失败时再按 schema 做一轮宽容恢复：模型有时把参数名/工具名直接当标签
        // （<queries>、<web_search>），上面两条路径都认不出。
        const recoveredSpans: string[] = []
        if (toolCalls.length === 0) {
          tryExtractSchemaDrivenCalls(
            parseable,
            context.tools,
            allowedNames,
            invalidToolNames,
            recoveredSpans,
            toolCalls,
          )
        }

      // 工具调用块只在真的恢复出调用时才从正文剔除，避免误删只是「提到」标签的文字；
      // 但幻觉出来的 <tool_result> 无论有没有调用都必须清掉——那是 AFS 注入给模型看的
      // 格式，出现在回答里就是内部信息泄漏。
      const recoveredContent =
        toolCalls.length > 0
          ? stripHallucinatedToolResults(
              [...rawMatches, ...recoveredSpans].reduce((acc, raw) => acc.replace(raw, ''), parseable),
            ).trim()
          : stripHallucinatedToolResults(content).trim()

        return createParseResult({
          content: recoveredContent,
          toolCalls: normalizeCalls(toolCalls),
          protocol: rawMatches.length > 0 || toolCalls.length > 0 ? 'managed_xml' : 'unknown',
          rawMatches: [...rawMatches, ...recoveredSpans],
          invalidToolNames,
        })
      }

      const cleanContent = stripHallucinatedToolResults(
        rawMatches.reduce((acc, raw) => acc.replace(raw, ''), parseable),
      ).trim()
      return createParseResult({
        content: cleanContent,
        toolCalls: normalizeCalls(toolCalls),
        protocol: 'managed_xml',
        rawMatches,
        invalidToolNames,
      })
    }

    const direct = run(content)
    if (direct.toolCalls.length > 0) return direct

    const normalized = normalizeSmartQuotes(content)
    if (normalized !== content) {
      const retried = run(normalized)
      if (retried.toolCalls.length > 0) {
        console.warn('[managedXml] 模型输出含中文全角引号，已在规范化后恢复工具调用')
        return retried
      }
    }

    return direct
  },

  formatAssistantToolCalls(calls) {
    const invokes = calls.map((call) => {
      const args = safeParseObject(call.arguments)
      const params = Object.entries(args)
        .map(([name, value]) => {
          const text = typeof value === 'string' ? value : JSON.stringify(value)
          return `<parameter name="${escapeXmlAttribute(name)}">${escapeXmlText(text)}</parameter>`
        })
        .join('')
      return `<invoke name="${escapeXmlAttribute(call.name)}">${params}</invoke>`
    })
    return `<tool_calls>${invokes.join('')}</tool_calls>`
  },

  formatToolResult(result) {
    return `<tool_result tool_call_id="${escapeXmlAttribute(result.toolCallId)}">${escapeXmlText(decorateToolResult(result.content))}</tool_result>`
  },
}

/**
 * 清除模型自造的 tool_result 块。
 *
 * 触发场景（实测 11-05 12:18）：GLM 把 prompt 里的转录结构（`User: … Assistant: …`）
 * 当成要继续写的内容，回复里冒出
 * `User: <tool_result tool_call_id="call_0">Command: …</tool_result>`，
 * 用户看到的是内部格式泄漏。工具调用走的是 `<tool_calls><invoke>`，与 `<tool_result>`
 * 互不影响，因此这里可以放心整体剥离。
 */
function stripHallucinatedToolResults(text: string): string {
  return text
    .replace(/<\|CHAT2API\|tool_result[\s\S]*?<\/\|CHAT2API\|tool_result>/g, '')
    .replace(/<tool_result\b[\s\S]*?<\/tool_result>/g, '')
}

/** 将文本安全地嵌入 XML 元素体（转义 < > &，避免破坏结构）。 */
function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

interface ParseBlockOptions {
  blockPattern: RegExp
  invokePattern: RegExp
  parameterPattern: RegExp
  rawMatches: string[]
  invalidToolNames: string[]
  allowedNames: Set<string>
  toolCalls: ReturnType<typeof buildToolCall>[]
  schemaMap: Map<string, Record<string, unknown>>
}

function parseBlocks(content: string, options: ParseBlockOptions): void {
  let blockMatch: RegExpExecArray | null

  while ((blockMatch = options.blockPattern.exec(content)) !== null) {
    options.rawMatches.push(blockMatch[0])
    let invokeMatch: RegExpExecArray | null

    while ((invokeMatch = options.invokePattern.exec(blockMatch[1])) !== null) {
      const rawName = invokeMatch[1].trim()
      const name = resolveToolName(rawName, options.allowedNames) ?? rawName
      if (!options.allowedNames.has(name)) {
        options.invalidToolNames.push(rawName)
        continue
      }
      if (name !== rawName) {
        console.log(`[managedXml] 工具名模糊纠正: '${rawName}' → '${name}'`)
      }

      const args: Record<string, unknown> = {}
      const schema = options.schemaMap.get(name)

      let parameterMatch: RegExpExecArray | null
      options.parameterPattern.lastIndex = 0
      while ((parameterMatch = options.parameterPattern.exec(invokeMatch[2])) !== null) {
        addParameter(args, parameterMatch[1].trim(), parseJsonValue(parameterMatch[2]))
      }
      // 再补「裸标签」参数：GLM-5.3 常写 <command>x</command> 而不是
      // <parameter name="command">x</parameter>。原先只认后者，参数整批丢失，
      // 再被必填补齐成空串 —— 表现为「工具调用了，但参数是空的」。
      // 放在 <parameter> 之后，已有值的键不会被覆盖成数组。
      if (schema) extractSchemaTagParams(invokeMatch[2], schema, name, args)
      remapPlaceholderParams(args, schema, name)

      options.toolCalls.push(
        buildToolCall(`call_${options.toolCalls.length}`, options.toolCalls.length, name, JSON.stringify(args), invokeMatch[0]),
      )
    }
  }
}

/**
 * 从 invoke 体内按 schema 提取「裸标签」参数。
 *
 * 实测 GLM-5.3 会写成 `<invoke name="Skill"><command>pptx</command></invoke>`，
 * 完全没有 `<parameter name=...>` 包裹。这里只认 schema 里声明过的属性名，
 * 因此不会把正文误判成参数。
 */
function extractSchemaTagParams(
  body: string,
  schema: Record<string, unknown>,
  toolName: string,
  args: Record<string, unknown>,
): void {
  const props = (schema.properties ?? {}) as Record<string, unknown>
  for (const prop of Object.keys(props)) {
    if (args[prop] !== undefined) continue
    const re = new RegExp(`<${escapeRegExp(prop)}\\b[^>]*>([\\s\\S]*?)</${escapeRegExp(prop)}>`, 'i')
    const match = re.exec(body)
    if (!match) continue
    addParameter(args, prop, parseJsonValue(match[1] ?? ''))
    console.log(`[managedXml] ${toolName}: 从裸标签恢复参数 '${prop}'`)
  }
}

function safeParseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 内容里是否出现「像是要调用工具」的标记。用于避免对普通文本做提取。 */
function looksLikeToolAttempt(content: string): boolean {
  return /<\/?tool_calls?\b|<invoke\b|<\|\s*CHAT2API\s*\|/i.test(content)
}

/**
 * 按 schema 做宽容参数恢复：模型有时**不用 `<parameter name="X">`**，而是把参数名
 * 甚至工具名直接当标签写。
 *
 * 实测 GLM-5.3 的真实输出（整块被当普通文本泄漏给客户端）：
 * ```
 * <tool_call>web_search调用失败，我重新查询一下今日A股行情。
 * <tool_call>web_search><queries>["A股今日行情 上证指数 深证成指 创业板指"]</queries></web_search>
 * ```
 * 严格正则和 `tryExtractPartialToolCalls` 都认不出 `<queries>`，于是这次工具调用彻底丢失。
 *
 * 这里改为 **schema 驱动**：只认工具 `parameters.properties` 里声明过的参数名，
 * 因此不会把普通文本误判成工具调用（未声明任何属性的工具直接跳过）。
 * 工具名优先取显式出现的（`<web_search` 或 `<tool_call>web_search`）；没有显式
 * 出现时，只有当**恰好一个**工具命中参数标签才恢复，避免歧义误判。
 *
 * @param recoveredSpans - 输出：成功恢复时被消费的原始片段（供调用方从 content 中剥离）
 */
function tryExtractSchemaDrivenCalls(
  content: string,
  tools: NormalizedToolDefinition[],
  allowedNames: Set<string>,
  invalidToolNames: string[],
  recoveredSpans: string[],
  toolCalls: ReturnType<typeof buildToolCall>[],
): void {
  if (toolCalls.length > 0) return
  if (!looksLikeToolAttempt(content)) return

  const marker = /<\/?tool_calls?\b|<invoke\b|<\|\s*CHAT2API\s*\|/i.exec(content)
  const start = marker ? marker.index : -1

  interface Candidate {
    name: string
    args: Record<string, unknown>
    explicit: boolean
    hits: number
    end: number
  }
  const candidates: Candidate[] = []

  for (const tool of tools) {
    const props = Object.keys(
      ((tool.parameters?.properties ?? {}) as Record<string, unknown>),
    )
    if (props.length === 0) continue

    const args: Record<string, unknown> = {}
    let hits = 0
    let end = -1

    for (const prop of props) {
      const re = new RegExp(
        `<${escapeRegExp(prop)}\\b[^>]*>([\\s\\S]*?)</${escapeRegExp(prop)}>`,
        'gi',
      )
      let m: RegExpExecArray | null
      while ((m = re.exec(content)) !== null) {
        addParameter(args, prop, parseJsonValue(m[1]))
        hits += 1
        end = Math.max(end, m.index + m[0].length)
      }
    }

    if (hits === 0) continue

    const nameRe = new RegExp(
      `<${escapeRegExp(tool.name)}\\b|<tool_call[a-z_]*>\\s*${escapeRegExp(tool.name)}\\b`,
      'i',
    )
    candidates.push({ name: tool.name, args, explicit: nameRe.test(content), hits, end })
  }

  if (candidates.length === 0) return

  const explicit = candidates.filter((c) => c.explicit).sort((a, b) => b.hits - a.hits)
  const chosen = explicit[0] ?? (candidates.length === 1 ? candidates[0] : undefined)
  if (!chosen) {
    console.log(
      `[managedXml] 宽容提取发现 ${candidates.length} 个候选工具（${candidates
        .map((c) => c.name)
        .join(', ')}）但无显式工具名，放弃以免误判`,
    )
    return
  }
  if (!allowedNames.has(chosen.name)) {
    invalidToolNames.push(chosen.name)
    return
  }

  console.log(
    `[managedXml] 宽容提取恢复工具调用: ${chosen.name}（${chosen.hits} 个 schema 参数标签）`,
  )
  toolCalls.push(
    buildToolCall(
      `call_${toolCalls.length}`,
      toolCalls.length,
      chosen.name,
      JSON.stringify(chosen.args),
    ),
  )

  if (start >= 0 && chosen.end > start) {
    // 顺带吞掉紧随其后的闭合标签（如 </web_search>）
    const tail = /^<\/[A-Za-z_][\w.:-]*>/.exec(content.slice(chosen.end))
    const end = tail ? chosen.end + tail[0].length : chosen.end
    recoveredSpans.push(content.slice(start, end))
  }
}

/**
 * 宽容提取损坏/未闭合的 <|CHAT2API|invoke> 块。
 *
 * 严格解析要求完整闭合的包裹与 invoke 标签；但 GLM-5.3 等模型常输出损坏的 XML——
 * 例如某个 parameter 的闭合标签写错（如把其它格式的 `</arg_value>` 混进来）或流被
 * 截断，导致整块无法匹配。此时只要还能识别出 invoke 名称 + 至少一个完整闭合的
 * parameter，就尽力恢复工具调用，而不是把整段 XML 泄漏成普通文本。
 *
 * 仅在严格解析无结果且内容含工具调用标记时启用；识别不到完整 parameter 时保持
 * 原样（继续按文本处理），不会误伤普通文本。
 */
function tryExtractPartialToolCalls(
  content: string,
  allowedNames: Set<string>,
  rawMatches: string[],
  invalidToolNames: string[],
  toolCalls: ReturnType<typeof buildToolCall>[],
  schemaMap: Map<string, Record<string, unknown>>,
): void {
  // 内容里必须真的有工具调用起始标记（<|CHAT2API|tool_calls> 或 <|CHAT2API|invoke>）
  if (!/<\|CHAT2API\|(?:tool_calls>|invoke\s)/.test(content)) return

  // 逐个提取裸 invoke 起点：<|CHAT2API|invoke name="...">
  const invokeStarts: Array<{ name: string; start: number; bodyStart: number }> = []
  const invokeOpen = /<\|CHAT2API\|invoke\s+name="([^"]+)"\s*>/g
  let m: RegExpExecArray | null
  while ((m = invokeOpen.exec(content)) !== null) {
    invokeStarts.push({ name: m[1]!.trim(), start: m.index, bodyStart: m.index + m[0].length })
  }
  if (invokeStarts.length === 0) return

  for (let i = 0; i < invokeStarts.length; i += 1) {
    const inv = invokeStarts[i]!
    const regionEnd = i + 1 < invokeStarts.length ? invokeStarts[i + 1]!.start : content.length
    const region = content.slice(inv.bodyStart, regionEnd)

    // 提取该 invoke 体内所有完整闭合的 parameter（CDATA 或纯文本值均可）
    const args: Record<string, unknown> = {}
    const paramPattern = /<\|CHAT2API\|parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/\|CHAT2API\|parameter>/g
    let pm: RegExpExecArray | null
    while ((pm = paramPattern.exec(region)) !== null) {
      addParameter(args, pm[1]!.trim(), parseJsonValue(pm[2]!))
    }

    const resolved = resolveToolName(inv.name, allowedNames) ?? inv.name
    if (!allowedNames.has(resolved)) {
      if (!invalidToolNames.includes(inv.name)) invalidToolNames.push(inv.name)
      continue
    }
    // 损坏块里参数也可能写成裸标签，补一轮 schema 驱动的恢复
    const schema = schemaMap.get(resolved)
    if (schema) extractSchemaTagParams(region, schema, resolved, args)
    remapPlaceholderParams(args, schema, resolved)

    // 至少一个参数才恢复调用；否则（纯文本误含标记）维持文本处理
    if (Object.keys(args).length === 0) continue

    if (resolved !== inv.name) {
      console.log(`[managedXml] 工具名模糊纠正: '${inv.name}' → '${resolved}'`)
    }
    // 把从 invoke 起点到区域末尾作为 raw 匹配剥离（该区域剩余部分是损坏残留）
    const rawText = content.slice(inv.start, regionEnd)
    rawMatches.push(rawText)
    toolCalls.push(buildToolCall(`call_${toolCalls.length}`, toolCalls.length, resolved, JSON.stringify(args), rawText))
  }
}
