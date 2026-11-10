import type { ToolProtocolAdapter } from './base.ts'
import type { ToolParseContext } from '../types.ts'
import {
  buildToolCall,
  createParseResult,
  genericToolResultBlock,
  detectMarkers,
  normalizeToolArguments,
  remapPlaceholderParams,
  renderToolList,
  resolveToolName,
  stripFencedCodeBlocks,
  toolNames,
  toolSchemaMap,
} from './shared.ts'

const START_MARKER = '[function_calls]'
const END_MARKER = '[/function_calls]'

export const managedBracketProtocol: ToolProtocolAdapter = {
  id: 'managed_bracket',

  renderPrompt(tools) {
    return `## Your Role
You are a LOCAL coding agent running ON the user's machine (macOS). You are NOT a web chat assistant, NOT a website, and NOT an online chatbot. Even if earlier system text mentions a "Web GUI", "web page", or a chat interface, that describes how the human views the session — it does NOT change your role. You operate directly on the local filesystem with shell/file tools, and you MUST use them to fulfill requests (listing directories, reading files, running commands).

## Available Tools
You can invoke the following developer tools. Tool names are case-sensitive.

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

When calling tools, respond with only this block:

[function_calls]
[call:exact_tool_name]{"argument":"value"}[/call]
[/function_calls]`
  },

  detectStart(buffer) {
    return detectMarkers(buffer, [START_MARKER])
  },

  parse(content: string, context: ToolParseContext) {
    const parseable = stripFencedCodeBlocks(content)
    const allowedNames = toolNames(context.tools)
    const schemaMap = toolSchemaMap(context.tools)
    const rawMatches: string[] = []
    const invalidToolNames: string[] = []
    const toolCalls = []
    const blockPattern = /\[function_calls\]([\s\S]*?)\[\/function_calls\]/g
    let blockMatch: RegExpExecArray | null

    // 按工具 schema 归一化参数（类型纠正 + 必填补齐 + 删未声明字段）
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
        call.function.arguments = JSON.stringify(
          normalizeToolArguments(parsed as Record<string, unknown>, schema, call.function.name),
        )
      }
      return calls
    }

    while ((blockMatch = blockPattern.exec(parseable)) !== null) {
      rawMatches.push(blockMatch[0])
      const callPattern = /\[call:([^\]]+)\]([\s\S]*?)\[\/call\]/g
      let callMatch: RegExpExecArray | null

      while ((callMatch = callPattern.exec(blockMatch[1])) !== null) {
        const rawName = callMatch[1].trim()
        const name = resolveToolName(rawName, allowedNames) ?? rawName
        if (!allowedNames.has(name)) {
          invalidToolNames.push(rawName)
          continue
        }
        if (name !== rawName) {
          console.log(`[managedBracket] 工具名模糊纠正: '${rawName}' → '${name}'`)
        }

        toolCalls.push(buildToolCall(`call_${toolCalls.length}`, toolCalls.length, name, callMatch[2], callMatch[0]))
      }
    }

    if (toolCalls.length === 0) {
      return createParseResult({
        content,
        toolCalls,
        protocol: rawMatches.length > 0 ? 'managed_bracket' : 'unknown',
        rawMatches,
        invalidToolNames,
      })
    }

    const cleanContent = rawMatches.reduce((acc, raw) => acc.replace(raw, ''), parseable).trim()
    return createParseResult({
      content: cleanContent,
      toolCalls: normalizeCalls(toolCalls),
      protocol: 'managed_bracket',
      rawMatches,
      invalidToolNames,
    })
  },

  formatAssistantToolCalls(calls) {
    const body = calls.map((call) => `[call:${call.name}]${call.arguments}[/call]`).join('\n')
    return `${START_MARKER}\n${body}\n${END_MARKER}`
  },

  formatToolResult(result) {
    return genericToolResultBlock(result)
  },
}
