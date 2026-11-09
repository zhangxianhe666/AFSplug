import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage } from '../types.ts'
import type { NormalizedToolDefinition } from './types.ts'

/**
 * 客户端工具屏蔽策略（v1.7.3）
 *
 * 背景：客户端注入的工具里有一部分是「客户端自己实现、额外依赖凭证」的。dsh 的
 * `web_search` 就是典型——它把查询交给 DeepSeek 官方的 Anthropic 兼容 Messages
 * 端点（`/anthropic/v1/messages`）配 `web_search_20250305` server tool，消耗的是
 * 客户端的 `DEEPSEEK_API_KEY`。这把 key 失效时，模型其实**每次都正确调用了工具**，
 * 拿回来的却是一条 401：
 *
 *   tool/call  web_search {"queries":["重庆今日天气 2026年11月9日"]}
 *   tool/result Error: DeepSeek API error (HTTP 401): ... api key: ****78bN is invalid
 *
 * 然后模型开始在道歉和乱发调用之间打转，用户侧看到的就是「问什么都失败」。网关
 * 没法替客户端换 key，但可以不把这条注定失败的路摆到模型面前。
 *
 * 两条规则，取并集：
 *   1. 配置点名（默认空，不影响其它客户端正常的搜索工具）
 *      - `~/.chat2api/tool-policy.json` → `{"disabledTools":["web_search"]}`
 *      - 或环境变量 `AFS_DISABLED_TOOLS=web_search,xxx`
 *   2. 历史自愈：对话里已经有一条「认证类失败」的工具结果 → 本轮起自动屏蔽该工具
 *
 * 屏蔽只作用于**注入给模型的清单**，客户端自己的 tools 数组一个字节都不改：模型
 * 看不到 `web_search`，就会改用 `web_fetch`（纯 HTTP 抓取，不需要任何 key）。
 */

/** 逗号分隔的工具名列表，快速覆盖（不必写配置文件）。 */
export const TOOL_POLICY_ENV = 'AFS_DISABLED_TOOLS'

/** 配置文件路径覆盖，便于测试与多份配置切换。 */
export const TOOL_POLICY_FILE_ENV = 'AFS_TOOL_POLICY_FILE'

export const DEFAULT_TOOL_POLICY_PATH = join(homedir(), '.chat2api', 'tool-policy.json')

export interface ToolPolicy {
  /** 无条件屏蔽的工具基础名（已小写）。 */
  disabledTools: string[]
}

export const DEFAULT_TOOL_POLICY: ToolPolicy = { disabledTools: [] }

/**
 * 去掉命名空间前缀并统一小写：`default_api:Web_Search` → `web_search`。
 * 各家客户端对同一个工具的命名并不一致，比较前必须归一化。
 */
export function baseToolName(name: string): string {
  const trimmed = name.trim()
  const index = trimmed.lastIndexOf(':')
  const base = index >= 0 ? trimmed.slice(index + 1) : trimmed
  return base.toLowerCase()
}

/**
 * 「认证类失败」：工具本身调得通，执行时被上游以凭证问题拒绝。
 * 这类错误重试同一个工具毫无意义，只会把整轮对话拖进道歉循环。
 */
const AUTH_FAILURE_PATTERN =
  /(?:HTTP[\s/]*401\b|Authentication Fails|invalid[ _-]?api[ _-]?key|api[ _-]?key[^.\n]{0,60}(?:invalid|expired|revoked|not valid|无效|过期|失效)|unauthorized|token[^.\n]{0,40}(?:invalid|expired|expired or invalid|无效|过期)|鉴权失败|认证失败|密钥无效|密钥已过期|未授权)/i

/**
 * 「看起来像 unauthorized、其实和凭证无关」的操作系统权限错误。
 *
 * 踩过的坑：让模型建 Word 文档时它先走 Word COM，PowerShell 报
 *
 *   New-Object : Retrieving the COM class factory for component with CLSID {...}
 *   failed ... 80070005 Access is denied. (Exception from HRESULT: 0x80070005 (E_ACCESSDENIED))
 *   + FullyQualifiedErrorId : System.UnauthorizedAccessException
 *
 * 其中的 `UnauthorizedAccessException` / `unauthorized` 命中了上面的凭证特征，于是
 * **整个 pwsh 工具被判定为「认证失败」并永久从清单里摘掉**——模型从此没法执行任何
 * 命令，只能改派 subagent，主 agent 在 list_agents / send_message 之间空转，用户侧
 * 看到的就是「一个建文档的任务来回打断、怎么都做不完」。
 *
 * 文件 ACL、服务权限、COM 注册都会抛 UnauthorizedAccessException，跟 API key 无关，
 * 这类文本一律不算认证失败。宁可漏判（顶多白重试一次工具），也不能误禁整个 shell。
 */
