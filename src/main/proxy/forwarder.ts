/**
 * Proxy Service Module - Request Forwarder
 * Forwards requests to corresponding API based on provider configuration
 */

import axios, { AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios'
import http2 from 'http2'
import { PassThrough } from 'stream'
import { Account, Provider } from '../store/types'
import { ForwardResult, ChatCompletionRequest, ProxyContext } from './types'
import { proxyStatusManager } from './status'
import { storeManager } from '../store/store'
import { DeepSeekAdapter } from './adapters/deepseek'
import { DeepSeekStreamHandler } from './adapters/deepseek-stream'
import { GLMAdapter, GLMStreamHandler } from './adapters/glm'
import { KimiAdapter, KimiStreamHandler } from './adapters/kimi'
import { MimoAdapter, MimoStreamHandler } from './adapters/mimo'
import { QwenAdapter, QwenStreamHandler } from './adapters/qwen'
import { QwenAiAdapter, QwenAiStreamHandler } from './adapters/qwen-ai'
import { ZaiAdapter, ZaiStreamHandler } from './adapters/zai'
import { MiniMaxAdapter, MiniMaxStreamHandler } from './adapters/minimax'
import { PerplexityAdapter } from './adapters/perplexity'
import { PerplexityStreamHandler } from './adapters/perplexity-stream'
import { ToolCallingEngine } from './toolCalling/ToolCallingEngine'
import {
  detectPlanOnlyTurn,
  detectSandboxHallucination,
  detectToolRefusal,
  lastUserText,
  planOnlyNudge,
  sandboxNudge,
  toolRefusalNudge,
} from './toolCalling/hallucinationGuard'
import { detectFalseFileClaim, groundingNudge } from './toolCalling/grounding'
import { detectUnbackedProgress, progressNudge } from './toolCalling/actionLedger'
import {
  detectTurnState,
  stripTurnMarker,
  turnStateNudge,
  turnStateRetryBudget,
} from './toolCalling/turnState'
import type { ToolCallingTransformResult } from './toolCalling/types'
import { sessionManager } from './sessionManager'
import {
  createContextManagementService,
  SummaryGenerator,
  type ChatMessage as ContextChatMessage,
} from './services/contextManagementService'

function shouldDeleteSession(): boolean {
  return sessionManager.shouldDeleteAfterChat()
}

/**
 * Convert a non-streaming chat.completion result into an OpenAI-compatible SSE stream.
 * Used by forwardGLM: GLM web streams emit incremental parts that shred text XML,
 * so streaming requests are collected non-streamingly and re-emitted as SSE.
 */
function resultToSSE(result: any): PassThrough {
  const transStream = new PassThrough()
  try {
    const msg = result?.choices?.[0]?.message ?? {}
    const choice = result?.choices?.[0] ?? {}
    const created = result?.created ?? Math.floor(Date.now() / 1000)
    const model = result?.model ?? ''
    const id = result?.id ?? ''
    const base = { id, model, object: 'chat.completion.chunk', created }

    if (msg.reasoning_content) {
      transStream.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: { reasoning_content: msg.reasoning_content }, finish_reason: null }],
        })}\n\n`
      )
    }

    if (msg.content) {
      transStream.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: { role: 'assistant', content: String(msg.content) }, finish_reason: null }],
        })}\n\n`
      )
    }

    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      transStream.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: { role: 'assistant', tool_calls: msg.tool_calls }, finish_reason: null }],
        })}\n\n`
      )
    }

    transStream.write(
      `data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason ?? 'stop' }],
      })}\n\n`
    )

    if (result?.usage) {
      transStream.write(`data: ${JSON.stringify({ ...base, choices: [], usage: result.usage })}\n\n`)
    }
  } catch (err) {
    console.error('[GLM] resultToSSE error:', err)
  }
  transStream.end('data: [DONE]\n\n')
  return transStream
}

type ProviderForwarder = {
  name: string
  matches: (provider: Provider) => boolean
  forward: (
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ) => Promise<ForwardResult>
}

/**
 * Request Forwarder
 */
export class RequestForwarder {
  private axiosInstance = axios.create({
    timeout: 120000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  })

  private readonly providerForwarders: ProviderForwarder[] = [
    {
      name: 'deepseek',
      matches: DeepSeekAdapter.isDeepSeekProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardDeepSeek(request, account, provider, actualModel, startTime),
    },
    {
      name: 'glm',
      matches: GLMAdapter.isGLMProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardGLM(request, account, provider, actualModel, startTime),
    },
    {
      name: 'kimi',
      matches: KimiAdapter.isKimiProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardKimi(request, account, provider, actualModel, startTime),
    },
    {
      name: 'qwen',
      matches: QwenAdapter.isQwenProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardQwen(request, account, provider, actualModel, startTime),
    },
    {
      name: 'qwen-ai',
      matches: QwenAiAdapter.isQwenAiProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardQwenAi(request, account, provider, actualModel, startTime),
    },
    {
      name: 'zai',
      matches: ZaiAdapter.isZaiProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardZai(request, account, provider, actualModel, startTime),
    },
    {
      name: 'minimax',
      matches: MiniMaxAdapter.isMiniMaxProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardMiniMax(request, account, provider, actualModel, startTime),
    },
    {
      name: 'mimo',
      matches: MimoAdapter.isMimoProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardMimo(request, account, provider, actualModel, startTime),
    },
    {
      name: 'perplexity',
      matches: PerplexityAdapter.isPerplexityProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardPerplexity(request, account, provider, actualModel, startTime),
    },
  ]

  /**
   * Transform request for prompt-based tool calling
   * For models that don't support native function calling
   * Delegates tool normalization, prompt injection, and parser planning to ToolCallingEngine.
   */
  private transformRequestForPromptToolUse(
    request: ChatCompletionRequest,
    provider?: Provider
  ): ToolCallingTransformResult {
    const config = storeManager.getConfig().toolCallingConfig
    const engine = new ToolCallingEngine(config, (message) => storeManager.addLog('info', message))

    return engine.transformRequest({
      request,
      provider: provider ?? {
        id: 'custom',
        name: 'Custom',
        type: 'custom',
        authType: 'token',
        apiEndpoint: '',
        headers: {},
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
      },
      actualModel: request.model,
    })
  }

  private applyToolCallsToResponse(result: any, transformed: ToolCallingTransformResult): void {
    const engine = new ToolCallingEngine(storeManager.getConfig().toolCallingConfig, (message) =>
      storeManager.addLog('info', message),
    )
    engine.applyNonStreamResponse(result, transformed.plan)
  }

  /**
   * Create summary generator function for context management
   * Uses the current provider and account to generate summaries
   */
  private createSummaryGenerator(
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext
  ): SummaryGenerator {
    return async (messages: ContextChatMessage[], prompt?: string): Promise<string> => {
      try {
        console.log('[SummaryGenerator] Generating summary for', messages.length, 'messages')

        const summaryPrompt = prompt || 'Please summarize the following conversation concisely, keeping key information and context:'

        const conversationText = messages
          .map(msg => {
            const role = msg.role.toUpperCase()
            const content = typeof msg.content === 'string'
              ? msg.content
              : Array.isArray(msg.content)
                ? msg.content
                    .filter(part => part.type === 'text' && part.text)
                    .map(part => part.text)
                    .join('\n')
                : ''
            return `${role}: ${content}`
          })
          .join('\n\n')

        const summaryRequest: ChatCompletionRequest = {
          model: actualModel,
          messages: [
            {
              role: 'system',
              content: summaryPrompt,
            },
            {
              role: 'user',
              content: conversationText,
            },
          ],
          stream: false,
          temperature: 0.3,
        }

        const result = await this.doForward(
          summaryRequest,
          account,
          provider,
          actualModel,
          context
        )

        if (result.success && result.body) {
          const summaryContent = result.body.choices?.[0]?.message?.content || ''
          console.log('[SummaryGenerator] Summary generated successfully, length:', summaryContent.length)
          return summaryContent
        }

        console.warn('[SummaryGenerator] Failed to generate summary:', result.error)
        return 'Failed to generate conversation summary.'
      } catch (error) {
        console.error('[SummaryGenerator] Error generating summary:', error)
        return 'Failed to generate conversation summary due to an error.'
      }
    }
  }

  /**
   * Forward Chat Completions Request
   */
  async forwardChatCompletion(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext
  ): Promise<ForwardResult> {
    const startTime = Date.now()
    const config = storeManager.getConfig()
    const maxRetries = config.retryCount

    let lastError: string | undefined

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await this.delay(5000)
      }

      let modifiedRequest = request

      if (config.contextManagement?.enabled && modifiedRequest.messages && modifiedRequest.messages.length > 0) {
        try {
          const summaryGenerator = this.createSummaryGenerator(
            account,
            provider,
            actualModel,
            context
          )

          const contextService = createContextManagementService(
            config.contextManagement || {},
            summaryGenerator
          )

          const originalCount = modifiedRequest.messages.length
          const contextMessages: ContextChatMessage[] = modifiedRequest.messages.map(msg => ({
            role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
            content: msg.content,
            timestamp: Date.now(),
          }))

          const processResult = await contextService.process(contextMessages)

          if (processResult.finalCount !== originalCount) {
            console.log(
              `[Forwarder] Context management applied: ${originalCount} -> ${processResult.finalCount} messages`
            )

            processResult.strategyResults.forEach(result => {
              if (result.trimmed) {
                console.log(
                  `[Forwarder] Strategy ${result.strategyName}: ${result.originalCount} -> ${result.processedCount} messages`
                )
              }
            })

            modifiedRequest = {
              ...modifiedRequest,
              messages: processResult.messages.map(msg => ({
                role: msg.role,
                content: msg.content,
              })),
            }
          }
        } catch (error) {
          console.error('[Forwarder] Context management failed:', error)
        }
      }

      try {
        const result = await this.doForward(modifiedRequest, account, provider, actualModel, context)

        if (result.success) {
          return result
        }

        lastError = result.error

        if (result.status && result.status < 500 && result.status !== 429) {
          break
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Unknown error'
      }
    }

    return {
      success: false,
      error: lastError || 'Request failed after retries',
      latency: Date.now() - startTime,
    }
  }

  /**
   * Execute Forward
   */
  private async doForward(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext
  ): Promise<ForwardResult> {
    const startTime = Date.now()

    const dedicatedForwarder = this.providerForwarders.find(forwarder => forwarder.matches(provider))
    if (dedicatedForwarder) {
      return dedicatedForwarder.forward(request, account, provider, actualModel, startTime)
    }

    try {
      const chatPath = provider.chatPath || '/chat/completions'
      const url = this.buildUrl(provider, chatPath)
      const headers = this.buildHeaders(provider, account)
      const body = this.buildRequestBody(request, actualModel, account)

      const axiosConfig: AxiosRequestConfig = {
        method: 'POST',
        url,
        headers,
        data: body,
        timeout: proxyStatusManager.getConfig().timeout,
        responseType: request.stream ? 'stream' : 'json',
        validateStatus: () => true,
      }

      const response: AxiosResponse = await this.axiosInstance.request(axiosConfig)
      const latency = Date.now() - startTime

      if (response.status >= 400) {
        return {
          success: false,
          status: response.status,
          error: this.extractErrorMessage(response),
          latency,
        }
      }

      if (request.stream) {
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: response.data,
          latency,
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: response.data,
        latency,
      }
    } catch (error) {
      const latency = Date.now() - startTime

      if (error instanceof AxiosError) {
        return {
          success: false,
          status: error.response?.status,
          error: error.message,
          latency,
        }
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * DeepSeek Dedicated Forward
   */
  private async forwardDeepSeek(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }

      const adapter = new DeepSeekAdapter(provider, account)
      
      const { response, sessionId } = await adapter.chatCompletion({
        model: request.model,
        messages: transformedRequest.messages as any,
        stream: transformedRequest.stream,
        temperature: transformedRequest.temperature,
        web_search: transformedRequest.web_search,
        reasoning_effort: transformedRequest.reasoning_effort,
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        if (response.data) {
          if (typeof response.data === 'string') {
            errorMessage = response.data
          } else if (response.data.msg) {
            errorMessage = response.data.msg
          } else if (response.data.error?.message) {
            errorMessage = response.data.error.message
          }
        }
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      // Prepare callback for deleting session
      const deleteSessionCallback = shouldDeleteSession()
        ? async () => {
            try {
              await adapter.deleteSession(sessionId)
            } catch (error) {
              console.error('[DeepSeek] Failed to delete session:', error)
            }
          }
        : undefined

      // DeepSeek always returns streaming response
      const handler = new DeepSeekStreamHandler(
        actualModel,
        sessionId,
        deleteSessionCallback,
        transformedRequest.web_search,
        transformedRequest.reasoning_effort,
        transformed.plan,
        request.model
      )
      
      if (request.stream) {
        const transformedStream = await handler.handleStream(response.data)
        
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: sessionId,
        }
      }

      // Non-streaming requests need to collect stream data and convert
      const result = await handler.handleNonStream(response.data)
      
      this.applyToolCallsToResponse(result, transformed)
      
      if (deleteSessionCallback) {
        await deleteSessionCallback()
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: sessionId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * GLM Dedicated Forward
   *
   * v1.7.3 起带「沙箱幻觉」兜底：chatglm 网页版可能给某一轮挂上代码解释器，模型
   * 于是把 /mnt/data 这类沙箱目录当成用户工作区报出来。这一轮的标志是「一个工具
   * 调用都没有 + 正文命中沙箱痕迹」，作废后重开一次。
   */
  /**
   * 单个请求允许的兜底重开次数。
   *
   * 所有判据共享这一个预算：以前沙箱、工具否决、只说不做各留 2 次，叠加起来
   * 最坏情况要打 6 次上游；改成一个全局预算后，成本可预期。
   * 环境变量 `AFS_MAX_GUARD_RETRY` 可调（0～3，默认 2）。
   */
  private guardRetryBudget(): number {
    // 默认 2 次重开（总共 3 轮）。1 次不够：16:02 现场是先命中 fake_limit 重开，
    // 重开那轮又谎称写好了文件、命中落盘核验，恰好卡在预算边界上，假回复直接交付。
    // 两道判据是先后命中的，各自需要一次机会。
    const parsed = Number.parseInt(process.env.AFS_MAX_GUARD_RETRY ?? '2', 10)
    if (!Number.isFinite(parsed)) return 2
    return Math.max(0, Math.min(3, parsed))
  }

  /**
   * 话术类判据是否允许触发重试。
   *
   * 默认关闭：话术是开放集合，扩一条就漏一条，实测「识别 + 重试」在复杂任务上
   * 最高只有 25% 命中率，而且纠偏消息本身会逼出新的失败话术（实测逼出
   * 「我只有 open_url」）。现在它们只产出诊断日志，重试只由客观核验决定。
   */
  private phraseRetryEnabled(): boolean {
    return process.env.AFS_PHRASE_RETRY === '1'
  }

  /** 把核验过程中的非重试信号写进日志，便于灰度观察误伤。 */
  /**
   * 重试用尽后，若回复仍声称写了不存在的文件，在正文末尾附一行事实说明。
   *
   * 16:02 现场：第 2 轮回复里写着「已完成！NBA今日战况Excel表已成功创建」，
   * 磁盘上根本没有这个文件，用户照着路径去找，找不到。代理层已经核验出结论，
   * 却把假结论原样交付——这一层必须堵住。
   *
   * 只在 missing_target（父目录存在、文件确实不存在）时调用；远程客户端那种
   * 「父目录都不存在」的情况判 unverifiable，不会走到这里。
   */
  private annotateMissingOutput(result: any, targets: string[]): void {
    const message = result?.choices?.[0]?.message
    if (!message || targets.length === 0) return
    const note =
      `\n\n---\n⚠️ AFS 核验：以上回复声称写入了 ${targets.join('、')}，` +
      `但该路径在这台机器上不存在，文件并没有真正生成。请勿按上面的路径查找。`
    const content = message.content
    if (typeof content === 'string') {
      message.content = `${content}${note}`
    } else if (Array.isArray(content)) {
      content.push({ type: 'text', text: note })
    }
  }

  /** 交付前剥掉协议标记：`[done] files=…` 是内部核算用的，不该给用户看。 */
  private stripTurnState(result: any): void {
    const message = result?.choices?.[0]?.message
    if (!message) return
    const content = message.content
    if (typeof content === 'string') {
      if (!content) return
      const cleaned = stripTurnMarker(content)
      message.content = cleaned || (Array.isArray(message.tool_calls) && message.tool_calls.length > 0 ? '' : '完成。')
      return
    }
    if (Array.isArray(content)) {
      const text = content
        .map((part: any) => (typeof part === 'string' ? part : (part?.text ?? '')))
        .join('\n')
      const cleaned = stripTurnMarker(text)
      if (cleaned !== text) message.content = cleaned
    }
  }

  /**
   * 重开次数用尽且这一轮没按协议收尾：给用户一个事实标注。
   *
   * 不写「模型撒谎」这种定性，只陈述可核验的事实——这一轮没有工具调用、没有产物
   * 声明，所以上面那段总结没有被验证过。用户据此自己判断要不要再问一次。
   */
  private annotateUnverifiedTurn(result: any): void {
    const message = result?.choices?.[0]?.message
    if (!message) return
    const note =
      '\n\n---\n⚠️ AFS 提示：以上这条回复没有按协议以工具调用或完成标记结尾，' +
      '本轮没有任何工具真正执行，内容未经核验。若任务涉及文件或实时数据，请再发一次「继续」。'
    const content = message.content
    if (typeof content === 'string') {
      if (content.includes('⚠️ AFS 提示')) return
      message.content = `${content}${note}`
    } else if (Array.isArray(content)) {
      content.push({ type: 'text', text: note })
    }
  }

  private logGroundingDiagnostics(provider: string, verdict: ReturnType<typeof detectFalseFileClaim>): void {
    if (verdict.reason === 'alien_root') {
      storeManager.addLog(
        'info',
        `[ToolCalling] 诊断：${provider} 本轮提到本机不存在的路径根（${verdict.alien.join('、')}），未重试`,
      )
      return
    }
    if (verdict.reason === 'unverifiable') {
      storeManager.addLog(
        'info',
        `[ToolCalling] 诊断：${provider} 声称写入 ${verdict.targets.join('、')}，但父目录不存在，无法核验，未重试`,
      )
      return
    }
    if (verdict.stale.length > 0) {
      storeManager.addLog(
        'info',
        `[ToolCalling] 诊断：${provider} 声称写入的文件已存在但修改时间偏旧（${verdict.stale.join('、')}），按幂等放行`,
      )
    }
  }

  private async forwardGLM(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const maxAttempts = 1 + this.guardRetryBudget()
      // 三态违约的重开单独计数：它覆盖「零调用就收工」这一大类，但不该独吞全部预算。
      const turnStateBudget = turnStateRetryBudget()
      let turnStateRetries = 0
      const adapter = new GLMAdapter(provider, account)
      let lastResponse: any = null
      let result: any = null
      let handler: GLMStreamHandler | null = null
      let retryHint: string | null = null

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const transformed = this.transformRequestForPromptToolUse(request, provider)
        const transformedRequest = {
          ...request,
          messages: retryHint
            ? [...transformed.messages, { role: 'user' as const, content: retryHint }]
            : transformed.messages,
          tools: transformed.tools,
        }

        const { response } = await adapter.chatCompletion({
          model: actualModel,
          originalModel: request.model,
          messages: transformedRequest.messages,
          stream: transformedRequest.stream,
          temperature: transformedRequest.temperature,
          web_search: transformedRequest.web_search,
          reasoning_effort: transformedRequest.reasoning_effort,
          deep_research: transformedRequest.deep_research,
        })

        if (response.status >= 400) {
          let errorMessage = `HTTP ${response.status}`
          if (response.data) {
            if (typeof response.data === 'string') {
              errorMessage = response.data
            } else if (response.data.msg) {
              errorMessage = response.data.msg
            } else if (response.data.message) {
              errorMessage = response.data.message
            } else if (response.data.error?.message) {
              errorMessage = response.data.error.message
            }
          }
          return {
            success: false,
            status: response.status,
            error: errorMessage,
            latency: Date.now() - startTime,
          }
        }

        // 上游（chatglm.cn）不返回 usage，把提示词原文交给 handler 以便估算 prompt_tokens，
        // 否则所有 GLM 请求在统计里都算 2 个 token。
        const attemptHandler = new GLMStreamHandler(
          actualModel,
          undefined,
          undefined,
          transformed.plan,
          buildPromptText(transformed.messages, transformed.tools),
        )

        // GLM web 流式输出的是增量 part，会把文本 XML 拆碎导致实时解析失败。
        // 统一收集完整响应（非流式路径在 finish 事件拿到完整 part），解析后再转 SSE。
        const attemptResult = await attemptHandler.handleNonStream(response.data)

        this.applyToolCallsToResponse(attemptResult, transformed)

        // 先做客观核验：声称写了文件但文件不存在，是唯一允许直接触发重开的判据。
        const grounding = detectFalseFileClaim(attemptResult, { messages: transformed.messages })
        // 动作对账：声称「已获取数据」但账本里没有一次成功调用，或失败了就收工。
        const ledger = detectUnbackedProgress(attemptResult, transformed.plan, {
          messages: transformed.messages,
          userText: lastUserText(transformed.messages),
        })
        // 判定结果必须落日志：判据没触发时，只能靠这行区分「没命中」和「没跑」。
        // not_managed / no_tools 是客户端自己发的小请求（标题生成等），打出来只是噪音。
        if (ledger.reason !== 'has_tool_calls' && ledger.reason !== 'not_managed' && ledger.reason !== 'no_tools') {
          storeManager.addLog(
            'info',
            `[ToolCalling] 对账：GLM ok=${ledger.okCount} fail=${ledger.failCount} reason=${ledger.reason} retry=${ledger.retry}`,
          )
        }
        // 话术类判定降级为诊断，不再各自决定重试。
        const sandbox = detectSandboxHallucination(
          attemptResult,
          transformed.plan,
          lastUserText(transformed.messages),
        )

        const convId = shouldDeleteSession() ? attemptHandler.getConversationId() : null
        if (convId) {
          await adapter.deleteConversation(convId)
        }

        // 三态协议：不再从措辞推断「是否结束」，只看有没有按协议打结尾状态。
        const turnState = detectTurnState(attemptResult, transformed.plan, {
          messages: transformed.messages,
          userText: lastUserText(transformed.messages),
        })
        if (turnState.reason !== 'has_tool_calls' && turnState.reason !== 'not_managed') {
          storeManager.addLog(
            'info',
            `[ToolCalling] 三态：GLM state=${turnState.state} reason=${turnState.reason} retry=${turnState.retry}`,
          )
        }
        // [done] 且产物经磁盘确认 → 这是最硬的完成证据，后续词表判据一律让路。
        const doneConfirmed = turnState.reason === 'done_verified'

        if (grounding.retry) {
          if (attempt < maxAttempts) {
            storeManager.addLog(
              'warn',
              `[ToolCalling] 核验失败：GLM 声称写入 ${grounding.missing.join('、')} 但文件不存在，第 ${attempt} 轮作废，重开一轮（带纠偏提示）`,
            )
            retryHint = groundingNudge(grounding.missing, transformed.plan.protocol)
            continue
          }
          storeManager.addLog(
            'warn',
            `[ToolCalling] 核验失败：第 ${attempt} 轮声称写入的文件仍不存在（${grounding.missing.join('、')}），重试已用尽`,
          )
          this.annotateMissingOutput(attemptResult, grounding.missing)
        } else if (
          turnState.retry &&
          !doneConfirmed &&
          attempt < maxAttempts &&
          turnStateRetries < turnStateBudget
        ) {
          turnStateRetries += 1
          storeManager.addLog(
            'warn',
            `[ToolCalling] 三态违约：GLM 第 ${attempt} 轮 state=${turnState.state} reason=${turnState.reason}${
              turnState.fake.length > 0 ? `（虚构理由：${turnState.fake[0]}）` : ''
            }，作废一轮重开（带格式纠偏）`,
          )
          retryHint = turnStateNudge(turnState, transformed.plan.protocol)
          continue
        } else if (turnState.retry && !doneConfirmed) {
          storeManager.addLog(
            'warn',
            `[ToolCalling] 三态违约：GLM 第 ${attempt} 轮仍未按协议收尾（${turnState.reason}），重开次数已用尽`,
          )
          if (turnState.missing.length > 0) {
            this.annotateMissingOutput(attemptResult, turnState.missing)
          }
          if (turnState.reason === 'undeclared_task' || turnState.reason === 'leaked_tool_call') {
            this.annotateUnverifiedTurn(attemptResult)
          }
        } else if (ledger.retry && !doneConfirmed && attempt < maxAttempts) {
          storeManager.addLog(
            'warn',
            `[ToolCalling] 核验失败：GLM 第 ${attempt} 轮${
              ledger.reason === 'unbacked_claim'
                ? `声称已获取数据（${ledger.matched[0] ?? ''}）但成功调用数为 0`
                : ledger.reason === 'fake_limit'
                  ? `以「${ledger.matched[0] ?? '轮数上限'}」为由收工（该限制不存在）`
                  : '工具失败后直接收工'
            }，作废一轮重开（带纠偏提示）`,
          )
          retryHint = progressNudge(ledger, transformed.plan.protocol)
          continue
        } else if (ledger.retry && !doneConfirmed) {
          storeManager.addLog(
            'warn',
            `[ToolCalling] 核验失败：第 ${attempt} 轮仍未真正取到数据（${ledger.reason}），重试已用尽`,
          )
        } else if (sandbox.retry) {
          if (this.phraseRetryEnabled() && attempt < maxAttempts) {
            storeManager.addLog(
              'warn',
              `[ToolCalling] 命中沙箱幻觉（${sandbox.matched.join('/')}），第 ${attempt} 轮作废，重开一轮（话术判定，AFS_PHRASE_RETRY=1）`,
            )
            retryHint = sandboxNudge(transformed.plan.protocol)
            continue
          }
          storeManager.addLog(
            'info',
            `[ToolCalling] 诊断：GLM 本轮疑似沙箱幻觉（${sandbox.matched.join('/')}），仅记录不重试`,
          )
        } else {
          this.logGroundingDiagnostics('GLM', grounding)
        }

        lastResponse = response
        result = attemptResult
        handler = attemptHandler
        this.stripTurnState(attemptResult)
        break
      }

      if (!result || !handler) {
        return {
          success: false,
          error: 'GLM 未返回可用结果',
          latency: Date.now() - startTime,
        }
      }

      const latency = Date.now() - startTime
      const headers = lastResponse ? this.extractHeaders(lastResponse.headers) : {}
      const status = lastResponse?.status ?? 200

      if (request.stream) {
        const sseStream = resultToSSE(result)

        return {
          success: true,
          status,
          headers,
          stream: sseStream,
          skipTransform: true,
          latency,
          providerSessionId: handler.getConversationId() ?? undefined,
        }
      }

      return {
        success: true,
        status,
        headers,
        body: result,
        latency,
        providerSessionId: handler.getConversationId() ?? undefined,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  private async forwardKimi(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)

      // Kimi 网页版偶发「有工具却宣称没工具」：注入了 30 个工具，却回一句「我没有
      // 获取实时天气数据的工具」，再建议用户自己去搜。这类回答只能整轮作废，而流式
      // 一旦吐字就收不回来——所以托管模式下先收完整轮、判定后再决定输出（非托管
      // 请求保持原来的直通流式，不加延迟）。
      const managed = transformed.plan.mode === 'managed' && transformed.plan.shouldParseResponse
      const maxAttempts = managed ? 1 + this.guardRetryBudget() : 1
      const turnStateBudget = turnStateRetryBudget()
      let turnStateRetries = 0
      const latencyBase = startTime

      if (!managed) {
        const adapter = new KimiAdapter(provider, account)
        const { response, conversationId } = await adapter.chatCompletion({
          model: actualModel,
          originalModel: request.model,
          messages: transformed.messages,
          stream: request.stream,
          temperature: request.temperature,
          enableThinking: !!request.reasoning_effort,
          enableWebSearch: !!request.web_search,
          reasoning_effort: request.reasoning_effort || undefined,
        })

        const latency = Date.now() - latencyBase

        if (response.status >= 400) {
          return {
            success: false,
            status: response.status,
            error: `HTTP ${response.status}`,
            latency,
          }
        }

        const handler = new KimiStreamHandler(actualModel, conversationId, !!request.reasoning_effort, transformed.plan)

        if (request.stream) {
          const transformedStream = await handler.handleStream(response.data)

          // Add delete conversation callback if needed
          if (shouldDeleteSession()) {
            const originalEnd = transformedStream.end.bind(transformedStream)
            transformedStream.end = function(chunk?: any, encoding?: any, callback?: any) {
              const realChatId = handler.getConversationId()
              if (realChatId) {
                adapter.deleteConversation(realChatId).catch(err => {
                  console.error('[Kimi] Failed to delete conversation:', err)
                })
              }
              return originalEnd(chunk, encoding, callback)
            }
          }

          return {
            success: true,
            status: response.status,
            headers: this.extractHeaders(response.headers),
            stream: transformedStream,
            skipTransform: true,
            latency,
            providerSessionId: undefined,
          }
        }

        const result = await handler.handleNonStream(response.data)
        this.applyToolCallsToResponse(result, transformed)

        if (shouldDeleteSession()) {
          const realChatId = handler.getConversationId()
          if (realChatId) {
            await adapter.deleteConversation(realChatId)
          }
        }

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          body: result,
          latency,
          providerSessionId: handler.getConversationId() ?? undefined,
        }
      }

      // ── 托管模式：收完整轮 → 判定 → 必要时重开 ──────────────────────────
      let finalResult: any = null
      let finalHandler: KimiStreamHandler | null = null
      let finalResponse: any = null
      // 重试时用纠偏消息替换「裸重发」：同样的 messages 重发一遍，模型大概率再犯同样的错。
      let nudge: string | null = null

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const adapter = new KimiAdapter(provider, account)
        const attemptMessages = nudge
          ? [...transformed.messages, { role: 'user' as const, content: nudge }]
          : transformed.messages
        const { response, conversationId } = await adapter.chatCompletion({
          model: actualModel,
          originalModel: request.model,
          messages: attemptMessages,
          stream: true,
          temperature: request.temperature,
          enableThinking: !!request.reasoning_effort,
          enableWebSearch: !!request.web_search,
          reasoning_effort: request.reasoning_effort || undefined,
        })

        if (response.status >= 400) {
          return {
            success: false,
            status: response.status,
            error: `HTTP ${response.status}`,
            latency: Date.now() - latencyBase,
          }
        }

        const handler = new KimiStreamHandler(actualModel, conversationId, !!request.reasoning_effort, transformed.plan)
        const result = await handler.handleNonStream(response.data)
        this.applyToolCallsToResponse(result, transformed)

        const userText = lastUserText(transformed.messages)
        // 客观核验优先：文件到底在不在，与它用什么措辞无关。
        const grounding = detectFalseFileClaim(result, { messages: transformed.messages })
        // 动作对账：正文说「已获取」但账本里没有成功调用，或失败了就收工。
        const ledger = detectUnbackedProgress(result, transformed.plan, {
          messages: transformed.messages,
          userText,
        })
        if (ledger.reason !== 'has_tool_calls' && ledger.reason !== 'not_managed' && ledger.reason !== 'no_tools') {
          storeManager.addLog(
            'info',
            `[ToolCalling] 对账：Kimi ok=${ledger.okCount} fail=${ledger.failCount} reason=${ledger.reason} retry=${ledger.retry}`,
          )
        }
        // 话术类判定保留为诊断信号，默认不再触发重试。
        const refusal = detectToolRefusal(result, transformed.plan, userText)
        const planOnly = refusal.retry ? refusal : detectPlanOnlyTurn(result, transformed.plan, userText)
        const phraseFailure = planOnly.retry ? planOnly : null
        const reasonText =
          phraseFailure?.reason === 'plan_only'
            ? `只说了计划没动手（${phraseFailure.matched.join('/')}）`
            : `把问题推回给用户、没调工具（${phraseFailure?.matched.join('/') ?? ''}）`
        const convId = handler.getConversationId()

        // 三态协议：不再从措辞推断「是否结束」，只看有没有按协议打结尾状态。
        const turnState = detectTurnState(result, transformed.plan, {
          messages: transformed.messages,
          userText,
        })
        if (turnState.reason !== 'has_tool_calls' && turnState.reason !== 'not_managed') {
          storeManager.addLog(
            'info',
            `[ToolCalling] 三态：Kimi state=${turnState.state} reason=${turnState.reason} retry=${turnState.retry}`,
          )
        }
        // [done] 且产物经磁盘确认 → 最硬的完成证据，后续词表判据一律让路。
        const doneConfirmed = turnState.reason === 'done_verified'

        if (grounding.retry && attempt < maxAttempts) {
          storeManager.addLog(
            'warn',
            `[ToolCalling] 核验失败：Kimi 声称写入 ${grounding.missing.join('、')} 但文件不存在，第 ${attempt} 轮作废，重开一轮（带纠偏提示）`,
          )
          nudge = groundingNudge(grounding.missing, transformed.plan.protocol)
          if (shouldDeleteSession() && convId) {
            await adapter.deleteConversation(convId).catch(() => {})
          }
          continue
        }

        if (grounding.retry) {
          storeManager.addLog(
            'warn',
            `[ToolCalling] 核验失败：Kimi 第 ${attempt} 轮声称写入的文件仍不存在（${grounding.missing.join('、')}），重试已用尽`,
          )
          this.annotateMissingOutput(result, grounding.missing)
        }

        if (turnState.retry && !grounding.retry && !doneConfirmed) {
          if (attempt < maxAttempts && turnStateRetries < turnStateBudget) {
            turnStateRetries += 1
            storeManager.addLog(
              'warn',
              `[ToolCalling] 三态违约：Kimi 第 ${attempt} 轮 state=${turnState.state} reason=${turnState.reason}${
                turnState.fake.length > 0 ? `（虚构理由：${turnState.fake[0]}）` : ''
              }，作废一轮重开（带格式纠偏）`,
            )
            nudge = turnStateNudge(turnState, transformed.plan.protocol)
            if (shouldDeleteSession() && convId) {
              await adapter.deleteConversation(convId).catch(() => {})
            }
            continue
          }
          storeManager.addLog(
            'warn',
            `[ToolCalling] 三态违约：Kimi 第 ${attempt} 轮仍未按协议收尾（${turnState.reason}），重开次数已用尽`,
          )
          if (turnState.missing.length > 0) this.annotateMissingOutput(result, turnState.missing)
          if (turnState.reason === 'undeclared_task' || turnState.reason === 'leaked_tool_call') {
            this.annotateUnverifiedTurn(result)
          }
        }

        if (ledger.retry && !grounding.retry && !doneConfirmed && !turnState.retry) {
          if (attempt < maxAttempts) {
            storeManager.addLog(
              'warn',
              `[ToolCalling] 核验失败：Kimi 第 ${attempt} 轮${
                ledger.reason === 'unbacked_claim'
                  ? `声称已获取数据（${ledger.matched[0] ?? ''}）但成功调用数为 0`
                  : ledger.reason === 'fake_limit'
                    ? `以「${ledger.matched[0] ?? '轮数上限'}」为由收工（该限制不存在）`
                    : '工具失败后直接收工'
              }，作废一轮重开（带纠偏提示）`,
            )
            nudge = progressNudge(ledger, transformed.plan.protocol)
            if (shouldDeleteSession() && convId) {
              await adapter.deleteConversation(convId).catch(() => {})
            }
            continue
          }
          storeManager.addLog(
            'warn',
            `[ToolCalling] 核验失败：Kimi 第 ${attempt} 轮仍未真正取到数据（${ledger.reason}），重试已用尽`,
          )
        }

        if (phraseFailure && !grounding.retry && !ledger.retry && !turnState.retry) {
          if (this.phraseRetryEnabled() && attempt < maxAttempts) {
            storeManager.addLog(
              'warn',
              `[ToolCalling] Kimi 本轮${reasonText}，第 ${attempt} 轮作废，重开一轮（话术判定，AFS_PHRASE_RETRY=1）`,
            )
            nudge =
              phraseFailure.reason === 'plan_only'
                ? planOnlyNudge(transformed.plan.protocol)
                : toolRefusalNudge(transformed.plan.protocol)
            if (shouldDeleteSession() && convId) {
              await adapter.deleteConversation(convId).catch(() => {})
            }
            continue
          }
          storeManager.addLog('info', `[ToolCalling] 诊断：Kimi 本轮${reasonText}，仅记录不重试`)
        }

        this.logGroundingDiagnostics('Kimi', grounding)

        this.stripTurnState(result)
        finalResult = result
        finalHandler = handler
        finalResponse = response
        break
      }

      if (!finalResult || !finalHandler || !finalResponse) {
        return {
          success: false,
          error: 'Kimi 未返回可用结果',
          latency: Date.now() - latencyBase,
        }
      }

      const latency = Date.now() - latencyBase
      const headers = this.extractHeaders(finalResponse.headers)

      if (shouldDeleteSession()) {
        const realChatId = finalHandler.getConversationId()
        if (realChatId) {
          await new KimiAdapter(provider, account).deleteConversation(realChatId).catch(() => {})
        }
      }

      if (request.stream) {
        return {
          success: true,
          status: finalResponse.status,
          headers,
          stream: resultToSSE(finalResult),
          skipTransform: true,
          latency,
          providerSessionId: undefined,
        }
      }

      return {
        success: true,
        status: finalResponse.status,
        headers,
        body: finalResult,
        latency,
        providerSessionId: finalHandler.getConversationId() ?? undefined,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Qwen Dedicated Forward
   */
  private async forwardQwen(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }

      const adapter = new QwenAdapter(provider, account)
      const { response, sessionId, reqId } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.model,
        messages: transformedRequest.messages as any,
        stream: request.stream,
        temperature: request.temperature,
        enableThinking: !!request.reasoning_effort,
        enableWebSearch: !!request.web_search,
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteSessionCallback = shouldDeleteSession()
        ? async (sid: string) => {
            try {
              await adapter.deleteSession(sid)
            } catch (err) {
              console.error('[Qwen] Failed to delete session:', err)
            }
          }
        : undefined

      const handler = new QwenStreamHandler(actualModel, deleteSessionCallback, transformed.plan)

      if (request.stream) {
        const transformedStream = await handler.handleStream(response.data, response)

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: sessionId,
        }
      }

      const result = await handler.handleNonStream(response.data, response)

      this.applyToolCallsToResponse(result, transformed)

      const sid = handler.getSessionId()
      if (deleteSessionCallback && sid) {
        await deleteSessionCallback(sid)
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: sessionId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Qwen AI (International) Dedicated Forward
   */
  private async forwardQwenAi(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new QwenAiAdapter(provider, account)
      const { response, chatId, parentId } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.model,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
        enable_thinking: !!request.reasoning_effort,
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const handler = new QwenAiStreamHandler(actualModel)
      handler.setChatId(chatId)

      if (request.stream) {
        const transformedStream = await handler.handleStream(response.data)

        if (shouldDeleteSession()) {
          const originalEnd = transformedStream.end.bind(transformedStream)
          transformedStream.end = function(chunk?: any, encoding?: any, callback?: any) {
            adapter.deleteChat(chatId).catch(err => {
              console.error('[QwenAI] Failed to delete chat:', err)
            })
            return originalEnd(chunk, encoding, callback)
          }
        }

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: chatId,
        }
      }

      const result = await handler.handleNonStream(response.data)

      this.applyToolCallsToResponse(result, transformed)

      if (shouldDeleteSession()) {
        await adapter.deleteChat(chatId)
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: chatId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Z.ai Dedicated Forward
   */
  private async forwardZai(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    console.log('[forwardZai] actualModel:', actualModel)
    console.log('[forwardZai] provider.modelMappings:', provider.modelMappings)
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new ZaiAdapter(provider, account)
      const { response, chatId, requestId } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.model,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
        web_search: request.web_search,
        reasoning_effort: request.reasoning_effort,
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteChatCallback = shouldDeleteSession()
        ? async (cid: string) => {
            try {
              await adapter.deleteChat(cid)
            } catch (error) {
              console.error('[Z.ai] Failed to delete chat:', error)
            }
          }
        : undefined

      const handler = new ZaiStreamHandler(actualModel, deleteChatCallback)
      handler.setChatId(chatId)
      
      if (request.stream === true) {
        const transformedStream = await handler.handleStream(response.data)
        
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: chatId,
        }
      }

      const result = await handler.handleNonStream(response.data)

      this.applyToolCallsToResponse(result, transformed)
      
      if (deleteChatCallback) {
        await deleteChatCallback(chatId)
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: chatId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * MiniMax Dedicated Forward
   */
  private async forwardMiniMax(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    console.log('[forwardMiniMax] actualModel:', actualModel)
    console.log('[forwardMiniMax] provider.modelMappings:', provider.modelMappings)
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new MiniMaxAdapter(provider, account)
      const { response, stream, chatId } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.model,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
      })

      const latency = Date.now() - startTime

      if (response && response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteChatCallback = shouldDeleteSession()
        ? async (cid: string) => {
            try {
              await adapter.deleteChat(cid)
            } catch (error) {
              console.error('[MiniMax] Failed to delete chat:', error)
            }
          }
        : undefined

      if (request.stream === true && stream) {
        console.log('[forwardMiniMax] Using polling stream')
        
        if (deleteChatCallback) {
          const originalStream = stream.stream as unknown as PassThrough
          const originalEnd = originalStream.end.bind(originalStream)
          originalStream.end = function(chunk?: any, encoding?: any, callback?: any) {
            deleteChatCallback(chatId).catch(err => {
              console.error('[MiniMax] Failed to delete chat:', err)
            })
            return originalEnd(chunk, encoding, callback)
          }
        }
        
        return {
          success: true,
          status: 200,
          headers: {},
          stream: stream.stream as any,
          skipTransform: true,
          latency,
          providerSessionId: chatId,
        }
      }

      if (response) {
        this.applyToolCallsToResponse(response.data, transformed)
        
        if (deleteChatCallback) {
          await deleteChatCallback(chatId)
        }

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          body: response.data,
          latency,
          providerSessionId: chatId,
        }
      }

      return {
        success: false,
        error: 'No response or stream received',
        latency,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Mimo Dedicated Forward
   * Uses Mimo adapter for Xiaomi AI Studio
   */
  private async forwardMimo(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }
      const adapter = new MimoAdapter(provider, account)

      const { response, conversationId, query } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.originalModel,
        messages: transformedRequest.messages as any,
        stream: transformedRequest.stream,
        temperature: transformedRequest.temperature,
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteSessionCallback = shouldDeleteSession()
        ? async (sessionId: string) => {
            try {
              await adapter.deleteSession(sessionId)
            } catch (error) {
              console.error('[Mimo] Failed to delete session:', error)
            }
          }
        : undefined

      const handler = new MimoStreamHandler(actualModel, conversationId, 'separate', transformed.plan)

      if (request.stream) {
        const transformedStream = new PassThrough()
        const openAIStream = handler.handleStream(response.data)

        ;(async () => {
          try {
            for await (const chunk of openAIStream) {
              transformedStream.write(chunk)
            }
            await adapter.generateConversationTitle(
              conversationId,
              query,
              handler.getAssistantContentForTitle()
            )
            if (deleteSessionCallback) {
              await deleteSessionCallback(conversationId)
            }
            transformedStream.end()
          } catch (error) {
            console.error('[Mimo] Stream error:', error)
            transformedStream.end()
          }
        })()

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: conversationId,
        }
      }

      const result = await handler.handleNonStream(response.data)
      const parsedResult = JSON.parse(result)
      this.applyToolCallsToResponse(parsedResult, transformed)
      await adapter.generateConversationTitle(
        conversationId,
        query,
        handler.getAssistantContentForTitle()
      )
      if (deleteSessionCallback) {
        await deleteSessionCallback(conversationId)
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: parsedResult,
        skipTransform: true,
        latency,
        providerSessionId: conversationId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      console.error('[Mimo] Forward error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Perplexity Dedicated Forward
   * Uses Electron's net API to bypass Cloudflare protection
   */
  private async forwardPerplexity(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    console.log('[forwardPerplexity] actualModel:', actualModel)
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new PerplexityAdapter(provider, account)
      
      const { stream, sessionId } = await adapter.chatCompletion({
        model: actualModel,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
      })

      const latency = Date.now() - startTime

      if (request.stream === true) {
        const deleteSessionCallback = shouldDeleteSession()
          ? async () => {
              try {
                await adapter.deleteSession(sessionId)
              } catch (error) {
                console.error('[Perplexity] Failed to delete session:', error)
              }
            }
          : undefined

        const handler = new PerplexityStreamHandler(actualModel, sessionId, deleteSessionCallback, adapter)
        const transformedStream = await handler.handleStream(stream)
        
        return {
          success: true,
          status: 200,
          headers: {},
          stream: transformedStream as any,
          skipTransform: true,
          latency,
          providerSessionId: sessionId,
        }
      }

      const handler = new PerplexityStreamHandler(actualModel, sessionId, undefined, adapter)
      const result = await handler.handleNonStream(stream)
      
      this.applyToolCallsToResponse(result, transformed)
      
      if (shouldDeleteSession()) {
        await adapter.deleteSession(sessionId)
      }
      
      return {
        success: true,
        status: 200,
        headers: {},
        body: result,
        latency,
        providerSessionId: sessionId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Build URL
   */
  private buildUrl(provider: Provider, path: string): string {
    let baseUrl = provider.apiEndpoint

    if (baseUrl.endsWith('/')) {
      baseUrl = baseUrl.slice(0, -1)
    }

    if (!path.startsWith('/')) {
      path = '/' + path
    }

    if (baseUrl.includes('/v1') && path.startsWith('/v1')) {
      path = path.slice(3)
    }

    return `${baseUrl}${path}`
  }

  /**
   * Build Request Headers
   */
  private buildHeaders(provider: Provider, account: Account): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...provider.headers,
    }

    const credentials = account.credentials

    if (credentials.token) {
      headers['Authorization'] = `Bearer ${credentials.token}`
    } else if (credentials.apiKey) {
      headers['Authorization'] = `Bearer ${credentials.apiKey}`
    } else if (credentials.accessToken) {
      headers['Authorization'] = `Bearer ${credentials.accessToken}`
    } else if (credentials.refreshToken) {
      headers['Authorization'] = `Bearer ${credentials.refreshToken}`
    }

    if (credentials.cookie) {
      headers['Cookie'] = credentials.cookie
    }

    if (credentials.sessionKey) {
      headers['X-Session-Key'] = credentials.sessionKey
    }

    return headers
  }

  /**
   * Build Request Body
   */
  private buildRequestBody(
    request: ChatCompletionRequest,
    actualModel: string,
    account: Account
  ): any {
    const body: any = {
      model: actualModel,
      messages: request.messages,
      stream: request.stream || false,
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature
    }

    if (request.top_p !== undefined) {
      body.top_p = request.top_p
    }

    if (request.n !== undefined) {
      body.n = request.n
    }

    if (request.stop !== undefined) {
      body.stop = request.stop
    }

    if (request.max_tokens !== undefined) {
      body.max_tokens = request.max_tokens
    }

    if (request.presence_penalty !== undefined) {
      body.presence_penalty = request.presence_penalty
    }

    if (request.frequency_penalty !== undefined) {
      body.frequency_penalty = request.frequency_penalty
    }

    if (request.logit_bias !== undefined) {
      body.logit_bias = request.logit_bias
    }

    if (request.user !== undefined) {
      body.user = request.user
    }

    return body
  }

  /**
   * Extract Response Headers
   */
  private extractHeaders(headers: any): Record<string, string> {
    const result: Record<string, string> = {}

    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string') {
        result[key] = value
      } else if (Array.isArray(value)) {
        result[key] = value.join(', ')
      }
    }

    return result
  }

  /**
   * Extract Error Message
   */
  private extractErrorMessage(response: AxiosResponse): string {
    if (response.data) {
      if (typeof response.data === 'string') {
        return response.data
      }

      if (response.data.error?.message) {
        return response.data.error.message
      }

      if (response.data.message) {
        return response.data.message
      }

      if (response.data.msg) {
        return response.data.msg
      }

      try {
        return JSON.stringify(response.data)
      } catch {
        return 'Unknown error'
      }
    }

    return `HTTP ${response.status}`
  }

  /**
   * Delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Forward Request to Specified URL
   */
  async forwardToUrl(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: any,
    isStream: boolean = false
  ): Promise<ForwardResult> {
    const startTime = Date.now()

    try {
      const config: AxiosRequestConfig = {
        method,
        url,
        headers,
        data: body,
        timeout: proxyStatusManager.getConfig().timeout,
        responseType: isStream ? 'stream' : 'json',
        validateStatus: () => true,
      }

      const response: AxiosResponse = await this.axiosInstance.request(config)
      const latency = Date.now() - startTime

      if (response.status >= 400) {
        return {
          success: false,
          status: response.status,
          error: this.extractErrorMessage(response),
          latency,
        }
      }

      if (isStream) {
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: response.data,
          latency,
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: response.data,
        latency,
      }
    } catch (error) {
      const latency = Date.now() - startTime

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }
}

/**
 * 把 messages + tools 拼成一段纯文本，用于估算 prompt_tokens。
 * 只服务于 GLM 这类不返回 usage 的适配器，不参与实际请求。
 */
function buildPromptText(messages: any[] = [], tools?: any): string {
  const parts: string[] = []
  for (const message of messages ?? []) {
    const content = message?.content
    if (typeof content === 'string') parts.push(content)
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === 'string') parts.push(part)
        else if (part && typeof part.text === 'string') parts.push(part.text)
      }
    }
  }
  if (tools) parts.push(JSON.stringify(tools))
  return parts.join('\n')
}

export const requestForwarder = new RequestForwarder()
export default requestForwarder
