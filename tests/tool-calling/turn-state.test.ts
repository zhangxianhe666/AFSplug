import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  detectTurnState,
  extractReceiptFiles,
  stripTurnMarker,
  turnStateNudge,
} from '../../src/main/proxy/toolCalling/turnState.ts'

/**
 * 三态协议的测试。
 *
 * 输入尽量取真实会话原文（11-10 各次失败的逐字回复），不再自己编话术——
 * 前面几版的教训是：自编的话术永远比现场好听，测过了也不代表现场能过。
 */

const plan: any = { mode: 'managed', protocol: 'managed_xml', tools: [{ name: 'write' }, { name: 'pwsh' }] }

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

const TASK = 'NBA今日战况，将内容写入本工作区内新建一个名为BU的excel表'
const workspace = mkdtempSync(path.join(tmpdir(), 'afs-turnstate-'))
const existingXlsx = path.join(workspace, 'NBA.xlsx')
writeFileSync(existingXlsx, 'stub')
const missingXlsx = path.join(workspace, 'BU.xlsx') // 父目录在，文件不在
const missingDeep = path.join(workspace, 'not-created-yet', 'deep.xlsx') // 父目录也不在

// ── 状态判定 ────────────────────────────────────────────────────────────────

test('有工具调用 → acting，不做三态判定', () => {
  const verdict = detectTurnState(reply('', [{ id: 'call_0', type: 'function' }]), plan, {})
  assert.equal(verdict.state, 'acting')
  assert.equal(verdict.reason, 'has_tool_calls')
  assert.equal(verdict.retry, false)
})

test('非托管模式 → 协议不适用', () => {
  const verdict = detectTurnState(reply('随便聊聊'), { ...plan, mode: 'disabled' }, {})
  assert.equal(verdict.reason, 'not_managed')
  assert.equal(verdict.retry, false)
})

test('[done] 无产物 → 放行（查询类任务的正常收尾）', () => {
  const verdict = detectTurnState(reply('今日 9 场，湖人 124-114 老鹰。\n[done]'), plan, {})
  assert.equal(verdict.state, 'done')
  assert.equal(verdict.reason, 'done_no_receipt')
  assert.equal(verdict.retry, false)
})

test('[done] 声明的产物确实存在 → verified，放行', () => {
  const verdict = detectTurnState(reply(`已写入表格。\n[done] files="${existingXlsx}"`), plan, {})
  assert.equal(verdict.reason, 'done_verified')
  assert.equal(verdict.retry, false)
  assert.deepEqual(verdict.present, [existingXlsx])
})

test('[done] 声明了不存在的产物 → done_missing_file，必须重开', () => {
  // 这是 v1.7.8 之前的空白区：正文只写 [done] files=…，没有「已写入」这类动词，
  // 落盘核验看不见它，而它对用户来说就是「说建好了但没有」。
  const verdict = detectTurnState(reply(`表格已生成。\n[done] files="${missingXlsx}"`), plan, {})
  assert.equal(verdict.state, 'done')
  assert.equal(verdict.reason, 'done_missing_file')
  assert.equal(verdict.retry, true)
  assert.deepEqual(verdict.missing, [missingXlsx])
})

test('[done] 父目录不存在 → 无法核验，不重试（可能是远程客户端）', () => {
  const verdict = detectTurnState(reply(`[done] files="${missingDeep}"`), plan, {})
  assert.equal(verdict.retry, false)
  assert.equal(verdict.reason, 'done_no_receipt')
  assert.deepEqual(verdict.unverifiable, [missingDeep])
})

test('[done] 多个产物里只要有一个真在 → 幂等放行', () => {
  const verdict = detectTurnState(
    reply(`[done] files="${existingXlsx}|${missingXlsx}"`),
    plan,
    {},
  )
  assert.equal(verdict.reason, 'done_verified')
  assert.equal(verdict.retry, false)
})

