/**
 * GLM Adapter
 * Implements GLM (Zhipu Qingyan) web API protocol
 */

import axios, { AxiosResponse } from 'axios'
import crypto from 'crypto'
import { Account, Provider } from '../../store/types'
import { storeManager } from '../../store/store'
import { PassThrough } from 'stream'
import { createParser } from 'eventsource-parser'
import FormData from 'form-data'
import mime from 'mime-types'
import path from 'path'
import { toolsToSystemPrompt, TOOL_WRAP_HINT, hasToolPromptInjected } from '../utils/tools'
import { parseToolCallsFromText } from '../utils/toolParser'
import { 
  createBaseChunk,
} from '../utils/streamToolHandler'
import { getProviderToolProfile } from '../toolCalling/providerProfiles'
import { ToolStreamParser } from '../toolCalling/ToolStreamParser'
import type { ToolCallingPlan } from '../toolCalling/types'
import fs from 'node:fs'
import {
  LOCAL_IMAGE_MARKER_PREFIX,
  LOCAL_IMAGE_MAX_BYTES,
  buildDataUri,
  imageMimeOf,
  resolveLocalImageUris,
} from './localImage'
import {
  collectWorkspaceImagePaths,
  containsWorkspaceReference,
} from './workspaceReference'

const GLM_API_BASE = 'https://chatglm.cn/chatglm'
const DEFAULT_ASSISTANT_ID = '65940acff94777010aa6b796'
const SIGN_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb'
const ACCESS_TOKEN_EXPIRES = 3600
const FILE_MAX_SIZE = 100 * 1024 * 1024 // 100MB

const FAKE_HEADERS = {
  Accept: 'text/event-stream',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
  'App-Name': 'chatglm',
  'Cache-Control': 'no-cache',
  'Content-Type': 'application/json',
  Origin: 'https://chatglm.cn',
  Pragma: 'no-cache',
  Priority: 'u=1, i',
  'Sec-Ch-Ua': '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'X-App-Fr': 'browser_extension',
  'X-App-Platform': 'pc',
  'X-App-Version': '0.0.1',
  'X-Device-Brand': '',
  'X-Device-Model': '',
  'X-Lang': 'zh',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
}

interface TokenInfo {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

interface GLMMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | any[] | null
  tool_call_id?: string
  tool_calls?: any[]
}

interface ChatCompletionRequest {
  model: string
  originalModel?: string
  messages: GLMMessage[]
  stream?: boolean
  temperature?: number
  web_search?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high'
  deep_research?: boolean
  tools?: any[]
  tool_choice?: any
}

const tokenCache = new Map<string, TokenInfo>()

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function md5(str: string): string {
  return crypto.createHash('md5').update(str).digest('hex')
}

function generateSign(): { timestamp: string; nonce: string; sign: string } {
  const e = Date.now()
  const A = e.toString()
  const t = A.length
  const o = A.split('').map((c) => Number(c))
  const i = o.reduce((acc, val) => acc + val, 0) - o[t - 2]
  const a = i % 10
  const timestamp = A.substring(0, t - 2) + a + A.substring(t - 1, t)
  const nonce = uuid()
  const sign = md5(`${timestamp}-${nonce}-${SIGN_SECRET}`)
  return { timestamp, nonce, sign }
}

/**
 * 判定一个响应是否属于「鉴权失效」。
 *
 * 两种形态都遇到过：
 *  - 网关直接回 HTTP 401（token 过期/被吊销）
 *  - HTTP 200 + 业务错误码 401（GLM 大多数失败都是这种"200 + 业务码"形态）
 * 流式响应的 data 是 stream，取不到 code/status，只看 HTTP 状态即可。
 */
function isAuthFailureResponse(result: any): boolean {
  if (!result) return false
  if (result.status === 401) return true
  const body = result.data
  if (!body || typeof body !== 'object') return false
  return body.code === 401 || body.status === 401
}

export class GLMAdapter {
  private provider: Provider
  private account: Account

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  private getRefreshToken(): string {
    const credentials = this.account.credentials
    return credentials.refresh_token || credentials.token || ''
  }

  /**
   * 清掉本地 access_token 缓存，让下一次 acquireToken() 真正拿 refresh_token 去换。
   * 只删当前 refresh_token 对应的条目，不动其他账户的缓存。
   */
  private invalidateTokenCache(): void {
    const refreshToken = this.getRefreshToken()
    if (refreshToken && tokenCache.delete(refreshToken)) {
      storeManager.addLog('info', '[GLM] 收到 401，已清除本地 token 缓存')
    }
  }

  /**
   * 带「鉴权失效重试一次」的请求执行器。
   *
   * 为什么需要：access_token 的有效期是本地假设的 1 小时（ACCESS_TOKEN_EXPIRES），
   * 不是服务端返回的 expires_in。服务端提前失效时（网页端退出登录、异地登录被踢、
   * 管理员踢下线），缓存里的 token 仍被视为有效，最长 1 小时内所有 GLM 请求
   * 都会失败。这里看到 401 就清缓存 + 重试一次，把不可用窗口从「最长 1 小时」
   * 压缩到「一次往返」。
   *
   * @param send 用给定 token 发请求。闭包里必须重新生成 X-Sign/X-Nonce，
   *             否则重放同样的签名可能被服务端拒绝。
   */
  private async withTokenRetry<T>(send: (token: string) => Promise<T>): Promise<T> {
    const first = await send(await this.acquireToken())
    if (!isAuthFailureResponse(first)) return first
    this.invalidateTokenCache()
    return send(await this.acquireToken())
  }

