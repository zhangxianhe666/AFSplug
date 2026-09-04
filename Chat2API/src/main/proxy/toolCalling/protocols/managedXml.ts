import type { ToolProtocolAdapter } from './base.ts'
import type { ToolParseContext } from '../types.ts'
import {
  addParameter,
  buildToolCall,
  createParseResult,
  detectMarkers,
  escapeXmlAttribute,
  parseJsonValue,
  renderToolList,
  resolveToolName,
  stripFencedCodeBlocks,
  toolNames,
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
Use only the exact tool names listed below. Do not rename, camelCase, translate, shorten, or invent tool names. In particular, there is NO tool named "open_url" — do not claim you only have a web-opening tool. The tools below include file tools (bash, read, write, glob, grep) that access the local machine.

The list above is the complete, current set of tools available to you in this turn. It supersedes any earlier message in the conversation:
- A tool failure in past conversation history (e.g. a browser or network error) does NOT mean that tool is currently unavailable. If the tool is in the list above, call it when needed.
- You may call tools as many times as needed. There is no tool-call limit or "maximum number of rounds"; never assume one.
- Do not refuse to use file tools (bash, read, write, glob, grep, ...) by claiming they are unavailable — they are available.
- Never fabricate a tool result. Always call the tool for real and wait for the actual result block.

${renderToolList(tools)}

When calling tools, respond with only this Chat2API XML block:

<|CHAT2API|tool_calls><|CHAT2API|invoke name="exact_tool_name"><|CHAT2API|parameter name="argument"><![CDATA[value]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>

Tool results will be provided as Chat2API XML result blocks:

<|CHAT2API|tool_result tool_call_id="call_id"><![CDATA[result]]></|CHAT2API|tool_result>`
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
    const parseable = stripFencedCodeBlocks(content)
    const allowedNames = toolNames(context.tools)
    const rawMatches: string[] = []
    const invalidToolNames: string[] = []
    const toolCalls: ReturnType<typeof buildToolCall>[] = []

    parseBlocks(parseable, {
      blockPattern: /<\|CHAT2API\|tool_calls>([\s\S]*?)<\/\|CHAT2API\|tool_calls>/g,
      invokePattern: /<\|CHAT2API\|invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/\|CHAT2API\|invoke>/g,
      parameterPattern: /<\|CHAT2API\|parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/\|CHAT2API\|parameter>/g,
      rawMatches,
      invalidToolNames,
      allowedNames,
      toolCalls,
    })

    parseBlocks(parseable, {
      blockPattern: /<tool_calls>([\s\S]*?)<\/tool_calls>/g,
      invokePattern: /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g,
      parameterPattern: /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g,
      rawMatches,
      invalidToolNames,
      allowedNames,
      toolCalls,
    })

    // 裸 <|CHAT2API|invoke> 块：模型常省略 <|CHAT2API|tool_calls> 包裹标记，
    // 直接输出 invoke 块（GLM-5.3 文本模式常见行为）。先从 parseable 剥离已匹配的包裹块，避免重复解析。
    let remaining = parseable
    for (const raw of rawMatches) remaining = remaining.replace(raw, '')
    const bareInvokePattern = /<\|CHAT2API\|invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/\|CHAT2API\|invoke>/g
    let bareMatch: RegExpExecArray | null
    while ((bareMatch = bareInvokePattern.exec(remaining)) !== null) {
      rawMatches.push(bareMatch[0])
      const rawName = bareMatch[1].trim()
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
      const parameterPattern = /<\|CHAT2API\|parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/\|CHAT2API\|parameter>/g
      let parameterMatch: RegExpExecArray | null
      while ((parameterMatch = parameterPattern.exec(bareMatch[2])) !== null) {
        addParameter(args, parameterMatch[1].trim(), parseJsonValue(parameterMatch[2]))
      }
      toolCalls.push(
        buildToolCall(`call_${toolCalls.length}`, toolCalls.length, name, JSON.stringify(args), bareMatch[0]),
      )
    }

    if (toolCalls.length === 0) {
      // 严格解析未产出任何工具调用。若内容实际包含工具调用起始标记（模型输出
      // 未闭合/损坏——例如某个 parameter 的闭合标签写错、或流被截断，导致整块
      // 无法被严格正则匹配），则宽容提取：识别 invoke 名称 + 至少一个完整闭合
      // 的 parameter，尽力恢复工具调用，避免整段 XML 作为普通文本泄漏给客户端。
      tryExtractPartialToolCalls(parseable, allowedNames, rawMatches, invalidToolNames, toolCalls)
      return createParseResult({
        content,
        toolCalls,
        protocol: rawMatches.length > 0 ? 'managed_xml' : 'unknown',
        rawMatches,
        invalidToolNames,
      })
    }

    const cleanContent = rawMatches
      .reduce((acc, raw) => acc.replace(raw, ''), parseable)
      // 模型自编的 tool_result 块（模拟工具执行的幻觉文本）也应从 content 中清除
      .replace(/<\|CHAT2API\|tool_result[\s\S]*?<\/\|CHAT2API\|tool_result>/g, '')
      .trim()
    return createParseResult({
      content: cleanContent,
      toolCalls,
      protocol: 'managed_xml',
      rawMatches,
      invalidToolNames,
    })
  },

  formatAssistantToolCalls(calls) {
    const invokes = calls.map((call) => {
      const args = safeParseObject(call.arguments)
      const params = Object.entries(args)
        .map(([name, value]) => {
          const text = typeof value === 'string' ? value : JSON.stringify(value)
          return `<|CHAT2API|parameter name="${escapeXmlAttribute(name)}"><![CDATA[${text}]]></|CHAT2API|parameter>`
        })
        .join('')
      return `<|CHAT2API|invoke name="${escapeXmlAttribute(call.name)}">${params}</|CHAT2API|invoke>`
    })
    return `${CHAT2API_START}${invokes.join('')}${CHAT2API_END}`
  },

  formatToolResult(result) {
    return `<|CHAT2API|tool_result tool_call_id="${escapeXmlAttribute(result.toolCallId)}"><![CDATA[${result.content}]]></|CHAT2API|tool_result>`
  },
}

interface ParseBlockOptions {
  blockPattern: RegExp
  invokePattern: RegExp
  parameterPattern: RegExp
  rawMatches: string[]
  invalidToolNames: string[]
  allowedNames: Set<string>
  toolCalls: ReturnType<typeof buildToolCall>[]
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
      let parameterMatch: RegExpExecArray | null
      options.parameterPattern.lastIndex = 0
      while ((parameterMatch = options.parameterPattern.exec(invokeMatch[2])) !== null) {
        addParameter(args, parameterMatch[1].trim(), parseJsonValue(parameterMatch[2]))
      }

      options.toolCalls.push(
        buildToolCall(`call_${options.toolCalls.length}`, options.toolCalls.length, name, JSON.stringify(args), invokeMatch[0]),
      )
    }
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

    // 至少一个完整参数才恢复调用；否则（纯文本误含标记）维持文本处理
    if (Object.keys(args).length === 0) continue

    const resolved = resolveToolName(inv.name, allowedNames) ?? inv.name
    if (!allowedNames.has(resolved)) {
      if (!invalidToolNames.includes(inv.name)) invalidToolNames.push(inv.name)
      continue
    }
    if (resolved !== inv.name) {
      console.log(`[managedXml] 工具名模糊纠正: '${inv.name}' → '${resolved}'`)
    }
    // 把从 invoke 起点到区域末尾作为 raw 匹配剥离（该区域剩余部分是损坏残留）
    const rawText = content.slice(inv.start, regionEnd)
    rawMatches.push(rawText)
    toolCalls.push(buildToolCall(`call_${toolCalls.length}`, toolCalls.length, resolved, JSON.stringify(args), rawText))
  }
}
