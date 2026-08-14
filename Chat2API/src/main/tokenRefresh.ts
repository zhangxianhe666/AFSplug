/**
 * Token 自动刷新 — 主进程内置实现（Kimi K3 / GLM）
 *
 * 产品化设计：不依赖外部 python 脚本 / Management API / launchd / cron。
 * 脚本中心卡片、应用内定时任务都调用本模块：
 *
 *   Kimi：隐藏窗口加载 kimi.com（复用持久会话），拦截 Authorization 头捕获令牌
 *   GLM ：隐藏窗口加载 chatglm.cn（复用持久会话），从会话 cookie store 读取
 *         chatglm_refresh_token
 *
 *   1. 静默模式（默认）：不弹窗，后台加载页面捕获新令牌，适合定时自动刷新
 *   2. 首次使用/会话失效：静默失败后自动升级为可见登录窗口，等待用户登录
 *   3. 无账户时：弹窗登录成功后自动创建账户（新用户零门槛，无需手动抓 token）
 *   4. 成功后通过 AccountManager 更新账户（内存 + 持久化，下个请求立即生效）
 */
import { session } from 'electron'
import { oauthManager } from './oauth/manager'
import AccountManager from './store/accounts'
import type { Account, ProviderVendor } from '../shared/types'

/** 固定会话分区 — cookie 跨应用重启保留 */
const SESSION_PARTITIONS: Record<string, string> = {
  kimi: 'persist:kimi-session',
  glm: 'persist:glm-session',
}

/** GLM 的 refresh token cookie 名（与 tokenExtractionConfig 一致） */
const GLM_COOKIE_NAME = 'chatglm_refresh_token'

const SILENT_TIMEOUT = 60_000    // 静默尝试上限（会话已登录时通常几秒完成）
const GLM_SILENT_TIMEOUT = 30_000 // GLM 走 cookie 读取，页面加载完成即可
const LOGIN_TIMEOUT = 300_000    // 可见登录窗口等待上限（5 分钟）

export type TokenRefreshProvider = 'kimi' | 'glm'

export interface TokenRefreshOptions {
  /** 强制显示登录窗口（换账号/会话失效时用）。默认 false：先静默，失败自动升级弹窗 */
  forceLogin?: boolean
  /** 仅静默尝试，失败不弹窗（定时任务用，避免无人值守时弹窗等待） */
  silent?: boolean
}

export interface TokenRefreshResult {
  success: boolean
  message: string
  token?: string
}

/** 各提供方的凭证格式 */
function credentialsFor(providerType: TokenRefreshProvider, token: string): Record<string, string> {
  if (providerType === 'glm') {
    const creds: Record<string, string> = { refresh_token: token, token }
    return creds
  }
  const creds: Record<string, string> = { accessToken: token, token }
  return creds
}

/** 捕获到的 token 写入账户（内存 + 持久化，立即生效） */
function saveToken(providerType: TokenRefreshProvider, accountId: string, token: string): void {
  AccountManager.update(accountId, { credentials: credentialsFor(providerType, token) })
  console.log(`[TokenRefresh:${providerType}] token saved to account ${accountId}`)
}

/** 保存或自动创建账户 */
function saveOrCreate(
  providerType: TokenRefreshProvider,
  account: Account | undefined,
  token: string,
): TokenRefreshResult {
  const masked = token.slice(0, 30) + '...'
  if (account) {
    saveToken(providerType, account.id, token)
    return { success: true, message: '令牌已刷新', token: masked }
  }
  const created = AccountManager.create({
    providerId: providerType,
    name: providerType === 'glm' ? 'GLM 账户' : 'Kimi 账户',
    credentials: credentialsFor(providerType, token),
  })
  console.log(`[TokenRefresh:${providerType}] created account ${created.id}`)
  return { success: true, message: '登录成功，已自动创建账户', token: masked }
}

