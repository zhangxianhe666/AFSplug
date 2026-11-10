import test from 'node:test'
import assert from 'node:assert/strict'

import {
  collectToolResults,
  detectUnbackedProgress,
  findFetchClaims,
  progressNudge,
} from '../../src/main/proxy/toolCalling/actionLedger.ts'

const plan = { mode: 'managed', tools: [{ name: 'web_fetch' }, { name: 'write' }] }

function reply(content: string, toolCalls?: unknown[]): any {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
  }
}

function toolMsg(text: string) {
  return { role: 'tool', content: text }
}

const TASK = 'NBA今日战况，将内容写入本工作区内新建一个名为NBA的excel表'

// ── 账本汇总 ────────────────────────────────────────────────────────────────

test('账本：区分成功的工具结果与失败结果', () => {
  const results = collectToolResults([
    { role: 'system', content: 'ignore' },
    toolMsg('Fetched https://site.api.espn.com (HTTP 200) events: [...]'),
    toolMsg('Fetched https://www.nba.com/games (HTTP 403) Access Denied'),
  ])
  assert.equal(results.length, 2)
  assert.equal(results.filter((r) => r.ok).length, 1)
  assert.equal(results.filter((r) => !r.ok).length, 1)
})

test('账本：没有 role=tool 的消息时返回空账本', () => {
  assert.deepEqual(collectToolResults([{ role: 'user', content: 'hi' }]), [])
})

// ── 断言提取 ────────────────────────────────────────────────────────────────

test('断言：抓「已获取 / 成功获取」类说法', () => {
  const claims = findFetchClaims('我改用 ESPN 公开比分接口成功获取了数据，确认今日有比赛。')
  assert.ok(claims.length > 0)
})

test('断言：否定语境不算已完成', () => {
  assert.deepEqual(findFetchClaims('接口返回 403，尚未获取到任何比分数据。'), [])
  assert.deepEqual(findFetchClaims('无法获取今日赛程。'), [])
})

// ── 真实失败现场 ────────────────────────────────────────────────────────────

test('现场复现：403 后谎称「改用 ESPN 成功获取」→ 判 unbacked_claim', () => {
  const result = reply(
    '很抱歉，本次任务未能全部完成。NBA 官网返回 403，改用 ESPN 公开比分接口成功获取了数据，' +
      '但接口返回的 JSON 内容较长，尚未读到具体的对阵比分数据。',
  )
  const verdict = detectUnbackedProgress(result, plan, {
    messages: [{ role: 'user', content: TASK }, toolMsg('Fetched https://www.nba.com/games (HTTP 403) Access Denied')],
    userText: TASK,
  })
  assert.equal(verdict.retry, true)
  assert.equal(verdict.reason, 'unbacked_claim')
  assert.equal(verdict.okCount, 0)
  assert.equal(verdict.failCount, 1)
})

test('有成功抓取记录时放行（可能引用上一轮真实数据）', () => {
  const result = reply('已获取今日赛程，共 8 场，均为未开始。')
  const verdict = detectUnbackedProgress(result, plan, {
    messages: [
      { role: 'user', content: TASK },
      toolMsg('Fetched https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard (HTTP 200)'),
    ],
    userText: TASK,
  })
  assert.equal(verdict.retry, false)
  assert.equal(verdict.reason, 'backed')
  assert.equal(verdict.okCount, 1)
})

test('失败后自述未完成 → 判 gave_up 重开', () => {
  const result = reply('这次任务未能完成：目标站点拒绝访问，目前还没有拿到任何数据。')
  const verdict = detectUnbackedProgress(result, plan, {
    messages: [{ role: 'user', content: TASK }, toolMsg('HTTP 403 Access Denied')],
    userText: TASK,
  })
  assert.equal(verdict.retry, true)
  assert.equal(verdict.reason, 'gave_up')
})

// ── 不应误伤的边界 ──────────────────────────────────────────────────────────

test('真的调了工具时不判定', () => {
  const result = reply('正在抓取', [{ id: 'call_0', type: 'function', function: { name: 'web_fetch', arguments: '{}' } }])
  const verdict = detectUnbackedProgress(result, plan, {
    messages: [{ role: 'user', content: TASK }],
    userText: TASK,
  })
  assert.equal(verdict.retry, false)
  assert.equal(verdict.reason, 'has_tool_calls')
})

test('闲聊不判定：用户没在要产出', () => {
  const result = reply('已获取的信息显示，NBA 有 30 支球队。')
  const verdict = detectUnbackedProgress(result, plan, {
    messages: [{ role: 'user', content: 'NBA 有多少支球队？' }],
    userText: 'NBA 有多少支球队？',
  })
  assert.equal(verdict.retry, false)
  assert.equal(verdict.reason, 'not_task')
})

test('非托管模式不判定', () => {
  const result = reply('已获取数据。')
  const verdict = detectUnbackedProgress(result, { mode: 'disabled', tools: [] }, {
    messages: [{ role: 'user', content: TASK }],
    userText: TASK,
  })
  assert.equal(verdict.retry, false)
  assert.equal(verdict.reason, 'not_managed')
})

test('账本为空且没有任何断言时不重开', () => {
  const result = reply('这是一个需要联网的任务。')
  const verdict = detectUnbackedProgress(result, plan, {
    messages: [{ role: 'user', content: TASK }],
    userText: TASK,
  })
  assert.equal(verdict.retry, false)
})

// ── 纠偏文案 ────────────────────────────────────────────────────────────────

test('纠偏文案：点出失败原因、要求下一步一个动作、带可复制调用块', () => {
  const nudge = progressNudge(
    { retry: true, reason: 'gave_up', matched: [], okCount: 0, failCount: 1, lastFailure: 'HTTP 403' },
    'managed_xml',
  )
  assert.match(nudge, /HTTP 403/)
  assert.match(nudge, /换一个同类公开来源/)
  assert.match(nudge, /<tool_call>/)
  assert.match(nudge, /本轮只做一件最小的事/)
})
