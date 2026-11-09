/**
 * Kimi K3 令牌定时保活 —— 定时器与「自动刷新」开关的唯一权威实现
 *
 * 拆成独立模块的原因：启动流程（src/main/index.ts）和 IPC（ipc/handlers.ts）
 * 都要控制同一个定时器。若放在 index.ts 里，handlers 反向 import 会形成
 * 循环依赖（index → handlers → index），esbuild 打包后行为不确定。
 *
 * 开关语义：
 *   - 权威存储：electron-store 的 `scripts:k3_auto_refresh:enabled`
 *     （脚本中心 UI 读写同一个 key，避免两套状态）
 *   - 缺省值 true：Kimi 的 access_token 只有 15 分钟寿命，关掉保活就会在
 *     15 分钟后全量 401（adapters/kimi.ts 的 checkResult 只抛错不续期），
 *     所以"未设置"必须按开启处理。
 */
import { storeManager } from './store/store'
import { refreshKimiToken } from './tokenRefresh'

/** 与脚本中心卡片共用同一个持久化 key */
export const KIMI_AUTO_REFRESH_KEY = 'scripts:k3_auto_refresh:enabled'

const BASE_INTERVAL = 5 * 60 * 1000
const FIRST_DELAY = 60 * 1000

let timer: NodeJS.Timeout | null = null
let failures = 0

export interface KimiAutoRefreshState {
  enabled: boolean
  running: boolean
}

/** 读开关；未设置视为开启（token 15 分钟就过期，默认关会直接不可用） */
export function isKimiAutoRefreshEnabled(): boolean {
  const raw = storeManager.getStore()?.get(KIMI_AUTO_REFRESH_KEY)
  if (raw === undefined || raw === null) return true
  return raw === true
}

function scheduleNext(delayMs: number): void {
  timer = setTimeout(async () => {
    timer = null
    try {
      const result = await refreshKimiToken({ silent: true })
      failures = result.success ? 0 : failures + 1
      if (result.success) {
        console.log('[KimiAutoRefresh] 定时刷新成功')
        storeManager.addLog('info', `[KimiAutoRefresh] 定时刷新成功：${result.message}`)
      } else {
        console.log(`[KimiAutoRefresh] 定时刷新跳过（${failures}）: ${result.message}`)
        // 静默刷新失败以前只打在 stdout 里，打包后的 GUI 进程看不到，用户只能
        // 在 15 分钟后撞上 401。落一条到应用日志，至少「保活断了」是可观测的。
        storeManager.addLog(
          'warn',
          `[KimiAutoRefresh] 定时刷新失败（连续 ${failures} 次）：${result.message}`,
        )
      }
    } catch (error: any) {
      failures++
      console.error('[KimiAutoRefresh] 定时刷新异常:', error?.message || error)
    }
    // 失败也固定 5 分钟重试：token 有效期仅 15 分钟，退避超过 5 分钟会让 token
    // 在重试前就过期（曾现 5→10→30min 退避导致 16:19 刷新成功后 17:36 仍 401）。
    if (isKimiAutoRefreshEnabled()) {
      scheduleNext(BASE_INTERVAL)
    } else {
      console.log('[KimiAutoRefresh] 开关已关闭，停止后续调度')
    }
  }, delayMs)
}

/**
 * 启动保活。开关为关时不动。
 * @param immediate true 时 5 秒后先刷一次（用户刚打开开关，马上看到效果）
 */
export function startKimiAutoRefresh(immediate = false): KimiAutoRefreshState {
  if (!isKimiAutoRefreshEnabled()) {
    console.log('[KimiAutoRefresh] 开关为关闭状态，不启动定时器')
    return { enabled: false, running: false }
  }
  if (timer) return { enabled: true, running: true }
  failures = 0
  // 启动后先等一分钟（等 store/账户就绪）
  scheduleNext(immediate ? 5 * 1000 : FIRST_DELAY)
  console.log(`[KimiAutoRefresh] 定时器已启动（首次 ${immediate ? 5 : 60} 秒后，之后每 5 分钟）`)
  return { enabled: true, running: true }
}

export function stopKimiAutoRefresh(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
    console.log('[KimiAutoRefresh] 定时器已停止')
  }
}

/** 写开关并同步定时器状态（IPC 与 UI 的唯一入口） */
export function setKimiAutoRefreshEnabled(enabled: boolean): KimiAutoRefreshState {
  storeManager.getStore()?.set(KIMI_AUTO_REFRESH_KEY, enabled)
  if (enabled) {
    return startKimiAutoRefresh(true)
  }
  stopKimiAutoRefresh()
  return { enabled: false, running: false }
}

export function getKimiAutoRefreshState(): KimiAutoRefreshState {
  return { enabled: isKimiAutoRefreshEnabled(), running: timer !== null }
}
