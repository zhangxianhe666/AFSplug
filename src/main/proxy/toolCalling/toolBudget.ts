import type { ChatMessage } from '../types.ts'

/**
 * 工具结果预算（v1.7.6）
 *
 * 网页抓取类工具一开口就是整页 HTML/JSON：实测一次 ESPN 比分接口回填后，下一轮
 * 请求从 15K 字符涨到 26K，GLM 网页版直接给出空响应（93 秒、chars=0），客户端
 * 的回合就此中断——用户看到的是「任务被强制中断」。
 *
 * 托管模式没有原生 function calling，整段历史都得塞进 prompt，所以必须在注入前
 * 给工具结果设上限。策略保守：
 *
 *   1. 单条超限只截中间，保留头尾——JSON 的关键字段常在末尾（events/scores），
 *      一刀切尾部等于把数据删掉。
 *   2. 总量按「从最近往前」分配：越近的结果对当前决策越重要，更早的整条折叠。
 *   3. 所有截断都留一行说明，模型知道内容不完整，可以用 pwsh/read 精确取回。
 *
 * 环境变量：
 *   AFS_TOOL_RESULT_LIMIT=6000   单条上限（0 关闭整个机制）
 *   AFS_TOOL_RESULT_TOTAL=18000  所有工具结果的合计预算
 */

const DEFAULT_SINGLE_LIMIT = 6000
const DEFAULT_TOTAL_LIMIT = 18000

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function singleLimit(): number {
  return envInt('AFS_TOOL_RESULT_LIMIT', DEFAULT_SINGLE_LIMIT)
}

export function totalLimit(): number {
  return envInt('AFS_TOOL_RESULT_TOTAL', DEFAULT_TOTAL_LIMIT)
}

export interface ToolTrimResult {
  messages: ChatMessage[]
  /** 被截断或折叠的条数。 */
  trimmed: number
  /** 省下的字符数。 */
  saved: number
}

function contentOf(message: ChatMessage): string {
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part === 'string' ? part : (part?.text ?? '')))
      .join('\n')
  }
  return ''
}

/** 头尾各留一半，中间标注省略了多少字符。 */
function clipMiddle(text: string, limit: number): string {
  const head = Math.floor(limit * 0.55)
  const tail = limit - head
  const omitted = text.length - head - tail
  const notice = `\n\n…[中间省略 ${omitted} 字符，内容不完整；需要精确数据请用 pwsh/read 直接读取来源]…\n\n`
  return `${text.slice(0, head)}${notice}${text.slice(text.length - tail)}`
}

/**
 * 按预算裁剪历史里的工具结果。
 *
 * 只处理 role=tool 的消息；非字符串 content（多模态 parts）按拼出的文本长度估算，
 * 超限时替换为纯文本摘要，避免结构被破坏后客户端解析失败。
 */
export function trimToolResults(
  messages: ChatMessage[],
  options: { singleLimit?: number; totalLimit?: number } = {},
): ToolTrimResult {
  const perMessage = options.singleLimit ?? singleLimit()
  const perTurn = options.totalLimit ?? totalLimit()
  if (perMessage === 0 || perTurn === 0) return { messages, trimmed: 0, saved: 0 }

  const next = [...messages]
  let trimmed = 0
  let saved = 0
  let budget = perTurn

  for (let i = next.length - 1; i >= 0; i--) {
    const message = next[i]
    if (!message || message.role !== 'tool') continue
    const text = contentOf(message)
    if (!text) continue

    if (text.length > perMessage) {
      const clipped = clipMiddle(text, perMessage)
      saved += text.length - clipped.length
      trimmed += 1
      budget -= clipped.length
      next[i] = { ...message, content: clipped } as ChatMessage
      continue
    }

    if (text.length > budget) {
      // 更早的结果整体折叠成一行摘要：保留「做过什么、拿到了什么开头」，
      // 让模型知道自己先前成功过，不至于重复抓取或宣称工具不可用。
      const preview = text.replace(/\s+/g, ' ').slice(0, 200)
      const folded = `[这条工具结果已折叠以节省上下文，原始长度 ${text.length} 字符。开头：${preview}…]`
      saved += text.length - folded.length
      trimmed += 1
      next[i] = { ...message, content: folded } as ChatMessage
      continue
    }

    budget -= text.length
  }

  return { messages: next, trimmed, saved }
}