  private async acquireToken(): Promise<string> {
    const refreshToken = this.getRefreshToken()
    const cached = tokenCache.get(refreshToken)
    if (cached && Date.now() < cached.expiresAt) {
      return cached.accessToken
    }

    console.log('[GLM] Refreshing Token...')
    const sign = generateSign()
    const response = await axios.post(
      `${GLM_API_BASE}/user-api/user/refresh`,
      {},
      {
        headers: {
          Authorization: `Bearer ${refreshToken}`,
          ...FAKE_HEADERS,
          'X-Device-Id': uuid(),
          'X-Nonce': sign.nonce,
          'X-Request-Id': uuid(),
          'X-Sign': sign.sign,
          'X-Timestamp': sign.timestamp,
        },
        timeout: 15000,
        validateStatus: () => true,
      }
    )

    console.log('[GLM] Token response:', JSON.stringify(response.data, null, 2))
    const { code, status, message } = response.data || {}
    const isSuccess = code === 0 || status === 0
    if (response.status !== 200 || !isSuccess) {
      const errorMsg = message || `HTTP ${response.status}`
      throw new Error(`Token refresh failed: ${errorMsg}`)
    }

    const { access_token, refresh_token } = response.data.result
    const tokenInfo: TokenInfo = {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: Date.now() + ACCESS_TOKEN_EXPIRES * 1000,
    }
    tokenCache.set(refreshToken, tokenInfo)

    if (refresh_token !== refreshToken) {
      console.log('[GLM] Token updated, saving new token')
      const decryptedCredentials = {
        refresh_token,
      }
      await storeManager.updateAccount(this.account.id, {
        credentials: decryptedCredentials,
      })
    }

    console.log('[GLM] Token refresh successful')
    return access_token
  }

  /**
   * Check if URL is base64 data
   */
  private isBase64Data(url: string): boolean {
    return url.startsWith('data:')
  }

  /**
   * Extract MIME type from base64 data URL
   */
  private extractBase64Format(url: string): string {
    const match = url.match(/^data:([^;]+);/)
    return match ? match[1] : 'application/octet-stream'
  }

  /**
   * Remove base64 data header
   */
  private removeBase64Header(url: string): string {
    return url.replace(/^data:[^;]+;base64,/, '')
  }