const OS_PERMISSION_PATTERN =
  /(?:UnauthorizedAccessException|E_ACCESSDENIED|Access is denied|拒绝访问|0x80070005|80070005|CLSID \{)/i

/** 取消息正文的纯文本（兼容 string / parts / null）。 */
function messageText(message: ChatMessage): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .filter((text) => text.length > 0)
      .join('\n')
  }
  return ''
}

export function normalizeToolPolicy(raw: unknown): ToolPolicy {
  if (!raw || typeof raw !== 'object') return { disabledTools: [] }
  const list = (raw as { disabledTools?: unknown }).disabledTools
  if (!Array.isArray(list)) return { disabledTools: [] }
  const names = list
    .filter((item): item is string => typeof item === 'string')
    .map(baseToolName)
    .filter((item) => item.length > 0)
  return { disabledTools: [...new Set(names)] }
}

/** 读配置文件；不存在、不是合法 JSON、字段类型不对，一律退回空策略。 */
export function readToolPolicyFile(path: string): ToolPolicy {
  try {
    return normalizeToolPolicy(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return { disabledTools: [] }
  }
}

export function resolveToolPolicy(
  options: { path?: string; env?: Record<string, string | undefined> } = {},
): ToolPolicy {
  const env = options.env ?? process.env
  const path = options.path ?? env[TOOL_POLICY_FILE_ENV] ?? DEFAULT_TOOL_POLICY_PATH
  const fromFile = readToolPolicyFile(path)
  const fromEnv = (env[TOOL_POLICY_ENV] ?? '')
    .split(',')
    .map(baseToolName)
    .filter((item) => item.length > 0)
  return { disabledTools: [...new Set([...fromFile.disabledTools, ...fromEnv])] }
}

/**
 * 从历史里找出「工具结果报了认证失败」的工具名。
 *
 * 工具结果只带 `tool_call_id`，名字要从之前 assistant 消息的 `tool_calls` 里找回来。
 * **必须顺序扫描**：dsh 每轮都把 id 编成 `call_0`，同一个 id 在一条对话里会出现很多次。
 * 先建全量 id→名字 的表再回查，会拿到最后一轮的名字，把上一轮的失败算到无辜的工具头上
 * （真踩过：`call_0` 先后属于 pwsh / read_image / web_search，错误归因会误禁 pwsh）。
 * 顺序扫描时，读到 tool 消息那一刻表里存的就是紧邻它那个 assistant 轮的映射。
 *
 * 找不到名字就跳过——宁可漏判，也不要把无辜的工具认定成坏的。
 */
export function detectAuthFailedTools(messages: ChatMessage[]): Set<string> {
  const namesById = new Map<string, string>()
  /** 每个工具**最近一次**结果是不是认证失败（后来成功过就该放出来）。 */
  const lastAuthFailed = new Map<string, boolean>()

  for (const message of messages) {
    if (message.role === 'assistant') {
      if (!Array.isArray(message.tool_calls)) continue
      for (const call of message.tool_calls) {
        const id = call?.id
        const name = call?.function?.name
        if (typeof id === 'string' && id.length > 0 && typeof name === 'string' && name.length > 0) {
          namesById.set(id, baseToolName(name))
        }
      }
      continue
    }

    if (message.role !== 'tool') continue
    const byCallId = message.tool_call_id ? namesById.get(message.tool_call_id) : undefined
    const byName = typeof message.name === 'string' && message.name.length > 0 ? baseToolName(message.name) : undefined
    const name = byCallId ?? byName
    if (!name) continue

    const text = messageText(message)
    lastAuthFailed.set(name, AUTH_FAILURE_PATTERN.test(text) && !OS_PERMISSION_PATTERN.test(text))
  }

  const failed = new Set<string>()
  for (const [name, isAuthFailed] of lastAuthFailed) {
    if (isAuthFailed) failed.add(name)
  }
  return failed
}

/**
 * 把屏蔽集合应用到工具清单上。
 * 返回被摘掉的名字（用于日志），方便对照「模型为什么突然不用搜索了」。
 */
export function partitionDisabledTools(
  tools: NormalizedToolDefinition[],
  disabled: Set<string>,
): { kept: NormalizedToolDefinition[]; removed: string[] } {
  if (disabled.size === 0) return { kept: tools, removed: [] }
  const kept: NormalizedToolDefinition[] = []
  const removed: string[] = []
  for (const tool of tools) {
    const name = baseToolName(tool.name)
    if (disabled.has(name)) removed.push(name)
    else kept.push(tool)
  }
  return { kept, removed }
}
