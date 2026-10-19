/**
 * DeepSeek Adapter
 * Implements DeepSeek web API protocol
 * 
 * NOTE: Tool prompt injection is handled by Forwarder.transformRequestForPromptToolUse()
 * This adapter only handles message format conversion and API communication
 */

import axios, { AxiosResponse } from 'axios'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { PassThrough } from 'node:stream'
import { getDeepSeekHash } from '../../lib/challenge'
import type { Account, Provider } from '../../store/types'
import { resolveDeepSeekChatOptions } from './providerModelOptions'
import { getProviderToolProfile } from '../toolCalling/providerProfiles'
import { storeManager } from '../../store/store'
import {
  LOCAL_IMAGE_CACHE_MS,
  LOCAL_IMAGE_MAX_BYTES,
  MODEL_TYPE_HEADER,
  READY_FILE_STATUSES,
  UPLOAD_TARGET_PATH,
  VISION_MODEL_TYPE,
  buildMultipartBody,
  extractFileStatus,
  extractLocalImages,
  imageMimeOf,
} from './localImage'
import { collectWorkspaceImagePaths } from './workspaceReference'

const DEEPSEEK_API_BASE = 'https://chat.deepseek.com/api'

/** 上传后等待文件解析完成的最长时间与轮询间隔（PENDING → SUCCESS 通常 1-3 秒）。 */
const FILE_READY_TIMEOUT_MS = 20000
const FILE_READY_POLL_MS = 700

// 本地图片通道（配合 ds-trim-gateway 的路线 A）：
// DSH 的 @ 文件引用只把路径当文本发出来，图片字节从未进入请求。网关与用户同机，
// 把引用解析成绝对路径、注入 [[local-image:/abs/path]] 标记；本适配器消费该标记：
// 读盘 → POST /v0/file/upload_file 拿 file_id → completion 请求带 ref_file_ids，
// 模型即可原生"看到"图片。标记的抽取与组包在 ./localImage。

/** 已上传图片的 file_id 缓存：键含 size+mtime，文件被替换后自然失效。 */
const uploadedImageCache = new Map<string, { fileId: string; expiresAt: number }>()

/**
 * 给带图请求的上游流挂一个只读探针，把原始字节记进应用日志。
 *
 * 为什么需要：带 ref_file_ids 时 DeepSeek 会返回 200 + 一个**没有内容**的 SSE 流
 * （既不报错也没解释），线上只能看到"空响应"。要定位就必须看到上游到底发了什么。
 * 只在带图请求上启用，避免给普通对话制造噪音。
 */
function tapUpstreamStreamForDiagnostics(stream: NodeJS.ReadableStream): NodeJS.ReadableStream {
  const tap = new PassThrough()
  let head = ''
  let bytes = 0
  stream.on('data', (chunk: Buffer) => {
    bytes += chunk.length
    if (head.length < 2000) head += chunk.toString('utf8')
  })
  stream.on('end', () => {
    storeManager.addLog('info',
      `[DeepSeek] 图片请求上游原始流: ${bytes} 字节 | ${head.slice(0, 2000)}`)
  })
  stream.on('error', (error: Error) => {
    storeManager.addLog('error', `[DeepSeek] 图片请求上游流错误: ${error.message}`)
  })
  stream.pipe(tap as unknown as NodeJS.WritableStream)
  return tap
}

const FAKE_HEADERS = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
  Origin: 'https://chat.deepseek.com',
  Referer: 'https://chat.deepseek.com/',
  'Sec-Ch-Ua': '"Not/A)Brand";v="99", "Chromium";v="148"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'X-App-Version': '2.0.0',
  'X-Client-Locale': 'zh_CN',
  'X-Client-Platform': 'web',
  'x-Client-Timezone-Offset': '28800',
  'X-Client-Version': '2.0.0',
}

interface TokenInfo {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

interface ChallengeResponse {
  algorithm: string
  challenge: string
  salt: string
  difficulty: number
  expire_at: number
  signature: string
}

interface DeepSeekMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | null
  tool_call_id?: string
  tool_calls?: any[]
}

interface ChatCompletionRequest {
  model: string
  messages: DeepSeekMessage[]
  stream?: boolean
  temperature?: number
  web_search?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high'
  tools?: any[]
  tool_choice?: any
}