  /**
   * Upload file to GLM
   */
  private async uploadFile(fileUrl: string): Promise<{ source_id: string; file_url?: string }> {
    // data URI 可能有几 MB，日志里只留类型；真实 URL 则截断显示
    const isDataUri = this.isBase64Data(fileUrl)
    storeManager.addLog('info', `[GLM] 开始上传: ${isDataUri ? `(data URI, ${fileUrl.length}B)` : fileUrl.slice(0, 160)}`)
    console.log('[GLM] Uploading file:', fileUrl.substring(0, 50) + '...')
    
    let filename: string
    let fileData: Buffer
    let mimeType: string

    if (this.isBase64Data(fileUrl)) {
      mimeType = this.extractBase64Format(fileUrl)
      const ext = mime.extension(mimeType) || 'bin'
      filename = `${uuid()}.${ext}`
      fileData = Buffer.from(this.removeBase64Header(fileUrl), 'base64')
    } else {
      filename = path.basename(fileUrl.split('?')[0])
      const response = await axios.get(fileUrl, {
        responseType: 'arraybuffer',
        maxContentLength: FILE_MAX_SIZE,
        timeout: 60000,
      })
      fileData = Buffer.from(response.data)
      mimeType = response.headers['content-type'] || mime.lookup(filename) || 'application/octet-stream'
    }

    const formData = new FormData()
    formData.append('file', fileData, {
      filename,
      contentType: mimeType,
    })

    const response = await this.withTokenRetry((token) =>
      axios.post(
        `${GLM_API_BASE}/backend-api/assistant/file_upload`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Referer: 'https://chatglm.cn/',
            ...FAKE_HEADERS,
            ...formData.getHeaders(),
          },
          maxBodyLength: FILE_MAX_SIZE,
          timeout: 60000,
          validateStatus: () => true,
        }
      )
    )

    if (response.status !== 200 || !response.data?.result) {
      // 记下响应体：GLM 的失败也常是 HTTP 200 + 业务错误码，不落盘就无从排查
      const detail = `HTTP ${response.status} ${JSON.stringify(response.data).slice(0, 400)}`
      storeManager.addLog('error', `[GLM] 上传失败: ${detail}`)
      throw new Error(`File upload failed: ${detail}`)
    }

    console.log('[GLM] File uploaded successfully:', response.data.result.source_id)
    // 完整响应原文：网页端引用图片时到底用哪个字段（source_id / id / file_id / file_url）
    // 直接决定 messages 里 image_url 部件怎么写，必须留下证据
    storeManager.addLog('info',
      `[GLM] 上传响应原文: ${JSON.stringify(response.data).slice(0, 800)}`)
    storeManager.addLog('info',
      `[GLM] 上传成功: source_id=${response.data.result.source_id} file_url=${response.data.result.file_url || '(空)'}`)
    return response.data.result
  }

  /**
   * 消费网关注入的 `[[local-image:/abs/path]]` 标记：读盘成 data URI，并把标记
   * 从正文里剥掉（标记里是本地绝对路径，绝不能进 prompt）。
   *
   * 这条路径只在请求**经过 ds-trim-gateway**（8001）时出现；DSH 直连上游的路由
   * 没有标记，由 {@link collectWorkspaceImageUris} 兜底。
   * @param messages - 待发送的消息；函数会就地把含标记的文本换成剥离后的正文。
   * @returns 可上传的 data URI 列表。
   */
  private extractMarkerImageUris(messages: GLMMessage[]): string[] {
    const collected: string[] = []
    for (let i = 0; i < messages.length; i += 1) {
      const msg = messages[i]
      if (msg.role !== 'user' || typeof msg.content !== 'string') continue
      if (!msg.content.includes(LOCAL_IMAGE_MARKER_PREFIX)) continue

      const { cleaned, uris, found } = resolveLocalImageUris(
        msg.content, absPath => this.readLocalImageAsDataUri(absPath))

      // 标记整行剥掉；正文里不留任何本地绝对路径
      messages[i] = { ...msg, content: cleaned }
      collected.push(...uris)
      storeManager.addLog('info',
        `[GLM] 网关图片标记 ${found} 张，读入成功 ${uris.length} 张`)
    }
    return collected
  }

  /**
   * DSH「直连上游」的路由不经过网关，也就没有标记可消费 —— 于是自己解析
   * `<workspace-reference path="…">`：相对路径按运行时上下文里的 `session workspace`
   * 补全成绝对路径，再读盘成 data URI。
   *
   * 标签本身**保留在正文里**（让模型仍知道文件名）。任何一张图失败都只跳过它。
   * @param messages - 待发送的消息。
   * @returns 可上传的 data URI 列表。
   */
  private collectWorkspaceImageUris(messages: GLMMessage[]): string[] {
    const texts = messages
      .map(msg => (typeof msg.content === 'string' ? msg.content : ''))
      .filter(text => text.length > 0)
    const { paths, root } = collectWorkspaceImagePaths(texts)

    if (paths.length === 0) {
      if (texts.some(containsWorkspaceReference)) {
        storeManager.addLog('warn',
          '[GLM] 见到 <workspace-reference> 但没解析出图片路径'
          + `（session workspace=${root || '(未找到)'}）`)
      }
      return []
    }

    const uris = paths
      .map(absPath => this.readLocalImageAsDataUri(absPath))
      .filter(uri => uri.length > 0)
    storeManager.addLog('info',
      `[GLM] 自解析 workspace 引用 ${paths.length} 张，读入成功 ${uris.length} 张`
      + `（workspace=${root || '(无)'}）`)
    return uris
  }

  /** 读本地图片并包成 data URI；失败只记日志并返回空串。 */
  private readLocalImageAsDataUri(absPath: string): string {
    try {
      const stat = fs.statSync(absPath)
      if (!stat.isFile()) {
        storeManager.addLog('warn', `[GLM] 不是文件，跳过本地图片: ${absPath}`)
        return ''
      }
      if (stat.size <= 0 || stat.size > LOCAL_IMAGE_MAX_BYTES) {
        storeManager.addLog('warn',
          `[GLM] 本地图片 ${stat.size}B 超出上限 ${LOCAL_IMAGE_MAX_BYTES}，跳过: ${absPath}`)
        return ''
      }
      const mime = imageMimeOf(absPath)
      return buildDataUri(mime || 'application/octet-stream', fs.readFileSync(absPath))
    } catch (error) {
      storeManager.addLog('warn',
        `[GLM] 读取本地图片失败，跳过: ${absPath} ${(error as Error).message}`)
      return ''
    }
  }

  /**
   * Extract file URLs from message content
   */
  private extractFileUrls(messages: GLMMessage[]): { fileUrls: string[]; imageUrls: string[] } {
    const fileUrls: string[] = []
    const imageUrls: string[] = []

    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'image_url' && part.image_url?.url) {
            imageUrls.push(part.image_url.url)
          } else if (part.type === 'file' && part.file_url?.url) {
            fileUrls.push(part.file_url.url)
          }
        }
      }
    }

    return { fileUrls, imageUrls }
  }

  private messagesToPrompt(messages: GLMMessage[], refs: any[] = [], toolsPrompt?: string, isMultiTurn: boolean = false): { role: string; content: any[] }[] {
    const toolProfile = getProviderToolProfile('glm')
    // Separate image refs and file refs
    //
    // 判据只看我们自己加的 image_url。**不能拿 width/height 当哨兵** —— 上传结果
    // 本身就带真实 width/height（如 64×64），用同名字段作标记会把真实值覆盖掉，
    // 出口再剔除就等于把尺寸白丢了。
    const isImageRef = (ref: any) =>
      typeof ref.image_url === 'string' && ref.image_url.length > 0
    const imageRefs = refs.filter(isImageRef)
    const fileRefs = refs.filter((ref) => !isImageRef(ref))

    // Build content array
    const content: any[] = []

    // Add file references first
    if (fileRefs.length > 0) {
      content.push({
        type: 'file',
        file: fileRefs.map((ref) => ({
          source_id: ref.source_id,
          file_url: ref.file_url,
        })),
      })
    }

    // Add image references
    //
    // 注意这是 **chatglm 的原生格式**，不是 OpenAI 那套：
    //   chatglm：  { type: 'image', image: [ <上传结果对象> … ] }
    //   OpenAI ：  { type: 'image_url', image_url: { url } }
    // 实测发成 image_url 时模型完全收不到图（回 "请提供图片链接" / "No image provided"），
    // 而上游不报任何错误——最难查的一类问题。参考实现（rev-chatglm）用的是默认助手
    // `65940acff94777010aa6b796`（与本文件相同）配 `type:'image'` 部件，识图可用。
    // 另外所有图片放在**同一个**部件里，与参考实现一致。
    if (imageRefs.length > 0) {
      content.push({
        type: 'image',
        // 原样带上整份上传结果（含真实的 file_id / file_url / width / height）
        image: imageRefs,
      })
    }

    // Process messages including tool calls and tool responses
    const processedMessages = messages.map(msg => {
      // Handle tool calls in assistant message
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        return {
          ...msg,
          content: toolProfile.formatAssistantToolCalls(msg.tool_calls.map(tc => ({
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          }))),
        }
      }
      // Handle tool response message
      if (msg.role === 'tool' && msg.tool_call_id) {
        return { 
          ...msg, 
          role: 'user' as const,
          content: toolProfile.formatToolResult({
            toolCallId: msg.tool_call_id,
            content: String(msg.content || ''),
          }),
        }
      }
      return msg
    })

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
        let textContent = ''
        if (typeof lastUserMsg.content === 'string') {
          textContent = lastUserMsg.content
        } else if (Array.isArray(lastUserMsg.content)) {
          textContent = lastUserMsg.content.filter((c) => c.type === 'text').map((c) => c.text).join('')
        }
        
        // Include any tool results after the last user message
        for (let i = lastUserIdx + 1; i < processedMessages.length; i++) {
          if (processedMessages[i].role === 'user') {
            const toolText = typeof processedMessages[i].content === 'string' 
              ? processedMessages[i].content 
              : ''
            textContent += '\n' + toolText
          }
        }
        
        if (toolsPrompt) {
          textContent = textContent.trim() + "\n\n" + toolsPrompt
        }
        
        content.push({ type: 'text', text: textContent })
        return [{ role: 'user', content }]
      }
    }

    // Extract text from messages
    if (processedMessages.length < 2) {
      let textContent = processedMessages.reduce((acc, msg) => {
        if (typeof msg.content === 'string') {
          return acc + msg.content + '\n'
        } else if (Array.isArray(msg.content)) {
          const textParts = msg.content.filter((c) => c.type === 'text').map((c) => c.text)
          return acc + textParts.join('') + '\n'
        }
        return acc
      }, '')

      // Inject tools prompt at the VERY END
      if (toolsPrompt) {
        textContent = textContent.trim() + "\n\n" + toolsPrompt
      }

      content.push({ type: 'text', text: textContent })
      return [{ role: 'user', content }]
    }

    let textContent = processedMessages.reduce((acc, msg) => {
      const role = msg.role
        .replace('system', 'System')
        .replace('assistant', 'Assistant')
        .replace('user', 'User')
        .replace('tool', 'User')
      if (typeof msg.content === 'string') {
        return acc + `${role}: ${msg.content}\n\n`
      } else if (Array.isArray(msg.content)) {
        const text = msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('')
        return acc + `${role}: ${text}\n\n`
      }
      return acc
    }, '')

    // Inject tools prompt at the VERY END
    if (toolsPrompt) {
      textContent = textContent.trim() + "\n\n" + toolsPrompt
    }

    content.push({ type: 'text', text: textContent + 'Assistant: ' })
    return [{ role: 'user', content }]
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{ response: AxiosResponse; conversationId: string }> {
    // Clone messages to avoid modifying original request
    const messages = [...request.messages]

    // Check if tool prompt has already been injected by client
    const toolPromptExists = hasToolPromptInjected(messages)

    // Inject tools definition into prompt if tools are provided and not already injected
    let toolsPrompt = ''
    if (request.tools && request.tools.length > 0 && !toolPromptExists) {
      const glmStrictHint = `

GLM STRICT RULES:
- If user asks to create/modify code or files, you MUST call tools instead of replying with plain text.
- You MUST output ONLY one [function_calls] block when calling tools.
- Use exact tool names from list, case-sensitive, do not rename.`
      toolsPrompt = toolsToSystemPrompt(request.tools) + glmStrictHint

      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          const currentContent = messages[i].content
          if (typeof currentContent === 'string') {
            messages[i] = { ...messages[i], content: currentContent + TOOL_WRAP_HINT }
          } else if (Array.isArray(currentContent)) {
            messages[i] = {
              ...messages[i],
              content: [...currentContent, { type: 'text', text: TOOL_WRAP_HINT }],
            }
          }
          break
        }
      }
    }

    // 本地图片（路线 A）有两条来源：
    //  ① 网关注入的 [[local-image:…]] 标记 —— 请求经过 ds-trim-gateway 时才有
    //  ② DSH 直连上游时的 <workspace-reference>，AFS 自己解析（见 workspaceReference.ts）
    // 有标记就不再解析引用：两者指向同一批文件，避免重复上传。
    const markerImageUris = this.extractMarkerImageUris(messages)
    const referenceImageUris = markerImageUris.length > 0
      ? []
      : this.collectWorkspaceImageUris(messages)
    const localImageUris = [...markerImageUris, ...referenceImageUris]

    // Extract and upload files
    const { fileUrls, imageUrls } = this.extractFileUrls(messages)
    const refs: any[] = []

    // Upload files
    for (const fileUrl of fileUrls) {
      try {
        const result = await this.uploadFile(fileUrl)
        refs.push({
          source_id: result.source_id,
          file_url: result.file_url || fileUrl,
        })
      } catch (error) {
        console.error('[GLM] Failed to upload file:', error)
      }
    }

    // Upload images（原生附件 + 本地图片，统一走这一条上传通道）
    for (const imageUrl of [...imageUrls, ...localImageUris]) {
      try {
        const result = await this.uploadFile(imageUrl)
        if (!result.file_url) {
          // 没有 file_url 时会退回把原始数据（可能是几 MB 的 data URI）当引用，
          // 模型大概率读不懂，单独记一条便于定位
          storeManager.addLog('warn',
            `[GLM] 上传未返回 file_url，将回退原始数据: source_id=${result.source_id}`)
        }
        refs.push({
          // 保留上传响应的全部字段：chatglm 的图片部件要的是**整份上传结果**，
          // 新版接口已经不返回 source_id（实测为 undefined），按字段挑会挑空。
          // 这里**不加 width/height 哨兵**：上传结果自带真实尺寸，识别靠 image_url。
          ...result,
          image_url: result.file_url || imageUrl,
        })
      } catch (error) {
        console.error('[GLM] Failed to upload image:', error)
        storeManager.addLog('error',
          `[GLM] 图片上传失败，本轮退化为纯文本: ${(error as Error).message}`)
      }
    }

    const preparedMessages = this.messagesToPrompt(messages, refs, toolsPrompt, false)

    // 每次请求留一行体量与注入来源：排查「模型说工具不可用」时，需要知道
    // 上游到底收到了多少字符、以及是否被 legacy toolsPrompt 又插了一套格式。
    storeManager.addLog(
      'info',
      `[GLM] 请求体量 promptChars=${JSON.stringify(preparedMessages).length} ` +
        `tools=${request.tools?.length ?? 0} legacyToolPrompt=${toolsPrompt ? 'yes' : 'no'} ` +
        `detectedInjected=${toolPromptExists}`,
    )

    // 带图请求把最终 messages 打出来（截断）：模型"看不到图"时要能分辨是
    // 部件没送出去，还是送出去但格式不对
    if (refs.length > 0) {
      storeManager.addLog('info',
        `[GLM] 带图请求 refs=${JSON.stringify(refs).slice(0, 300)}`)
      storeManager.addLog('info',
        `[GLM] 带图请求 messages=${JSON.stringify(preparedMessages).slice(0, 1200)}`)
    }

    let assistantId = DEFAULT_ASSISTANT_ID
    let chatMode = ''
    let isNetworking = false

    // 模式选择（OpenAI compatible）：
    //   模型名含 "thinking"（如 GLM-5.3-thinking）→ chat_mode='thinking'（深度思考）
    //   否则（如 GLM-5.3）→ chat_mode='zero'（普通回复）
    const modelForDetection = request.originalModel || request.model
    const modelLower = modelForDetection.toLowerCase()
    const isThinking = modelLower.includes('thinking') || modelLower.includes('think')
    if (request.reasoning_effort) {
      chatMode = isThinking ? 'thinking' : 'zero'
      console.log('[GLM] Using reasoning mode, effort:', request.reasoning_effort, 'chatMode:', chatMode)
    }
    
    if (request.web_search) {
      isNetworking = true
      console.log('[GLM] Web search enabled')
    }
    
    if (request.deep_research) {
      chatMode = 'deep_research'
      console.log('[GLM] Using deep research mode')
    }

    // Fallback: check model name for backward compatibility
    if (!chatMode && isThinking) {
      chatMode = 'thinking'
      console.log('[GLM] Using reasoning mode (from model name)')
    }
    if (!chatMode && modelLower.includes('deepresearch')) {
      chatMode = 'deep_research'
      console.log('[GLM] Using deep research mode (from model name)')
    }
    
    // Check if model is an assistant ID (24+ alphanumeric characters)
    if (/^[a-z0-9]{24,}$/.test(request.model)) {
      assistantId = request.model
    }

    console.log('[GLM] Sending chat request...')

    // 签名必须每次请求重算：401 后重试时沿用旧 X-Sign/X-Nonce 会被服务端拒掉
    const response = await this.withTokenRetry((token) => {
      const sign = generateSign()
      return axios.post(
        `${GLM_API_BASE}/backend-api/assistant/stream`,
        {
          assistant_id: assistantId,
          conversation_id: '',
          project_id: '',
          chat_type: 'user_chat',
          messages: preparedMessages,
          meta_data: {
            channel: '',
            chat_mode: chatMode || undefined,
            draft_id: '',
            if_plus_model: true,
            input_question_type: 'xxxx',
            is_networking: isNetworking,
            is_test: false,
            platform: 'pc',
            quote_log_id: '',
            cogview: {
              rm_label_watermark: false,
            },
          },
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...FAKE_HEADERS,
            'X-Device-Id': uuid(),
            'X-Request-Id': uuid(),
            'X-Sign': sign.sign,
            'X-Timestamp': sign.timestamp,
            'X-Nonce': sign.nonce,
          },
          timeout: 120000,
          validateStatus: () => true,
          responseType: 'stream',
        }
      )
    })

    return { response, conversationId: '' }
  }

  async deleteConversation(conversationId: string): Promise<boolean> {
    try {
      const token = await this.acquireToken()
      const sign = generateSign()
      await axios.post(
        `${GLM_API_BASE}/backend-api/assistant/conversation/delete`,
        {
          assistant_id: DEFAULT_ASSISTANT_ID,
          conversation_id: conversationId,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Referer: 'https://chatglm.cn/main/alltoolsdetail',
            'X-Device-Id': uuid(),
            'X-Request-Id': uuid(),
            'X-Sign': sign.sign,
            'X-Timestamp': sign.timestamp,
            'X-Nonce': sign.nonce,
            ...FAKE_HEADERS,
          },
          timeout: 15000,
          validateStatus: () => true,
        }
      )
      console.log('[GLM] Conversation deleted:', conversationId)
      return true
    } catch (error) {
      console.error('[GLM] Failed to delete conversation:', error)
      return false
    }
  }

  async deleteAllChats(): Promise<boolean> {
    try {
      const token = await this.acquireToken()

      // Step 1: Get all conversations (handle pagination)
      const allConversationIds: string[] = []
      let page = 1
      let hasMore = true

      while (hasMore) {
        const sign = generateSign()
        const listResponse = await axios.post(
          `${GLM_API_BASE}/mainchat-api/conversation/recent_list`,
          { page, page_size: 100 },
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Referer: 'https://chatglm.cn/main/alltoolsdetail',
              'X-Device-Id': uuid(),
              'X-Request-Id': uuid(),
              'X-Sign': sign.sign,
              'X-Timestamp': sign.timestamp,
              'X-Nonce': sign.nonce,
              ...FAKE_HEADERS,
            },
            timeout: 30000,
            validateStatus: () => true,
          }
        )

        console.log('[GLM] Get conversation list page', page, 'response:', JSON.stringify(listResponse.data, null, 2))

        const { status, result } = listResponse.data || {}
        if (listResponse.status !== 200 || status !== 0) {
          console.error('[GLM] Failed to get conversation list')
          return false
        }

        const conversationList = result?.conversation_list || []
        for (const c of conversationList) {
          allConversationIds.push(c.conversation_id)
        }

        hasMore = result?.has_more || false
        page++

        if (conversationList.length === 0) {
          break
        }
      }

      if (allConversationIds.length === 0) {
        console.log('[GLM] No conversations to delete')
        return true
      }

      console.log('[GLM] Found', allConversationIds.length, 'conversations to delete')

      // Step 2: Bulk delete conversations
      const sign = generateSign()
      const deleteResponse = await axios.post(
        `${GLM_API_BASE}/mainchat-api/conversation/bulk_delete`,
        { conversation_ids: allConversationIds },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Referer: 'https://chatglm.cn/main/alltoolsdetail',
            'X-Device-Id': uuid(),
            'X-Request-Id': uuid(),
            'X-Sign': sign.sign,
            'X-Timestamp': sign.timestamp,
            'X-Nonce': sign.nonce,
            ...FAKE_HEADERS,
          },
          timeout: 60000,
          validateStatus: () => true,
        }
      )

      console.log('[GLM] Bulk delete response:', JSON.stringify(deleteResponse.data, null, 2))

      const deleteResult = deleteResponse.data || {}
      const success = deleteResponse.status === 200 && deleteResult.status === 0
      if (success) {
        console.log('[GLM] All chats deleted')
      }
      return success
    } catch (error) {
      console.error('[GLM] Failed to delete all chats:', error)
      return false
    }
  }

  static isGLMProvider(provider: Provider): boolean {
    return provider.id === 'glm' || provider.apiEndpoint.includes('chatglm.cn')
  }
}

