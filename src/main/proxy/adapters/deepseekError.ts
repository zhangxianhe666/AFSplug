/**
 * DeepSeek 错误体的识别（无 electron / axios 依赖，可直接单元测试）。
 *
 * 为什么需要：DeepSeek 出错时返回的是 **HTTP 200 + JSON 错误体**
 * （如 `{"code":40301,"msg":"INVALID_POW_RESPONSE"}`），而不是非 2xx 状态码。
 * 流处理器只认 `data:` 开头的 SSE 行，于是整条错误体被当作"没有内容"跳过，
 * 一次失败请求最终只表现为"上游空响应"——既不报错也没有日志，完全无从排查。
 *
 * @module proxy/adapters/deepseekError
 */

/** SSE 里除了 `data:` 还有这些字段行，都不是错误体。 */
const SSE_PREFIXES = ['data:', ':', 'event:', 'id:', 'retry:'] as const

/**
 * 把一行非 SSE 内容描述成可读的错误摘要；不是错误体则返回 `''`。
 * @param line - 原始响应里的一行（不含换行）。
 * @returns 形如 `code=40301 msg=INVALID_POW_RESPONSE` 的摘要，或 `''`。
 */
export function describeDeepSeekErrorLine(line: string): string {
  const text = line.trim()
  if (!text) return ''
  for (const prefix of SSE_PREFIXES) {
    if (text.startsWith(prefix)) return ''
  }
  try {
    const parsed = JSON.parse(text) as {
      code?: unknown
      msg?: unknown
      error?: { message?: unknown } | string
    }
    const nested = typeof parsed.error === 'object' && parsed.error !== null
      ? parsed.error.message
      : parsed.error
    const message = typeof parsed.msg === 'string'
      ? parsed.msg
      : typeof nested === 'string' ? nested : ''
    if (parsed.code !== undefined || message) {
      return `code=${String(parsed.code ?? '')}${message ? ` msg=${message}` : ''}`
    }
  } catch {
    // 不是 JSON：原样返回，至少让人知道上游发回了非 SSE 内容
  }
  return text.slice(0, 300)
}