/** 通过内置浏览器捕获令牌（Kimi: Authorization 头；GLM: cookie store） */
async function captureToken(
  providerType: TokenRefreshProvider,
  showWindow: boolean,
  timeoutMs: number,
): Promise<string | null> {
  const partition = SESSION_PARTITIONS[providerType]

  // GLM：无论 tokenFound 是否触发，加载完成后从会话 cookie store 读取
  // （已登录会话刷新页面不会重发 Set-Cookie，必须直接读 cookie）
  if (providerType === 'glm') {
    try {
      await oauthManager.startInAppLogin(
        'glm-auto',
        'glm' as any,
        timeoutMs,
        'system',
        partition,
        showWindow,
      )
    } catch (e) {
      console.log('[TokenRefresh:glm] in-app login error:', e)
    }
    try {
      const cookies = await session.fromPartition(partition).cookies.get({ name: GLM_COOKIE_NAME })
      const value = cookies[0]?.value
      if (value) {
        console.log('[TokenRefresh:glm] captured cookie via session store')
        return value
      }
    } catch (e) {
      console.log('[TokenRefresh:glm] cookie read error:', e)
    }
    return null
  }

  // Kimi：依赖网络请求头拦截
  const result = await oauthManager.startInAppLogin(
    'kimi-auto',
    'kimi' as any,
    timeoutMs,
    'system',
    partition,
    showWindow,
  )
  if (!result.success || !result.credentials) {
    console.log(`[TokenRefresh:kimi] capture failed: ${result.error || 'no credentials'}`)
    return null
  }
  return result.credentials.token || result.credentials.accessToken || null
}

/**
 * 刷新指定提供方（kimi / glm）的 token。
 *
 * 默认（forceLogin=false, silent=false）：
 *   已有账户：静默尝试 → 成功返回；失败自动升级为可见登录窗口（5 分钟）。
 *   无账户：直接弹窗登录，成功后自动创建账户。
 * 定时任务传 silent=true：只静默尝试，失败返回 false，不弹窗。
 */
export async function refreshProviderToken(
  providerType: TokenRefreshProvider,
  options: TokenRefreshOptions = {},
): Promise<TokenRefreshResult> {
  const { forceLogin = false, silent = false } = options

  const accounts = AccountManager.getAll(false)
  const account = accounts.find(a => a.providerId === providerType)

  // 强制登录：直接显示窗口
  if (forceLogin) {
    const token = await captureToken(providerType, true, LOGIN_TIMEOUT)
    if (!token) {
      return { success: false, message: '登录超时或未捕获到令牌，请重试' }
    }
    return saveOrCreate(providerType, account, token)
  }

  // 已有账户：先静默尝试（复用持久会话）
  if (account) {
    const silentTimeout = providerType === 'glm' ? GLM_SILENT_TIMEOUT : SILENT_TIMEOUT
    const token = await captureToken(providerType, false, silentTimeout)
    if (token) {
      return saveOrCreate(providerType, account, token)
    }
    // 定时任务模式：不弹窗
    if (silent) {
      return { success: false, message: '静默刷新失败（会话未登录或服务不可达）' }
    }
  } else if (silent) {
    // 定时任务且无账户：不弹窗，等用户手动点卡片
    return { success: false, message: `未找到 ${providerType === 'glm' ? 'GLM' : 'Kimi'} 账户，请先点卡片登录` }
  }

  // 手动触发：弹窗登录（新用户首次 / 已有账户会话失效）
  const loginToken = await captureToken(providerType, true, LOGIN_TIMEOUT)
  if (!loginToken) {
    return { success: false, message: '未捕获到令牌，请确认已在窗口中完成登录' }
  }
  return saveOrCreate(providerType, account, loginToken)
}

/** Kimi (K3) 便捷入口 */
export function refreshKimiToken(options: TokenRefreshOptions = {}): Promise<TokenRefreshResult> {
  return refreshProviderToken('kimi', options)
}

/** GLM 便捷入口 */
export function refreshGlmToken(options: TokenRefreshOptions = {}): Promise<TokenRefreshResult> {
  return refreshProviderToken('glm', options)
}