const tokenCache = new Map<string, TokenInfo>()
const sessionCache = new Map<string, { sessionId: string; createdAt: number }>()

/**
 * 清空会话缓存与图片上传缓存，强制下一次请求建新会话、重新上传图片。
 *
 * 为什么需要：图片引用被拒时服务端返回 `biz_code 9 / invalid ref file id`，
 * **被拒后该会话后续每一轮都会失败**。缓存不清掉的话，一次偶发拒绝会
 * 让这个账号接下来的 ~5 分钟全部报错；连上传缓存一起清掉，下一轮会拿到
 * 全新的 file id（此时文件早已解析完成），是最干净的恢复方式。
 */
export function clearDeepSeekSessionCache(): void {
  sessionCache.clear()
  uploadedImageCache.clear()
}

function generateRandomString(length: number, charset: string = 'alphanumeric'): string {
  const sets = {
    numeric: '0123456789',
    alphabetic: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
    alphanumeric: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
    hex: '0123456789abcdef',
  }
  const chars = sets[charset as keyof typeof sets] || sets.alphanumeric
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function generateCookie(): string {
  const timestamp = Date.now()
  return `intercom-HWWAFSESTIME=${timestamp}; HWWAFSESID=${generateRandomString(18, 'hex')}; Hm_lvt_${uuid()}=${Math.floor(timestamp / 1000)},${Math.floor(timestamp / 1000)},${Math.floor(timestamp / 1000)}; Hm_lpvt_${uuid()}=${Math.floor(timestamp / 1000)}; _frid=${uuid()}; _fr_ssid=${uuid()}; _fr_pvid=${uuid()}`
}

function unixTimestamp(): number {
  return Math.floor(Date.now() / 1000)
}

export class DeepSeekAdapter {
  private provider: Provider
  private account: Account
  private token: string

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
    console.log('[DeepSeek] Account credentials:', JSON.stringify(account.credentials, null, 2))
    this.token = account.credentials.token || account.credentials.apiKey || account.credentials.refreshToken || ''
    console.log('[DeepSeek] Using token:', this.token.substring(0, 20) + '...')
  }

  private async acquireToken(): Promise<string> {
    if (!this.token) {
      throw new Error('DeepSeek Token not configured, please add Token in account settings')
    }

    const cached = tokenCache.get(this.token)
    if (cached && cached.expiresAt > unixTimestamp()) {
      return cached.accessToken
    }

    console.log('[DeepSeek] Acquiring token...')
    
    const result = await axios.get(`${DEEPSEEK_API_BASE}/v0/users/current`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...FAKE_HEADERS,
      },
      timeout: 15000,
      validateStatus: () => true,
    })

    console.log('[DeepSeek] Token response status:', result.status)
    
    if (result.status === 401 || result.status === 403) {
      throw new Error(`Token invalid or expired, please get a new Token`)
    }

    if (result.status !== 200) {
      throw new Error(`Failed to acquire token: HTTP ${result.status}`)
    }

    // Response structure: { code: 0, data: { biz_code: 0, biz_data: { token: "..." } } }
    const bizData = result.data?.data?.biz_data || result.data?.biz_data
    if (!bizData?.token) {
      const errorMsg = result.data?.msg || result.data?.data?.biz_msg || 'Unknown error'
      console.log('[DeepSeek] Token response data:', JSON.stringify(result.data, null, 2))
      throw new Error(`Failed to acquire token: ${errorMsg}`)
    }

    const accessToken = bizData.token
    tokenCache.set(this.token, {
      accessToken,
      refreshToken: this.token,
      expiresAt: unixTimestamp() + 3600,
    })

    console.log('[DeepSeek] Token acquired successfully')
    return accessToken
  }

  private async createSession(): Promise<string> {
    const cacheKey = this.account.id
    const cached = sessionCache.get(cacheKey)
    if (cached && Date.now() - cached.createdAt < 300000) {
      return cached.sessionId
    }

    const token = await this.acquireToken()
    const result = await axios.post(
      `${DEEPSEEK_API_BASE}/v0/chat_session/create`,
      {},
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
          Cookie: generateCookie(),
        },
        timeout: 15000,
        validateStatus: () => true,
      }
    )

    console.log('[DeepSeek] Create session response:', JSON.stringify(result.data, null, 2))

    // Response structure: { code: 0, data: { biz_code: 0, biz_data: { id: "..." } } }
    const bizData = result.data?.data?.biz_data || result.data?.biz_data
    if (result.status !== 200 || !bizData?.chat_session?.id) {
      throw new Error(`Failed to create session: ${result.data?.msg || result.data?.data?.biz_msg || result.status}`)
    }

    const sessionId = bizData?.chat_session?.id
    sessionCache.set(cacheKey, { sessionId, createdAt: Date.now() })

    return sessionId
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    try {
      const token = await this.acquireToken()
      const result = await axios.post(
        `${DEEPSEEK_API_BASE}/v0/chat_session/delete`,
        { chat_session_id: sessionId },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...FAKE_HEADERS,
          },
          timeout: 15000,
          validateStatus: () => true,
        }
      )

      console.log('[DeepSeek] Delete session response:', JSON.stringify(result.data, null, 2))

      const success = result.status === 200 && result.data?.code === 0
      if (success) {
        // Clear cache
        const cacheKey = this.account.id
        sessionCache.delete(cacheKey)
        console.log('[DeepSeek] Session deleted:', sessionId)
      }
      return success
    } catch (error) {
      console.error('[DeepSeek] Failed to delete session:', error)
      return false
    }
  }

  private async getChallenge(targetPath: string): Promise<ChallengeResponse> {
    const token = await this.acquireToken()
    const result = await axios.post(
      `${DEEPSEEK_API_BASE}/v0/chat/create_pow_challenge`,
      { target_path: targetPath },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
        },
        timeout: 15000,
        validateStatus: () => true,
      }
    )

    // Response structure: { code: 0, data: { biz_code: 0, biz_data: { challenge: {...} } } }
    const bizData = result.data?.data?.biz_data || result.data?.biz_data
    if (result.status !== 200 || !bizData?.challenge) {
      throw new Error(`Failed to get challenge: ${result.data?.msg || result.data?.data?.biz_msg || result.status}`)
    }

    return bizData.challenge
  }

  private async calculateChallengeAnswer(
    challenge: ChallengeResponse,
    targetPath: string = '/api/v0/chat/completion',
  ): Promise<string> {
    const { algorithm, challenge: challengeStr, salt, difficulty, expire_at, signature } = challenge
    
    if (algorithm !== 'DeepSeekHashV1') {
      throw new Error(`Unsupported algorithm: ${algorithm}`)
    }
    
    console.log('[DeepSeek] Challenge parameters:', { difficulty, targetPath })
    
    const deepSeekHash = await getDeepSeekHash()
    const answer = deepSeekHash.calculateHash(algorithm, challengeStr, salt, difficulty, expire_at)
    
    if (answer === undefined) {
      throw new Error('Challenge calculation failed')
    }
    
    console.log('[DeepSeek] Challenge answer found:', answer)

    return Buffer.from(JSON.stringify({
      algorithm,
      challenge: challengeStr,
      salt,
      answer,
      signature,
      target_path: targetPath,
    })).toString('base64')
  }

  /** 上传一张本地图片，返回 DeepSeek 侧 file_id（带 mtime 维度的结果缓存）。 */
  private async uploadLocalImage(
    absPath: string,
    token: string,
    modelType: string = VISION_MODEL_TYPE,
  ): Promise<string> {
    const stat = await fs.promises.stat(absPath)
    if (!stat.isFile()) throw new Error(`不是文件: ${absPath}`)
    if (stat.size <= 0 || stat.size > LOCAL_IMAGE_MAX_BYTES) {
      throw new Error(`图片大小 ${stat.size} 超出上限 ${LOCAL_IMAGE_MAX_BYTES}`)
    }

    // 缓存键带上 modelType：同一份字节在不同用途下的 file_id 不保证可互换
    const cacheKey = `${absPath}\u0000${stat.size}\u0000${stat.mtimeMs}\u0000${modelType}`
    const cached = uploadedImageCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.fileId

    const data = await fs.promises.readFile(absPath)
    // 上传专用 PoW：target_path 必须指向上传接口本身
    const challenge = await this.getChallenge(UPLOAD_TARGET_PATH)
    const powResponse = await this.calculateChallengeAnswer(challenge, UPLOAD_TARGET_PATH)
    const { body, boundary } = buildMultipartBody(
      path.basename(absPath), imageMimeOf(absPath) || 'application/octet-stream', data)

    const result = await axios.post(`${DEEPSEEK_API_BASE}/v0/file/upload_file`, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...FAKE_HEADERS,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
        Cookie: generateCookie(),
        'X-Ds-Pow-Response': powResponse,
        // 关键：不声明 vision，下游会按纯文本处理这份文件，模型就"看不到"图
        [MODEL_TYPE_HEADER]: modelType,
      },
      timeout: 120000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    })

    const bizData = result.data?.data?.biz_data || result.data?.biz_data
    const fileId = bizData?.id
    if (result.status !== 200 || typeof fileId !== 'string' || fileId.length === 0) {
      throw new Error(
        `HTTP ${result.status} ${JSON.stringify(result.data).slice(0, 300)}`)
    }
    console.log('[DeepSeek] 图片已上传:', path.basename(absPath), '→', fileId)
    // 记下上传响应：is_image / model_kind 能证明服务端是否把它当作视觉文件收下
    storeManager.addLog('info',
      `[DeepSeek] 上传 ${path.basename(absPath)} (${imageMimeOf(absPath) || '?'}, ${stat.size}B) → ` +
      `${JSON.stringify(bizData).slice(0, 500)}`)
    // 上传返回的 status 初始是 PENDING，必须等它解析完才能被 ref_file_ids 引用
    await this.waitForFileReady(fileId, token)
    uploadedImageCache.set(cacheKey, { fileId, expiresAt: Date.now() + LOCAL_IMAGE_CACHE_MS })
    return fileId
  }

  /**
   * 轮询到文件被解析完成（状态进入 SUCCESS）为止。
   *
   * 为什么必需：上传返回的 `data.biz_data.status` 初始是 **PENDING**，
   * 随后是 **PARSING**，两者都还没解析完；这时把它填进 `ref_file_ids` 会被服务端判为
   * `biz_code 9 / invalid ref file id`（而且该错误会**污染整个会话**，
   * 之后该会话每一轮都失败）。网页端正是靠 `GET /v0/file/fetch_files`
   * 轮询到 SUCCESS 之后才发起 completion 的。
   *
   * 超时或解析不到状态时**不阻断**：只记日志照常往下走，避免把纯文本路径也拖死。
   * @param fileId - 上传得到的 file id。
   * @param token - 已换取的 access token。
   */
  private async waitForFileReady(fileId: string, token: string): Promise<void> {
    const deadline = Date.now() + FILE_READY_TIMEOUT_MS
    let attempt = 0
    let lastStatus = ''
    while (Date.now() < deadline) {
      attempt += 1
      let status = ''
      try {
        const response = await axios.get(
          `${DEEPSEEK_API_BASE}/v0/file/fetch_files?file_ids=${encodeURIComponent(fileId)}`,
          {
            headers: { Authorization: `Bearer ${token}`, ...FAKE_HEADERS, Cookie: generateCookie() },
            timeout: 15000,
            validateStatus: () => true,
          },
        )
        status = extractFileStatus(response.data, fileId)
        if (status && status !== lastStatus) {
          lastStatus = status
          storeManager.addLog('info',
            `[DeepSeek] fetch_files ${fileId} → status=${status} (HTTP ${response.status}, 第 ${attempt} 次)`)
        }
        if (READY_FILE_STATUSES.includes(status.toUpperCase())) {
          storeManager.addLog('info', `[DeepSeek] 文件就绪: ${fileId} status=${status} (第 ${attempt} 次)`)
          return
        }
      } catch (error) {
        storeManager.addLog('warn',
          `[DeepSeek] fetch_files 失败(第 ${attempt} 次): ${error instanceof Error ? error.message : String(error)}`)
      }
      await new Promise(resolve => setTimeout(resolve, FILE_READY_POLL_MS))
    }
    storeManager.addLog('error',
      `[DeepSeek] 等待文件就绪超时(${FILE_READY_TIMEOUT_MS}ms): ${fileId} `
      + `最后状态=${lastStatus || '(未解析出)'} —— 仍会尝试引用`)
  }

  /**
   * 批量上传本地图片。单张失败不影响其余；整体失败由调用方捕获并退回纯文本。
   * @returns 成功上传的 file_id 列表（顺序与入参一致）
   */
  private async uploadLocalImages(
    absPaths: string[],
    token: string,
    modelType: string = VISION_MODEL_TYPE,
  ): Promise<string[]> {
    const fileIds: string[] = []
    for (const absPath of absPaths) {
      try {
        fileIds.push(await this.uploadLocalImage(absPath, token, modelType))
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        console.warn('[DeepSeek] 本地图片上传失败，跳过:', absPath, error)
        storeManager.addLog('error', `[DeepSeek] 本地图片上传失败: ${path.basename(absPath)} — ${detail}`)
      }
    }
    return fileIds
  }

  private messagesToPrompt(messages: DeepSeekMessage[], isMultiTurn: boolean = false): string {
    const toolProfile = getProviderToolProfile('deepseek')
    const processedMessages = messages.map(message => {
      let text: string

      // Handle tool calls in assistant message
      if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
        text = toolProfile.formatAssistantToolCalls(message.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        })))
      }
      // Handle tool response message
      else if (message.role === 'tool' && message.tool_call_id) {
        text = toolProfile.formatToolResult({
          toolCallId: message.tool_call_id,
          content: String(message.content || ''),
        })
      }
      else if (Array.isArray(message.content)) {
        const texts = message.content
          .filter((item: any) => item.type === 'text')
          .map((item: any) => item.text)
        text = texts.join('\n')
      } else {
        text = String(message.content || '')
      }
      return { role: message.role, text }
    })

    if (processedMessages.length === 0) return ''

    // For multi-turn mode, only send the last user message
    if (isMultiTurn) {
      let lastUserIdx = -1
      for (let i = processedMessages.length - 1; i >= 0; i--) {
        if (processedMessages[i].role === 'user') {
          lastUserIdx = i
          break
        }
      }
      
      if (lastUserIdx !== -1) {
        const lastUserMsg = processedMessages[lastUserIdx]
        let text = lastUserMsg.text
        for (let i = lastUserIdx + 1; i < processedMessages.length; i++) {
          if (processedMessages[i].role === 'tool') {
            text += `\n\n${processedMessages[i].text}`
          }
        }
        return `<｜User｜>${text}`
      }
    }

    const mergedBlocks: { role: string; text: string }[] = []
    let currentBlock = { ...processedMessages[0] }

    for (let i = 1; i < processedMessages.length; i++) {
      const msg = processedMessages[i]
      if (msg.role === currentBlock.role) {
        currentBlock.text += `\n\n${msg.text}`
      } else {
        mergedBlocks.push(currentBlock)
        currentBlock = { ...msg }
      }
    }
    mergedBlocks.push(currentBlock)

    return mergedBlocks
      .map((block, index) => {
        if (block.role === 'assistant') {
          return `<｜Assistant｜>${block.text}<｜end of sentence｜>`
        }
        if (block.role === 'user' || block.role === 'system') {
          return index > 0 ? `<｜User｜>${block.text}` : block.text
        }
        if (block.role === 'tool') {
          return `<｜User｜>${block.text}`
        }
        return block.text
      })
      .join('')
      .replace(/!\[.+\]\(.+\)/g, '')
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{ response: AxiosResponse; sessionId: string }> {
    const token = await this.acquireToken()
    
    const sessionId = await this.createSession()
    console.log('[DeepSeek] Created new session:', sessionId)

    // Clone messages to avoid modifying original request
    // Note: Tool prompt injection is already handled by Forwarder.transformRequestForPromptToolUse()
    const messages = [...request.messages]

    let prompt = this.messagesToPrompt(messages, false)

    // 本地图片通道有两条来源：
    //  ① 网关注入的 [[local-image:…]] 标记（请求经过 ds-trim-gateway 时才有）——
    //     必须把标记从正文里剥掉，本地绝对路径绝不能送给上游；
    //  ② DSH 直连上游时的 <workspace-reference>，由 AFS 自己解析
    //     （见 workspaceReference.ts）；标签留在正文里让模型知道文件名。
    const marker = extractLocalImages(prompt)
    let imagePaths = marker.paths
    if (imagePaths.length > 0) {
      prompt = marker.cleaned
    } else {
      const fromReference = collectWorkspaceImagePaths([prompt])
      imagePaths = fromReference.paths
      if (imagePaths.length > 0) {
        storeManager.addLog('info',
          `[DeepSeek] 自解析 workspace 引用 ${imagePaths.length} 张`
          + `（workspace=${fromReference.root || '(无)'}）`)
      }
    }

    const hasImages = imagePaths.length > 0
    let refFileIds: string[] = []
    if (hasImages) {
      // 剥掉标记后正文可能只剩路径标签甚至为空（用户只发了一张图）——
      // 补一句中性提示，否则会把空 prompt 发上去。
      prompt = prompt.trim() || '请描述这张图片的内容。'
      refFileIds = await this.uploadLocalImages(imagePaths, token, VISION_MODEL_TYPE)
      storeManager.addLog('info',
        `[DeepSeek] 本地图片 ${imagePaths.length} 张 → ref_file_ids=${JSON.stringify(refFileIds)}`)
    }

    // ⚠ 顺序至关重要：completion 的 PoW 挑战必须在**图片上传之后**申请。
    // 上传自己要申请一个 target_path='/api/v0/file/upload_file' 的挑战，而
    // DeepSeek 在签发新挑战后会让先前签发的挑战失效。若先取 completion 的挑战再上传，
    // completion 会以 40301 INVALID_POW_RESPONSE 失败；而这类错误是 HTTP 200 + JSON 体，
    // 会被流解析器当成空流跳过 —— 最终只表现为"上游空响应"，看不出任何原因。
    const challenge = await this.getChallenge('/api/v0/chat/completion')
    const challengeAnswer = await this.calculateChallengeAnswer(challenge)

    const { modelType, searchEnabled, thinkingEnabled } = resolveDeepSeekChatOptions(request, prompt, hasImages)

    if (request.web_search || request.model.toLowerCase().includes('search')) {
      console.log('[DeepSeek] Web search enabled')
    }

    if (request.reasoning_effort || thinkingEnabled) {
      console.log('[DeepSeek] Reasoning mode enabled, effort:', request.reasoning_effort)
    }

    if (refFileIds.length > 0) {
      storeManager.addLog('info',
        `[DeepSeek] 带图 completion: model_type=${modelType} ref_file_ids=${JSON.stringify(refFileIds)} `
        + `prompt前80字=${prompt.slice(0, 80).replace(/\s+/g, ' ')}`)
    }

    const response = await axios.post(
      `${DEEPSEEK_API_BASE}/v0/chat/completion`,
      {
        chat_session_id: sessionId,
        parent_message_id: null,
        prompt,
        model_type: modelType,
        ref_file_ids: refFileIds,
        search_enabled: searchEnabled,
        thinking_enabled: thinkingEnabled,
        preempt: false,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
          Referer: `https://chat.deepseek.com/a/chat/s/${sessionId}`,
          Cookie: generateCookie(),
          'X-Ds-Pow-Response': challengeAnswer,
        },
        timeout: 120000,
        validateStatus: () => true,
        responseType: 'stream',
      }
    )

    // 带图请求额外挂一个只读探针，把上游原始流记进应用日志
    if (refFileIds.length > 0) {
      response.data = tapUpstreamStreamForDiagnostics(response.data as NodeJS.ReadableStream)
    }

    return { response, sessionId }
  }

  async deleteAllChats(): Promise<boolean> {
    try {
      const token = await this.acquireToken()
      const result = await axios.post(
        `${DEEPSEEK_API_BASE}/v0/chat_session/delete_all`,
        {},
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...FAKE_HEADERS,
          },
          timeout: 30000,
          validateStatus: () => true,
        }
      )

      console.log('[DeepSeek] Delete all chats response:', JSON.stringify(result.data, null, 2))

      const success = result.status === 200 && result.data?.code === 0
      if (success) {
        sessionCache.clear()
        console.log('[DeepSeek] All chats deleted')
      }
      return success
    } catch (error) {
      console.error('[DeepSeek] Failed to delete all chats:', error)
      return false
    }
  }

  static isDeepSeekProvider(provider: Provider): boolean {
    return provider.id === 'deepseek' || provider.apiEndpoint.includes('deepseek.com')
  }

  /**
   * Clear session cache for a specific account
   * This should be called when a session is deleted externally (e.g., from web)
   */
  static clearSessionCache(accountId: string): void {
    sessionCache.delete(accountId)
    console.log('[DeepSeek] Cleared session cache for account:', accountId)
  }
}

export const deepSeekAdapter = {
  DeepSeekAdapter,
}
