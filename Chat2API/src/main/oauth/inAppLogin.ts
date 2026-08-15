/**
 * In-App Login Manager
 * Manages in-app browser window for OAuth login and token extraction
 */

import { BrowserWindow, session, Session } from 'electron'
import { EventEmitter } from 'events'
import { ProviderType } from './types'
import { TokenExtractionConfig, getTokenExtractionConfig, TokenSource } from './tokenExtractionConfig'
import * as fs from 'fs'
import * as path from 'path'

/** 调试日志（追加写入 ~/.chat2api/logs/inapplogin-debug.log），排查弹窗一闪而过问题 */
function dbg(msg: string): void {
  try {
    const dir = path.join(require('os').homedir(), '.chat2api', 'logs')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'inapplogin-debug.log'), `${new Date().toISOString()} [InAppLogin] ${msg}\n`)
  } catch { /* ignore */ }
}

export interface InAppLoginResult {
  success: boolean
  credentials?: Record<string, string>
  error?: string
}

export interface TokenFoundEvent {
  key: string
  value: string
}

export interface InAppLoginOptions {
  providerId: string
  providerType: ProviderType
  timeout?: number
  proxyMode?: 'system' | 'none'
  /** Fixed session partition name. When set, cookies persist across restarts. */
  partition?: string
  /** When false, the window stays hidden (silent background token refresh). Default: true */
  showWindow?: boolean
}

const DEFAULT_TIMEOUT = 300000 // 5 minutes
const MIN_LOGIN_TIME = 5000 // Minimum time before checking tokens (5 seconds)

export class InAppLoginManager extends EventEmitter {
  private loginWindow: BrowserWindow | null = null
  private loginSession: Session | null = null
  private foundTokens: Map<string, string> = new Map()
  private config: TokenExtractionConfig | null = null
  private isCompleted: boolean = false
  private timeoutId: NodeJS.Timeout | null = null
  private resolvePromise: ((result: InAppLoginResult) => void) | null = null
  private loginStartTime: number = 0
  private lastTokenCheckTime: number = 0
  private options: InAppLoginOptions | null = null
  /** complete() 主动关闭窗口时置 true，允许 close 事件放行（拦截页面脚本自关） */
  private allowClose: boolean = false

  constructor() {
    super()
  }

  async startLogin(options: InAppLoginOptions): Promise<InAppLoginResult> {
    dbg(`startLogin called: provider=${options.providerType} showWindow=${options.showWindow} timeout=${options.timeout}`)
    if (this.loginWindow) {
      dbg('startLogin REJECTED: login window already open')
      return {
        success: false,
        error: 'A login window is already open',
      }
    }

    this.allowClose = false // 重置：新窗口只允许 complete() 主动关闭，拦截页面脚本自关

    this.config = getTokenExtractionConfig(options.providerType)
    if (!this.config) {
      return {
        success: false,
        error: `No token extraction config found for provider: ${options.providerType}`,
      }
    }

    this.foundTokens.clear()
    this.isCompleted = false
    this.loginStartTime = Date.now()
    this.lastTokenCheckTime = 0
    this.options = options

    return new Promise((resolve) => {
      this.resolvePromise = resolve

      this.timeoutId = setTimeout(() => {
        this.complete({
          success: false,
          error: 'Login timeout',
        })
      }, options.timeout || DEFAULT_TIMEOUT)

      this.emit('status', { status: 'starting', message: 'Opening login window...' })

      this.createLoginWindow()
      this.setupTokenInterception()
    })
  }

  private createLoginWindow(): void {
    if (!this.config) return

    const partition = this.options?.partition || `persist:oauth-${Date.now()}`
    this.loginSession = session.fromPartition(partition)
    dbg(`createLoginWindow: partition=${partition} showWindow=${this.options?.showWindow}`)

    if (this.options?.proxyMode === 'none') {
      this.loginSession.setProxy({ mode: 'direct' }).catch((error) => {
        console.error('[InAppLogin] Failed to set direct proxy:', error)
      })
    }

    this.loginWindow = new BrowserWindow({
      width: 500,
      height: 700,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition,
        webSecurity: true,
        javascript: true,
      },
      title: this.config.windowTitle || 'Login',
      autoHideMenuBar: true,
    })
    // 闭包引用当前窗口：旧窗口的 closed 事件可能延迟触发（异步），
    // 若此时 this.loginWindow 已指向新窗口，必须忽略，否则会误杀新弹窗。
    const currentWindow = this.loginWindow