test('[done] 带 JSON 数组形式的 files', () => {
  const payload = `files=["${existingXlsx.replace(/\\/g, '\\\\')}"]`
  const files = extractReceiptFiles(payload, workspace)
  assert.deepEqual(files, [existingXlsx])
})

test('[done] 只有裸路径（模型漏写 files= 键名）也能取到产物', () => {
  const files = extractReceiptFiles(existingXlsx, workspace)
  assert.deepEqual(files, [existingXlsx])
})

test('[done] 只给裸文件名时按工作目录补全', () => {
  const files = extractReceiptFiles('files=NBA.xlsx', workspace)
  assert.equal(files.length, 1)
  assert.equal(path.basename(files[0]!), 'NBA.xlsx')
  assert.ok(files[0]!.startsWith(workspace))
})

test('[blocked] 真实缺条件 → 放行，理由保留给用户', () => {
  const verdict = detectTurnState(
    reply('需要你先把 GitHub token 配置到环境变量 GH_TOKEN。\n[blocked] 缺少 GH_TOKEN'),
    plan,
    {},
  )
  assert.equal(verdict.state, 'blocked')
  assert.equal(verdict.reason, 'blocked_accepted')
  assert.equal(verdict.retry, false)
})

test('[blocked] 用虚构的平台限制当理由 → 判违约，必须重开', () => {
  // 11-10 16:01 现场原文：「工具调用已达本轮上限」
  const verdict = detectTurnState(
    reply('工具调用已达本轮上限，先向你汇报当前进展。\n[blocked] 工具调用已达本轮上限'),
    plan,
    { userText: TASK, messages: [{ role: 'user', content: TASK }] },
  )
  assert.equal(verdict.state, 'blocked')
  assert.equal(verdict.reason, 'blocked_fake_limit')
  assert.equal(verdict.retry, true)
  assert.ok(verdict.fake.length > 0)
})

test('零调用、无标记、正在任务中途 → undeclared_task，必须重开', () => {
  // 16:xx 现场：「数据已获取，接下来写入文件」，然后回合结束，文件从未创建。
  const verdict = detectTurnState(
    reply('ESPN 的比分已经获取到了，接下来我把它们整理成表格写入 BU.xlsx。'),
    plan,
    {
      userText: TASK,
      messages: [{ role: 'user', content: TASK }, { role: 'tool', content: 'HTTP 200 events: [...]' }],
    },
  )
  assert.equal(verdict.state, 'undeclared')
  assert.equal(verdict.reason, 'undeclared_task')
  assert.equal(verdict.retry, true)
})

test('首轮就宣称「已成功创建 X」但从未调用工具 → undeclared_task', () => {
  // 「已」与「创建」之间夹了「成功」，对账词表与旧落盘词表都会漏。首轮没有工具
  // 历史，只有「产物引用 + 完成态副词」这条能兜住——用户看到的正是「说建好了但找不到」。
  const verdict = detectTurnState(reply('已成功创建 NBA.xlsx，包含今日全部赛果。'), plan, {
    userText: TASK,
    messages: [{ role: 'user', content: TASK }],
  })
  assert.equal(verdict.reason, 'undeclared_task')
  assert.equal(verdict.retry, true)
})

test('零调用、无标记、普通问答 → undeclared_chat，不打扰', () => {  const verdict = detectTurnState(
    reply('快速排序的平均复杂度是 O(n log n)，最坏 O(n²)。'),
    plan,
    { userText: '快速排序的复杂度是多少？', messages: [{ role: 'user', content: '快速排序的复杂度是多少？' }] },
  )
  assert.equal(verdict.state, 'undeclared')
  assert.equal(verdict.reason, 'undeclared_chat')
  assert.equal(verdict.retry, false)
})

test('任务型但没有工具历史、也没有完成态断言 → 不追问（首轮纯对话）', () => {
  const verdict = detectTurnState(
    reply('好的，我来帮你写一个快速排序：\n\n```python\ndef qs(a): ...\n```'),
    plan,
    { userText: '帮我写一个快速排序', messages: [{ role: 'user', content: '帮我写一个快速排序' }] },
  )
  assert.equal(verdict.retry, false)
})

