import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { createWindow, getMainWindow, loadUrl, loadFile, openDevTools } from './window/manager'
import { createTrayManager, TrayManager } from './tray/TrayManager'
import { registerIpcHandlers } from './ipc/handlers'
import { UpdaterManager } from './updater'
import { storeManager } from './store/store'
import { refreshKimiToken } from './tokenRefresh'

// Prevent uncaught exceptions from crashing the app
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error)
})

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason)
})

// Workaround for V8 JIT compiler crash on macOS ARM64 (Electron 33 bug)
// Completely disable JIT compilation to prevent EXC_BAD_ACCESS crashes
// This trades some performance for stability
if (process.platform === 'darwin' && process.arch === 'arm64') {
  app.commandLine.appendSwitch('js-flags', '--jitless --no-opt')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
}

// Automatically add --no-sandbox flag when running as root user
if (process.getuid && process.getuid() === 0) {
  console.log('Detected running as root user, sandbox settings have been automatically handled')
}

declare module 'electron' {
  interface App {
    isQuitting?: boolean
  }
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const mainWindow = getMainWindow()
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }
      mainWindow.show()
      mainWindow.focus()
    }
  })

  initializeApp()
}

let trayManager: TrayManager | null = null

async function initializeApp(): Promise<void> {
  app.on('ready', async () => {
    await setupApp()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('activate', () => {
    const mainWindow = getMainWindow()
    if (!mainWindow) {
      createWindow()
    } else {
      mainWindow.show()
    }
  })

  app.on('before-quit', () => {
    app.isQuitting = true
    trayManager?.destroy()
  })

  app.on('will-quit', () => {
    cleanup()
  })
}

async function setupApp(): Promise<void> {
  const mainWindow = createWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Chat2API',
    show: false,
  })

  await registerIpcHandlers(mainWindow)

  trayManager = createTrayManager(mainWindow)

  await loadAppContent(mainWindow)

  // 应用运行期间自动保持 Kimi K3 token 新鲜：
  // 每 5 分钟静默刷新一次（窗口不弹出）；无账户或会话未登录时静默跳过，
  // 连续失败自动退避（5min → 10min → 30min），不打扰用户。
  startKimiAutoRefresh()

  if (process.env.NODE_ENV === 'development') {
    openDevTools()
  }
}

// ── Kimi K3 定时自动刷新 ──────────────────────────────────────────
let kimiRefreshTimer: NodeJS.Timeout | null = null
let kimiRefreshFailures = 0

const KIMI_REFRESH_BASE_INTERVAL = 5 * 60 * 1000

function scheduleNextKimiRefresh(delayMs: number): void {
  kimiRefreshTimer = setTimeout(async () => {
    try {
      const result = await refreshKimiToken({ silent: true })
      kimiRefreshFailures = result.success ? 0 : kimiRefreshFailures + 1
      if (result.success) {
        console.log('[KimiAutoRefresh] 定时刷新成功')
      } else {
        console.log(`[KimiAutoRefresh] 定时刷新跳过（${kimiRefreshFailures}）: ${result.message}`)
      }
    } catch (error: any) {
      kimiRefreshFailures++
      console.error('[KimiAutoRefresh] 定时刷新异常:', error?.message || error)
    }
    // 失败退避：成功 5min；连续失败 5min → 10min → 30min 封顶
    const delays = [KIMI_REFRESH_BASE_INTERVAL, KIMI_REFRESH_BASE_INTERVAL, 10 * 60 * 1000, 30 * 60 * 1000]
    const next = delays[Math.min(kimiRefreshFailures, delays.length - 1)]
    scheduleNextKimiRefresh(next)
  }, delayMs)
}

function startKimiAutoRefresh(): void {
  if (kimiRefreshTimer) return
  // 启动 1 分钟后先试一次（等 store/账户就绪），之后按退避策略循环
  scheduleNextKimiRefresh(60 * 1000)
}

function stopKimiAutoRefresh(): void {
  if (kimiRefreshTimer) {
    clearTimeout(kimiRefreshTimer)
    kimiRefreshTimer = null
  }
}

async function loadAppContent(mainWindow: BrowserWindow): Promise<void> {
  const isDev = process.env.NODE_ENV === 'development'

  if (isDev) {
    try {
      await loadUrl(process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173')
    } catch (error) {
      console.error('Failed to load development server:', error)
    }
  } else {
    try {
      await loadFile(join(__dirname, '../renderer/index.html'))
    } catch (error) {
      console.error('Failed to load production files:', error)
    }
  }
}

function cleanup(): void {
  console.log('Application is exiting, performing cleanup...')
  stopKimiAutoRefresh()
  storeManager.flushPendingWrites()
  const updaterManager = UpdaterManager.getInstance()
  updaterManager.destroy()
}

export function restartApp(): void {
  app.relaunch()
  app.quit()
}

export function getAppVersion(): string {
  return app.getVersion()
}

export function isAppQuitting(): boolean {
  return app.isQuitting ?? false
}

export { getMainWindow }