/**
 * 粗略估算 token 数。
 *
 * chatglm.cn 网页接口不返回 usage，旧代码把 usage 写死成 1/1/2，导致所有 GLM 请求
 * 在统计里都只算 2 个 token，成本报表彻底失真。这里按字符估算，只求量级正确：
 * CJK 约 1.5 字符/token，其余约 4 字符/token。
 */
function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const isCjk =
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    if (isCjk) cjk += 1
  }
  const rest = text.length - cjk
  return Math.max(1, Math.ceil(cjk / 1.5 + rest / 4))
}

export class GLMStreamHandler {
  private conversationId: string = ''
  private model: string
  private created: number
  private onEnd?: () => void
  private toolStreamParser?: ToolStreamParser
  private toolCallingPlan?: ToolCallingPlan
  /** 本次请求的提示词原文，仅用于估算 prompt_tokens（上游不返回 usage）。 */
  private promptText: string

  constructor(
    model: string,
    onEnd?: () => void,
    initialConversationId?: string,
    toolCallingPlan?: ToolCallingPlan,
    promptText: string = '',
  ) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.toolCallingPlan = toolCallingPlan
    this.toolStreamParser = toolCallingPlan?.shouldParseResponse ? new ToolStreamParser(toolCallingPlan) : undefined
    this.promptText = promptText
    if (initialConversationId) {
      this.conversationId = initialConversationId
    }
  }

  /** 估算本轮的 usage（上游无 usage 字段时的兜底）。 */
  private buildUsage(completionText: string): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
    const prompt = estimateTokens(this.promptText)
    const completion = estimateTokens(completionText)
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
  }

  async handleStream(stream: any): Promise<PassThrough> {
    const transStream = new PassThrough()
    const cachedParts: any[] = []
    let sentContent = ''
    let sentReasoning = ''
    let sentRole = false

    transStream.write(
      `data: ${JSON.stringify({
        id: '',
        model: this.model,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        created: this.created,
      })}\n\n`
    )

    const emittedNativeToolCallIds = new Set<string>()

    const parser = createParser({
      onEvent: (event: any) => {
        try {
          const result = JSON.parse(event.data)

          if (!this.conversationId && result.conversation_id) {
            this.conversationId = result.conversation_id
          }

          if (result.status !== 'finish' && result.status !== 'intervene') {
            if (result.parts) {
              result.parts.forEach((part: any) => {
                const index = cachedParts.findIndex((p) => p.logic_id === part.logic_id)
                if (index !== -1) {
                  cachedParts[index] = part
                } else {
                  cachedParts.push(part)
                }
              })
            }

            const searchMap = new Map<string, any>()
            cachedParts.forEach((part) => {
              if (!part.content || !Array.isArray(part.content)) return
              const { meta_data } = part
              part.content.forEach((item: any) => {
                if (item.type === 'tool_result' && meta_data?.tool_result_extra?.search_results) {
                  meta_data.tool_result_extra.search_results.forEach((res: any) => {
                    if (res.match_key) {
                      searchMap.set(res.match_key, res)
                    }
                  })
                }
              })
            })

            const keyToIdMap = new Map<string, number>()
            let counter = 1
            let fullText = ''
            let fullReasoning = ''
            const nativeToolCalls: any[] = []

            cachedParts.forEach((part) => {
              const { content, meta_data } = part
              if (!Array.isArray(content)) return

              let partText = ''
              let partReasoning = ''

              content.forEach((value: any) => {
                const { type, text, think, image, code, content: innerContent } = value

                if (type === 'text') {
                  let txt = text
                  if (searchMap.size > 0) {
                    txt = txt.replace(/【?(turn\d+[a-zA-Z]+\d+)】?/g, (match: string, key: string) => {
                      const searchInfo = searchMap.get(key)
                      if (!searchInfo) return match
                      if (!keyToIdMap.has(key)) {
                        keyToIdMap.set(key, counter++)
                      }
                      return ` [${keyToIdMap.get(key)}](${searchInfo.url})`
                    })
                  }
                  partText += txt
                } else if (type === 'think') {
                  partReasoning += think
                } else if (type === 'image' && Array.isArray(image) && part.status === 'finish') {
                  const imageText =
                    image.reduce((imgs: string, v: any) => {
                      return imgs + (/^(http|https):\/\//.test(v.image_url) ? `![image](${v.image_url})` : '')
                    }, '') + '\n'
                  partText += imageText
                } else if (type === 'code') {
                  partText += '```python\n' + code + (part.status === 'finish' ? '\n```\n' : '')
                } else if (type === 'execution_output' && typeof innerContent === 'string' && part.status === 'finish') {
                  partText += innerContent + '\n'
                } else if (type === 'tool_calls' && value.tool_calls && typeof value.tool_calls === 'object') {
                  // GLM web 原生结构化工具调用 part（chatglm.cn 输出 JSON 对象而非文本 XML）
                  const tc = value.tool_calls
                  const tcName = String(tc.name || '')
                  // 白名单校验：只透传 AFS 注入的工具，过滤 GLM web 原生工具（open_url/finish 等）
                  const allowedNames = new Set((this.toolCallingPlan?.tools ?? []).map((t: any) => t.name))
                  if (allowedNames.size > 0 && !allowedNames.has(tcName)) {
                    console.log(`[GLM] Filtered native tool call not in allowed list: ${tcName}`)
                  } else {
                    nativeToolCalls.push({
                      id: tc.id || `call_${nativeToolCalls.length}`,
                      type: 'function',
                      function: {
                        name: tcName,
                        arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
                      },
                    })
                  }
                }
              })

              if (partText) fullText += (fullText.length > 0 ? '\n' : '') + partText
              if (partReasoning) fullReasoning += (fullReasoning.length > 0 ? '\n' : '') + partReasoning
            })

            const reasoningChunk = fullReasoning.substring(sentReasoning.length)
            if (reasoningChunk) {
              sentReasoning += reasoningChunk
              transStream.write(
                `data: ${JSON.stringify({
                  id: this.conversationId,
                  model: this.model,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: { reasoning_content: reasoningChunk }, finish_reason: null }],
                  created: this.created,
                })}\n\n`
              )
            }

            const chunk = fullText.substring(sentContent.length)
            if (chunk) {
              sentContent += chunk
            }

            // 原生结构化 tool_calls part 优先：有工具调用时抑制文本输出
            const newNativeCalls = nativeToolCalls.filter((tc: any) => !emittedNativeToolCallIds.has(tc.id))
            for (const tc of newNativeCalls) emittedNativeToolCallIds.add(tc.id)

            const baseChunk = createBaseChunk(this.conversationId, this.model, this.created)

            if (newNativeCalls.length > 0) {
              transStream.write(
                `data: ${JSON.stringify({
                  ...baseChunk,
                  choices: [{
                    index: 0,
                    delta: { ...(!sentRole ? { role: 'assistant' } : {}), tool_calls: newNativeCalls },
                    finish_reason: null,
                  }],
                })}\n\n`
              )
              sentRole = true
            } else {
              // Process tool call interception with shared parser buffering.
              const outputChunks = this.toolStreamParser?.push(chunk, baseChunk, !sentRole) ?? (
                chunk ? [{
                  ...baseChunk,
                  choices: [{ index: 0, delta: { ...(!sentRole ? { role: 'assistant' } : {}), content: chunk }, finish_reason: null }],
                }] : []
              )

              for (const outChunk of outputChunks) {
                transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
              }

              if (outputChunks.length > 0) sentRole = true
            }
          } else {
            // Flush any remaining tool call buffer before finishing
            const baseChunk = createBaseChunk(this.conversationId, this.model, this.created)
            const flushChunks = this.toolStreamParser?.flush(baseChunk) ?? []
            for (const outChunk of flushChunks) {
              transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
            }

            // Determine finish_reason based on whether we had tool calls
            const finishReason = this.toolStreamParser?.hasEmittedToolCall() || emittedNativeToolCallIds.size > 0 ? 'tool_calls' : 'stop'

            transStream.write(
              `data: ${JSON.stringify({
                id: this.conversationId,
                model: this.model,
                object: 'chat.completion.chunk',
                choices: [
                  {
                    index: 0,
                    delta:
                      result.status === 'intervene' && result.last_error?.intervene_text
                        ? { content: '\n\n' + result.last_error.intervene_text }
                        : {},
                    finish_reason: finishReason,
                  },
                ],
                usage: this.buildUsage(sentContent + sentReasoning),
                created: this.created,
              })}\n\n`
            )
            transStream.end('data: [DONE]\n\n')
            this.onEnd?.()
          }
        } catch (err) {
          console.error('[GLM] Stream parse error:', err)
        }
      },
    })

    const decoder = new TextDecoder('utf-8')
    stream.on('data', (buffer: Buffer) => parser.feed(decoder.decode(buffer, { stream: true })))

    // Handle stream errors - ensure proper cleanup
    stream.once('error', (err: Error) => {
      console.error('[GLM] Stream error:', err.message)
      // Flush any remaining tool call buffer
      const baseChunk = createBaseChunk(this.conversationId, this.model, this.created)
      const flushChunks = this.toolStreamParser?.flush(baseChunk) ?? []
      for (const outChunk of flushChunks) {
        transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
      }
      const finishReason = this.toolStreamParser?.hasEmittedToolCall() || emittedNativeToolCallIds.size > 0 ? 'tool_calls' : 'stop'
      transStream.write(
        `data: ${JSON.stringify({
          id: this.conversationId,
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          created: this.created,
        })}\n\n`
      )
      transStream.end('data: [DONE]\n\n')
      this.onEnd?.()
    })

    // Handle stream close - ensure proper cleanup if not already finished
    stream.once('close', () => {
      console.log('[GLM] Stream closed')
      // Only send finish if we haven't already
      if (!transStream.closed) {
        const baseChunk = createBaseChunk(this.conversationId, this.model, this.created)
        const flushChunks = this.toolStreamParser?.flush(baseChunk) ?? []
        for (const outChunk of flushChunks) {
          transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
        }
        const finishReason = this.toolStreamParser?.hasEmittedToolCall() || emittedNativeToolCallIds.size > 0 ? 'tool_calls' : 'stop'
        transStream.write(
          `data: ${JSON.stringify({
            id: this.conversationId,
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            created: this.created,
          })}\n\n`
        )
        transStream.end('data: [DONE]\n\n')
        this.onEnd?.()
      }
    })

    return transStream
  }

  async handleNonStream(stream: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const cachedParts: any[] = []

      const parser = createParser({
        onEvent: (event: any) => {
          try {
            const result = JSON.parse(event.data)

            if (!this.conversationId && result.conversation_id) {
              this.conversationId = result.conversation_id
            }

            if (result.status !== 'finish') {
              if (result.parts) {
                // Accumulate parts (same as handleStream), don't replace
                // GLM sends incremental parts, each event only contains new content
                result.parts.forEach((part: any) => {
                  const index = cachedParts.findIndex((p) => p.logic_id === part.logic_id)
                  if (index !== -1) {
                    cachedParts[index] = part
                  } else {
                    cachedParts.push(part)
                  }
                })
              }
            } else {
              const searchMap = new Map<string, any>()
              cachedParts.forEach((part) => {
                if (!part.content || !Array.isArray(part.content)) return
                const { meta_data } = part
                part.content.forEach((item: any) => {
                  if (item.type === 'tool_result' && meta_data?.tool_result_extra?.search_results) {
                    meta_data.tool_result_extra.search_results.forEach((res: any) => {
                      if (res.match_key) {
                        searchMap.set(res.match_key, res)
                      }
                    })
                  }
                })
              })

              const keyToIdMap = new Map<string, number>()
              let counter = 1
              let fullText = ''
              let fullReasoning = ''
              const nativeToolCalls: any[] = []

              cachedParts.forEach((part) => {
                const { content, meta_data } = part
                if (!Array.isArray(content)) return

                let partText = ''
                let partReasoning = ''

                content.forEach((value: any) => {
                  const { type, text, think, image, code, content: innerContent } = value

                  if (type === 'text') {
                    let txt = text
                    if (searchMap.size > 0) {
                      txt = txt.replace(/【?(turn\d+[a-zA-Z]+\d+)】?/g, (match: string, key: string) => {
                        const searchInfo = searchMap.get(key)
                        if (!searchInfo) return match
                        if (!keyToIdMap.has(key)) {
                          keyToIdMap.set(key, counter++)
                        }
                        return ` [${keyToIdMap.get(key)}](${searchInfo.url})`
                      })
                    }
                    partText += txt
                  } else if (type === 'think') {
                    partReasoning += think
                  } else if (type === 'image' && Array.isArray(image) && part.status === 'finish') {
                    const imageText =
                      image.reduce((imgs: string, v: any) => {
                        return imgs + (/^(http|https):\/\//.test(v.image_url) ? `![image](${v.image_url})` : '')
                      }, '') + '\n'
                    partText += imageText
                  } else if (type === 'code') {
                    partText += '```python\n' + code + '\n```\n'
                  } else if (type === 'execution_output' && typeof innerContent === 'string' && part.status === 'finish') {
                    partText += innerContent + '\n'
                  } else if (type === 'tool_calls' && value.tool_calls && typeof value.tool_calls === 'object') {
                    // GLM web 原生结构化工具调用 part
                    const tc = value.tool_calls
                    const tcName = String(tc.name || '')
                    // 白名单校验：只透传 AFS 注入的工具，过滤 GLM web 原生工具
                    const allowedNames = new Set((this.toolCallingPlan?.tools ?? []).map((t: any) => t.name))
                    if (allowedNames.size > 0 && !allowedNames.has(tcName)) {
                      console.log(`[GLM] Filtered native tool call not in allowed list: ${tcName}`)
                    } else {
                      nativeToolCalls.push({
                        id: tc.id || `call_${nativeToolCalls.length}`,
                        type: 'function',
                        function: {
                          name: tcName,
                          arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
                        },
                      })
                    }
                  }
                })

                if (partText) fullText += (fullText.length > 0 ? '\n' : '') + partText
                if (partReasoning) fullReasoning += (fullReasoning.length > 0 ? '\n' : '') + partReasoning
              })

              const { content: cleanContent, toolCalls } = this.toolCallingPlan?.shouldParseResponse
                ? { content: fullText, toolCalls: [] }
                : parseToolCallsFromText(fullText, 'glm')

              // 原生结构化 tool_calls 优先于文本解析结果
              const effectiveToolCalls = nativeToolCalls.length > 0 ? nativeToolCalls : toolCalls

              resolve({
                id: this.conversationId,
                model: this.model,
                object: 'chat.completion',
                choices: [
                  {
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: effectiveToolCalls.length > 0 ? null : cleanContent.trim(),
                      reasoning_content: fullReasoning || null,
                      ...(effectiveToolCalls.length > 0 ? { tool_calls: effectiveToolCalls } : {})
                    },
                    finish_reason: effectiveToolCalls.length > 0 ? 'tool_calls' : 'stop',
                  },
                ],
                usage: this.buildUsage(fullText + fullReasoning),
                created: Math.floor(Date.now() / 1000),
              })
            }
          } catch (err) {
            reject(err)
          }
        },
      })

      stream.on('data', (buffer: Buffer) => parser.feed(buffer.toString()))
      stream.once('error', reject)
      stream.once('close', () => {
        resolve({
          id: this.conversationId,
          model: this.model,
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '', reasoning_content: null },
              finish_reason: 'stop',
            },
          ],
          usage: this.buildUsage(''),
          created: Math.floor(Date.now() / 1000),
        })
      })
    })
  }

  getConversationId(): string {
    return this.conversationId
  }
}

export const glmAdapter = {
  GLMAdapter,
  GLMStreamHandler,
}