    // 静默模式（showWindow=false）下不显示窗口，后台加载页面即可捕获令牌
    // 弹窗模式（默认）：立即显示窗口，不依赖 ready-to-show —— kimi.com 未登录时
    // 会重定向登录页且加载缓慢，ready-to-show 可能迟迟不触发导致窗口一直隐藏，
    // 用户看不到弹窗、干等超时（曾现"未捕获到令牌，请确认已在窗口中完成登录"）。
    if (this.options?.showWindow !== false) {
      currentWindow.show()
      currentWindow.focus()
      this.emit('status', { status: 'ready', message: 'Login window ready - please log in' })
      currentWindow.once('ready-to-show', () => {
        if (this.loginWindow === currentWindow && !currentWindow.isDestroyed()) {
          currentWindow.show()
          currentWindow.focus()
        }
      })
    }

    currentWindow.on('closed', () => {
      dbg(`window closed event (isCompleted=${this.isCompleted}, isCurrent=${this.loginWindow === currentWindow})`)
      // 旧窗口的 closed 事件可能在新窗口创建后延迟触发，此时 this.loginWindow 已指向新窗口，
      // 必须忽略——否则会误判"登录窗口被关闭"，把刚弹出的新窗口杀掉（弹窗一闪而过）。
      if (this.loginWindow !== currentWindow) {
        dbg('ignoring stale closed event from previous window')
        return
      }
      if (!this.isCompleted) {
        this.complete({
          success: false,
          error: 'Login window was closed',
        })
      }
    })