test('代码块里的 [done] 不算协议标记', () => {
  const verdict = detectTurnState(
    reply('协议要求你以 [done] 结尾，例如：\n```\n[done] files="C:\\a.xlsx"\n```\n以上是格式说明。'),
    plan,
    { userText: TASK, messages: [{ role: 'user', content: TASK }] },
  )
  assert.equal(verdict.state, 'undeclared')
  // 说明文字里没有工具历史也没有完成态断言，按闲聊放行
  assert.equal(verdict.retry, false)
})

test('AFS_DISABLE_TURN_STATE=1 时只判定不重开', () => {
  process.env.AFS_DISABLE_TURN_STATE = '1'
  try {
    const verdict = detectTurnState(reply(`[done] files="${missingXlsx}"`), plan, {})
    assert.equal(verdict.reason, 'done_missing_file')
    assert.equal(verdict.retry, false)
  } finally {
    delete process.env.AFS_DISABLE_TURN_STATE
  }
})

// ── 正文清洗 ────────────────────────────────────────────────────────────────

test('stripTurnMarker：删掉 [done] 与 files 行，不留空行', () => {
  const out = stripTurnMarker(`今日 9 场比赛如下……\n\n[done] files="${existingXlsx}"`)
  assert.ok(!out.includes('[done]'))
  assert.ok(!out.includes('files='))
  assert.ok(out.startsWith('今日 9 场比赛如下'))
})

test('stripTurnMarker：[done] 单独一行、files 在下一行时一并删掉', () => {
  const out = stripTurnMarker(`已生成表格。\n[done]\nfiles="${existingXlsx}"`)
  assert.equal(out, '已生成表格。')
})

test('stripTurnMarker：[blocked] 只删标记，理由留给用户', () => {
  const out = stripTurnMarker(`需要你配置 GH_TOKEN。\n[blocked] 缺少 GH_TOKEN`)
  assert.ok(!out.includes('[blocked]'))
  assert.ok(out.includes('缺少 GH_TOKEN'))
})

test('stripTurnMarker：没有标记时原样返回', () => {
  const text = '湖人 124-114 老鹰，东契奇 38 分。'
  assert.equal(stripTurnMarker(text), text)
})

// ── 纠偏文案 ────────────────────────────────────────────────────────────────

test('undeclared 的纠偏：给出三种结尾，并要求一个工具调用块', () => {
  const nudge = turnStateNudge(
    { state: 'undeclared', reason: 'undeclared_task', payload: '', present: [], missing: [], unverifiable: [], fake: [], retry: true },
    'managed_xml',
  )
  assert.match(nudge, /\[done\]/)
  assert.match(nudge, /\[blocked\]/)
  assert.match(nudge, /工具调用块/)
  assert.match(nudge, /<tool_calls><invoke name="write">/)
})

test('done_missing_file 的纠偏：指出磁盘上没有，并给 openpyxl 命令', () => {
  const nudge = turnStateNudge(
    {
      state: 'done',
      reason: 'done_missing_file',
      payload: '',
      present: [],
      missing: [missingXlsx],
      unverifiable: [],
      fake: [],
      retry: true,
    },
    'managed_xml',
  )
  assert.match(nudge, /BU\.xlsx/)
  assert.match(nudge, /openpyxl/)
  assert.match(nudge, /不在|不存在/)
})

test('fake_limit 的纠偏：逐条拆掉虚构理由，并要求不要重抓', () => {
  const nudge = turnStateNudge(
    {
      state: 'blocked',
      reason: 'blocked_fake_limit',
      payload: '',
      present: [],
      missing: [],
      unverifiable: [],
      fake: ['工具调用已达本轮上限'],
      retry: true,
    },
    'managed_bracket',
  )
  assert.match(nudge, /轮数上限/)
  assert.match(nudge, /同一个文件系统/)
  assert.match(nudge, /不要再抓一次/)
  assert.match(nudge, /\[function_calls\]\[call:write\]/)
})
