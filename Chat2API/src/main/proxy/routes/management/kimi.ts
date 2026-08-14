/**
 * Management API - Kimi Token Auto-Refresh Routes
 *
 * 外部脚本/进程通过 HTTP 触发刷新；应用内部（脚本中心卡片、定时任务）
 * 直接调用 src/main/kimiRefresh.ts 的 refreshKimiToken()，不走本路由。
 */
import Router from '@koa/router'
import type { Context } from 'koa'
import { managementAuthMiddleware } from '../../middleware/managementAuth'
import { refreshKimiToken } from '../../../tokenRefresh'

const router = new Router({ prefix: '/v0/management/kimi' })

/**
 * POST /v0/management/kimi/auto-refresh
 *
 * 通过 Chat2API 内置浏览器捕获 kimi.com 新令牌并更新账户。
 * Query 参数：
 *   --force-login   强制显示登录窗口（换账号）
 */
router.post('/auto-refresh', managementAuthMiddleware, async (ctx: Context) => {
  try {
    ctx.set('Content-Type', 'application/json')
    const forceLogin = ctx.query.forceLogin === 'true'

    const result = await refreshKimiToken({ forceLogin })

    ctx.status = result.success ? 200 : 400
    ctx.body = {
      success: result.success,
      message: result.message,
      token: result.token,
    }
  } catch (error: any) {
    console.error('[Kimi Auto-Refresh] Error:', error.message)
    ctx.status = 500
    ctx.body = { success: false, error: error.message }
  }
})

export default router