    // 追踪窗口生命周期：页面加载/失败/被脚本自关
    currentWindow.webContents.on('did-finish-load', () => {
      dbg(`did-finish-load: ${currentWindow.webContents.getURL()}`)
    })
    currentWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      dbg(`did-fail-load: code=${code} desc=${desc} url=${url}`)
    })

    // 防护：页面脚本 window.close() 在 Electron 里会直接关闭 BrowserWindow，
    // 导致登录窗口"一闪而过"。只允许本模块 complete() 主动关闭，其余一律拦截。
    currentWindow.on('close', (event) => {
      if (!this.allowClose) {
        dbg('close event BLOCKED (page script attempted window.close?)')
        event.preventDefault()
      } else {
        dbg('close event allowed (complete() initiated)')
      }
    })

    currentWindow.loadURL(this.config.loginUrl).catch((error) => {
      // 不立即 complete 关窗：保留窗口让用户看到加载失败状态，由 timeout 自然收尾。
      // 立即关窗会导致"弹窗一闪而过"且无任何提示。
      dbg(`loadURL FAILED: ${error.message}`)
      console.error('[InAppLogin] Failed to load login page:', error.message)
      this.emit('status', { status: 'error', message: `页面加载失败: ${error.message}` })
      if (this.options?.showWindow !== false && this.loginWindow === currentWindow && !currentWindow.isDestroyed()) {
        currentWindow.show()
        currentWindow.focus()
      }
    })
  }

  private setupTokenInterception(): void {
    if (!this.loginSession || !this.config) return

    // Intercept response headers to capture Set-Cookie headers
    // This is needed for HttpOnly + Secure cookies that may not be accessible via cookies.get()
    this.loginSession.webRequest.onHeadersReceived((details, callback) => {
      if (this.isCompleted) {
        callback({})
        return
      }

      const setCookieHeaders = details.responseHeaders?.['set-cookie'] || details.responseHeaders?.['Set-Cookie']
      if (setCookieHeaders && Array.isArray(setCookieHeaders)) {
        for (const cookieHeader of setCookieHeaders) {
          console.log('[InAppLogin] Set-Cookie header:', cookieHeader.substring(0, 100))
          
          const cookieParts = cookieHeader.split(';')
          const nameValue = cookieParts[0]?.trim()
          if (nameValue) {
            const equalIndex = nameValue.indexOf('=')
            if (equalIndex > 0) {
              const name = nameValue.substring(0, equalIndex)
              let value = nameValue.substring(equalIndex + 1)
              
              // Remove surrounding quotes from the value (RFC 6265 allows quoted cookie values)
              if (value.startsWith('"') && value.endsWith('"')) {
                value = value.slice(1, -1)
                console.log('[InAppLogin] Removed quotes from cookie value:', name)
              }
              
              for (const source of this.config!.tokenSources) {
                if (source.type === 'cookie' && name === source.key) {
                  console.log('[InAppLogin] Found target cookie in Set-Cookie header:', name)
                  if (this.isValidToken(value)) {
                    console.log('[InAppLogin] Cookie token is valid from Set-Cookie header')
                    this.emit('tokenFound', { key: source.key, value: value })
                  }
                }
              }
            }
          }
        }
      }

      callback({})
    })

    this.loginSession.webRequest.onBeforeSendHeaders((details, callback) => {
      if (this.isCompleted) {
        callback({ requestHeaders: details.requestHeaders })
        return
      }

      if (!this.hasMinTimePassed()) {
        callback({ requestHeaders: details.requestHeaders })
        return
      }

      const authHeader = details.requestHeaders['Authorization'] || details.requestHeaders['authorization']
      if (authHeader) {
        for (const source of this.config!.tokenSources) {
          if (source.type === 'networkHeader') {
            let token = authHeader
            if (source.extractPattern) {
              const match = authHeader.match(new RegExp(source.extractPattern))
              if (match && match[1]) {
                token = match[1]
              }
            } else if (authHeader.startsWith('Bearer ')) {
              token = authHeader.substring(7)
            }
            if (this.isValidToken(token)) {
              this.emit('tokenFound', { key: source.key, value: token })
            }
          }
        }
      }

      callback({ requestHeaders: details.requestHeaders })
    })

    this.loginSession.cookies.on('changed', async (_event, cookie, _cause, removed) => {
      if (this.isCompleted || removed) return

      console.log('[InAppLogin] Cookie changed:', { name: cookie.name, value: cookie.value ? cookie.value.substring(0, 50) + '...' : 'null', removed })

      if (!this.hasMinTimePassed()) {
        console.log('[InAppLogin] Min time not passed, skipping cookie check')
        return
      }

      for (const source of this.config!.tokenSources) {
        if (source.type === 'cookie' && cookie.name === source.key) {
          console.log('[InAppLogin] Cookie matches source key:', source.key)
          if (this.isValidToken(cookie.value)) {
            console.log('[InAppLogin] Cookie token is valid, emitting tokenFound')
            this.emit('tokenFound', { key: source.key, value: cookie.value })
          } else {
            console.log('[InAppLogin] Cookie token is invalid:', cookie.value ? cookie.value.substring(0, 50) : 'null')
          }
        }
      }

      console.log('[InAppLogin] Checking all cookies after change')
      await this.checkForTokens()
    })

    this.loginWindow?.webContents.on('did-finish-load', () => {
      console.log('[InAppLogin] Page finished loading, starting token checks')
      this.delayedTokenCheck()
    })

    this.loginWindow?.webContents.on('did-navigate-in-page', () => {
      console.log('[InAppLogin] Page navigated, starting delayed token check')
      this.delayedTokenCheck()
    })
  }

  private hasMinTimePassed(): boolean {
    return Date.now() - this.loginStartTime >= MIN_LOGIN_TIME
  }

  private delayedTokenCheck(): void {
    const now = Date.now()
    if (now - this.lastTokenCheckTime < 2000) return
    this.lastTokenCheckTime = now

    setTimeout(() => {
      if (this.isCompleted) return
      if (!this.loginWindow || this.loginWindow.isDestroyed()) return
      if (this.loginWindow.webContents.isDestroyed()) return
      if (this.hasMinTimePassed()) {
        this.checkForTokens()
      }
    }, 1000)
  }

  private isValidToken(value: string): boolean {
    console.log('[InAppLogin] Checking token validity:', value.length, value.substring(0, 20))
    
    if (!value || value.length < 5) {
      console.log('[InAppLogin] Token rejected: too short or empty')
      return false
    }
    
    // Check for JWT format (3 parts) or JWE format (5 parts)
    if (value.startsWith('eyJ')) {
      const parts = value.split('.')
      
      // JWE format (5 parts) - used by Perplexity and some other providers
      if (parts.length === 5) {
        console.log('[InAppLogin] Token appears to be JWE format (5 parts)')
        // JWE tokens are encrypted, we can't decode them, but they're valid if properly formatted
        if (value.length >= 100) {
          console.log('[InAppLogin] Token accepted as valid JWE')
          return true
        }
        console.log('[InAppLogin] JWE token rejected: too short')
        return false
      }
      
      // JWT format (3 parts)
      if (parts.length === 3) {
        try {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
          console.log('[InAppLogin] JWT payload:', payload)
          
          // Reject guest accounts
          if (payload.email && payload.email.includes('@guest.com')) {
            console.log('[InAppLogin] Token rejected: guest account')
            return false
          }
          
          if (payload && (payload.app_id || payload.sub || payload.exp || payload.id || payload.user_id || payload.uid || payload.email)) {
            console.log('[InAppLogin] Token accepted as valid JWT')
            return true
          }
        } catch {
          console.log('[InAppLogin] Token rejected: invalid JWT')
          return false
        }
      }
    }
    
    // Accept long tokens (>= 64 chars) - includes base64 chars like / + and *
    if (value.length >= 64 && /^[a-zA-Z0-9_\-+/*]+$/.test(value)) {
      console.log('[InAppLogin] Token accepted as long token')
      return true
    }
    
    // Accept medium tokens (32-63 chars) - includes base64 chars and *
    if (value.length >= 32 && value.length < 64 && /^[a-zA-Z0-9_\-+/*]+$/.test(value)) {
      console.log('[InAppLogin] Token accepted as medium token')
      return true
    }
    
    // Accept Base64-encoded tokens (may contain = padding and /)
    // This handles tokens like "SME5/AEwvmtjSu4XO18SYg=="
    if (value.length >= 20 && /^[a-zA-Z0-9_\-+/]+=*$/.test(value)) {
      console.log('[InAppLogin] Token accepted as Base64 token')
      return true
    }
    
    // Accept any token that looks like a valid string (at least 5 chars, no spaces)
    // This handles short tokens like userId
    if (value.length >= 5 && !/\s/.test(value)) {
      console.log('[InAppLogin] Token accepted as generic token')
      return true
    }
    
    console.log('[InAppLogin] Token rejected: does not match any pattern')
    return false
  }

  private async checkForTokens(): Promise<void> {
    if (!this.loginWindow || this.isCompleted || !this.config) return

    if (this.loginWindow.isDestroyed()) {
      console.log('[InAppLogin] Window is destroyed, skipping token check')
      return
    }

    const webContents = this.loginWindow.webContents
    if (webContents.isDestroyed()) {
      console.log('[InAppLogin] webContents is destroyed, skipping token check')
      return
    }

    const localStorageSources = this.config.tokenSources.filter((s) => s.type === 'localStorage')
    const cookieSources = this.config.tokenSources.filter((s) => s.type === 'cookie')

    if (localStorageSources.length === 0 && cookieSources.length === 0) return

    console.log('[InAppLogin] Checking tokens, localStorage:', localStorageSources.map(s => s.key), 'cookies:', cookieSources.map(s => s.key))

    try {
      for (const source of localStorageSources) {
        if (webContents.isDestroyed() || this.isCompleted) {
          console.log('[InAppLogin] webContents destroyed or login completed, stopping token check')
          return
        }
        const script = `
          (function() {
            try {
              const value = localStorage.getItem('${source.key}');
              console.log('[InAppLogin] localStorage.getItem("${source.key}"):', value);
              return value || null;
            } catch (e) {
              console.error('[InAppLogin] Error reading localStorage:', e);
              return null;
            }
          })()
        `
        const value = await webContents.executeJavaScript(script)
        console.log('[InAppLogin] Got value from localStorage:', source.key, value ? value.substring(0, 50) + '...' : 'null')

        if (source.key === 'user_detail_agent' && value) {
          try {
            const parsed = JSON.parse(value)
            const realUserID = parsed.realUserID || parsed.id
            if (realUserID) {
              console.log('[InAppLogin] Found realUserID from user_detail_agent:', realUserID)
              this.emit('tokenFound', { key: 'realUserID', value: String(realUserID) })
            }
          } catch (e) {
            console.error('[InAppLogin] Error parsing user_detail_agent:', e)
          }
          continue
        }

        let tokenValue = value
        if (value && value.startsWith('{') && value.endsWith('}')) {
          try {
            const parsed = JSON.parse(value)
            if (parsed.value) {
              tokenValue = parsed.value
              console.log('[InAppLogin] Extracted token from JSON:', tokenValue.substring(0, 50) + '...')
            }
          } catch (e) {
            console.error('[InAppLogin] Error parsing JSON token:', e)
          }
        }

        if (tokenValue && typeof tokenValue === 'string' && this.isValidToken(tokenValue)) {
          console.log('[InAppLogin] Token found and valid from localStorage:', source.key)
          const emitKey = source.key === '_token' ? 'token' : source.key
          this.emit('tokenFound', { key: emitKey, value: tokenValue })
        }
      }

      for (const source of cookieSources) {
        if (!this.loginSession) continue

        const allCookies = await this.loginSession.cookies.get({})
        console.log('[InAppLogin] All cookies count:', allCookies.length)
        console.log('[InAppLogin] All cookies:', allCookies.map(c => `${c.name}=${c.value?.substring(0, 20)}...`))
        
        const targetDomains = this.config?.targetDomains || []
        let cookiesToSearch = allCookies
        
        for (const domain of targetDomains) {
          try {
            const domainCookies = await this.loginSession.cookies.get({ domain })
            console.log(`[InAppLogin] Domain cookies for ${domain}:`, domainCookies.map(c => c.name))
            for (const dc of domainCookies) {
              if (!cookiesToSearch.find(c => c.name === dc.name)) {
                cookiesToSearch.push(dc)
              }
            }
          } catch (e) {
            console.log(`[InAppLogin] Error getting cookies for domain ${domain}:`, e)
          }
        }
        
        console.log('[InAppLogin] Combined cookies to search:', cookiesToSearch.map(c => c.name))

        const cookie = cookiesToSearch.find(c => c.name === source.key)
        if (cookie) {
          console.log('[InAppLogin] Found cookie:', source.key, cookie.value ? cookie.value.substring(0, 50) + '...' : 'null')

          if (cookie.value && this.isValidToken(cookie.value)) {
            console.log('[InAppLogin] Token found and valid from cookie:', source.key, 'emitting tokenFound event')
            const allCookiesObj: Record<string, string> = {}
            for (const c of cookiesToSearch) {
              if (c.value) {
                allCookiesObj[c.name] = c.value
              }
            }
            this.emit('tokenFound', { key: source.key, value: cookie.value, allCookies: allCookiesObj })
          } else {
            console.log('[InAppLogin] Cookie token is invalid:', source.key, cookie.value ? cookie.value.substring(0, 50) : 'null')
          }
        } else {
          console.log('[InAppLogin] Cookie not found:', source.key)
        }
      }
    } catch (error) {
      console.error('[InAppLogin] Error in checkForTokens:', error)
    }
  }

  completeWithSuccess(credentials: Record<string, string>): void {
    this.complete({
      success: true,
      credentials,
    })
  }

  private complete(result: InAppLoginResult): void {
    dbg(`complete() called: success=${result.success} error=${result.error || 'none'} isCompleted=${this.isCompleted}`)
    if (this.isCompleted) return
    this.isCompleted = true

    if (this.timeoutId) {
      clearTimeout(this.timeoutId)
      this.timeoutId = null
    }

    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      dbg('complete(): closing login window')
      this.allowClose = true
      this.loginWindow.close()
    }

    this.cleanup()

    if (this.resolvePromise) {
      this.resolvePromise(result)
      this.resolvePromise = null
    }

    this.emit('complete', result)
  }

  private cleanup(): void {
    if (this.loginSession) {
      try {
        this.loginSession.webRequest.onBeforeSendHeaders(() => {})
        this.loginSession.cookies.removeAllListeners()
      } catch (error) {
        console.error('[InAppLogin] Error cleaning up session:', error)
      }
      this.loginSession = null
    }

    this.loginWindow = null
    this.config = null
  }

  cancel(): void {
    if (!this.isCompleted) {
      this.complete({
        success: false,
        error: 'Login cancelled by user',
      })
    }
  }

  isWindowOpen(): boolean {
    return this.loginWindow !== null && !this.loginWindow.isDestroyed()
  }

  destroy(): void {
    this.cancel()
    this.removeAllListeners()
  }
}

export const inAppLoginManager = new InAppLoginManager()

export default InAppLoginManager
