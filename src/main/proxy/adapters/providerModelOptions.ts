export interface DeepSeekChatOptionInput {
  model: string
  web_search?: boolean
  reasoning_effort?: string
}

export interface DeepSeekChatOptions {
  /** `vision` 是带图请求的专用取值：不带它下游会退回纯文本语义（模型看不到图）。 */
  modelType: 'default' | 'expert' | 'vision'
  searchEnabled: boolean
  thinkingEnabled: boolean
}

export function resolveDeepSeekChatOptions(
  request: DeepSeekChatOptionInput,
  _prompt: string = '',
  hasImages: boolean = false
): DeepSeekChatOptions {
  const modelLower = request.model.toLowerCase()
  const isProModel = modelLower.includes('deepseek-v4-pro') || modelLower.includes('expert')
  const isSearchAlias = modelLower.includes('search')
  const isThinkingAlias = modelLower.includes('think')
    || modelLower.includes('r1')
    || modelLower.includes('reasoner')

  return {
    // 带图时必须是 vision：实测文档写明"vision 请求上传图片时必须带上 vision，
    // 否则下游容易退回到仅文本或 OCR 语义"——表现为模型对着图片返回空内容，
    // 且上游既不报错也不解释。
    modelType: hasImages ? 'vision' : (isProModel ? 'expert' : 'default'),
    searchEnabled: Boolean(request.web_search) || isSearchAlias,
    thinkingEnabled: Boolean(request.reasoning_effort)
      || isThinkingAlias,
  }
}

export type KimiScenario = 'SCENARIO_K3' | 'SCENARIO_K2D6' | 'SCENARIO_K2D5' | 'SCENARIO_K2'

export function resolveKimiScenario(model: string): KimiScenario {
  const lower = model.toLowerCase()
  if (lower.includes('kimi-k3') || lower.includes('k3')) return 'SCENARIO_K3'
  if (lower.includes('k2.6') || lower.includes('k2d6')) return 'SCENARIO_K2D6'
  if (lower.includes('k2d5') || lower.includes('k2.5')) return 'SCENARIO_K2D5'
  if (lower.includes('k2')) return 'SCENARIO_K2'
  // Default to K3 for any unrecognized model (newest scenario)
  return 'SCENARIO_K3'
}

export function createKimiChatPayload(options: {
  model: string
  content: string
  enableWebSearch: boolean
  enableThinking: boolean
  /** Reasoning effort level: 'low' | 'medium' | 'high' (maps to 快速/进阶) */
  reasoning_effort?: string
}) {
  const scenario = resolveKimiScenario(options.model)
  const thinkingOptions: Record<string, unknown> = {}
  if (options.enableThinking) {
    thinkingOptions.thinking = true
  }
  if (options.reasoning_effort) {
    thinkingOptions.reasoning_effort = options.reasoning_effort
  }

  return {
    scenario,
    chat_id: '',
    tools: options.enableWebSearch ? [{ type: 'TOOL_TYPE_SEARCH', search: {} }] : [],
    message: {
      parent_id: '',
      role: 'user',
      blocks: [{
        message_id: '',
        text: { content: options.content }
      }],
      scenario,
    },
    options: thinkingOptions
  }
}

export function encodeKimiGrpcFrame(payload: unknown): Buffer {
  const jsonBuffer = Buffer.from(JSON.stringify(payload), 'utf8')
  const frameBuffer = Buffer.alloc(5 + jsonBuffer.length)
  frameBuffer.writeUInt8(0, 0)
  frameBuffer.writeUInt32BE(jsonBuffer.length, 1)
  jsonBuffer.copy(frameBuffer, 5)
  return frameBuffer
}
