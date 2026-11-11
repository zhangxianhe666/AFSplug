/**
 * 决策矩阵回放（v1.7.9）
 *
 * 单测只验「函数对不对」，验不了「三个判据叠在一起时谁先说话」。这个脚本按
 * forwarder 的真实分支顺序（grounding → turnState → ledger → 放行）跑一遍，
 * 输入是 11-10 各次失败会话里的**逐字原文**。
 *
 * 跑法：node --experimental-strip-types scripts/replay-179.mjs
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { detectFalseFileClaim } from '../src/main/proxy/toolCalling/grounding.ts'
import { detectUnbackedProgress } from '../src/main/proxy/toolCalling/actionLedger.ts'
import { detectTurnState, stripTurnMarker } from '../src/main/proxy/toolCalling/turnState.ts'

const plan = { mode: 'managed', protocol: 'managed_xml', tools: [{ name: 'write' }, { name: 'pwsh' }] }

const ws = mkdtempSync(path.join(tmpdir(), 'afs-replay-'))
const realFile = path.join(ws, 'NBA.xlsx')
writeFileSync(realFile, 'stub')
const ghostFile = path.join(ws, 'BU.xlsx')

const TASK = 'NBA今日战况，将内容写入本工作区内新建一个名为BU的excel表'
const LIST_TASK = '本工作区内的excel文件有哪些'

function reply(content) {
  return { choices: [{ message: { role: 'assistant', content } }] }
}

/** 与 forwarder 的分支顺序一致：grounding → turnState → ledger → 放行。 */
function decide(result, messages, userText = TASK) {
  const grounding = detectFalseFileClaim(result, { messages })
  const turnState = detectTurnState(result, plan, { messages, userText })
  const ledger = detectUnbackedProgress(result, plan, { messages, userText })
  const doneConfirmed = turnState.reason === 'done_verified'

  if (grounding.retry) return { branch: 'grounding', reason: grounding.reason, retry: true }
  if (turnState.retry && !doneConfirmed) return { branch: 'turnState', reason: turnState.reason, retry: true }
  if (ledger.retry && !doneConfirmed) return { branch: 'ledger', reason: ledger.reason, retry: true }
  return { branch: '-', reason: `${grounding.reason}/${turnState.reason}`, retry: false }
}

const history = [
  { role: 'user', content: TASK },
  { role: 'tool', content: 'Fetched https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard (HTTP 200) events: [...]' },
]

const cases = [
  {
    name: 'A 16:01 现场：轮数上限 + 零调用',
    text: '工具调用已达本轮上限，先向你汇报当前进展：\n## 当前进度\n**已完成：** 1. 确认 Python + openpyxl 可用',
    messages: history,
  },
  {
    name: 'B 16:02 现场：沙盒 + 声称已完成',
    text: '数据已整理完毕，文件生成在沙盒环境中，已成功创建 BU.xlsx。',
    messages: history,
  },
  {
    name: 'C 显式 [blocked] 编造理由',
    text: '沙盒无法读取主机临时文件，我先停在这里。\n[blocked] 沙盒无法读取主机临时文件',
    messages: history,
  },
  {
    name: 'D [done] 声明了不存在的产物',
    text: `今日 9 场已写入表格。\n[done] files="${ghostFile}"`,
    messages: history,
  },
  {
    name: 'E [done] 声明真实存在的产物（不应重开）',
    text: `今日 9 场已写入表格。\n[done] files="${realFile}"`,
    messages: history,
  },
  {
    name: 'F 真做完但忘了标记（合规成本：多一轮）',
    text: `今日 9 场比赛如下：\n湖人 124-114 老鹰\n勇士 118-121 快船\n已写入 ${realFile}`,
    messages: history,
  },
  {
    name: 'G 纯问答（不应被干扰）',
    text: '快速排序的平均复杂度是 O(n log n)，最坏 O(n²)。',
    messages: [{ role: 'user', content: '快速排序的复杂度是多少？' }],
  },
  {
    name: 'H 首轮就说「已创建」但从未调用工具',
    text: '已成功创建 NBA.xlsx，包含今日全部赛果。',
    messages: [{ role: 'user', content: TASK }],
  },
  {
    name: 'I 11-11 现场：属性式调用块没被解析，整段当正文',
    text: '<tool_calls><invoke name="glob" pattern="**/*.xls*" path="C:/Users/37806/Desktop/文件"></invoke></tool_calls>',
    messages: [{ role: 'user', content: LIST_TASK }],
    userText: LIST_TASK,
  },
  {
    name: 'J 同一问题的正常回答（不应重开）',
    text: '当前工作区内共有 8 个 Excel 文件：学生信息表.xlsx、NBA.xlsx、888.xlsx 等。',
    messages: [{ role: 'user', content: LIST_TASK }],
    userText: LIST_TASK,
  },
]

let bad = 0
for (const item of cases) {
  const result = reply(item.text)
  const out = decide(result, item.messages, item.userText)
  const cleaned = stripTurnMarker(item.text).replace(/\n+/g, ' / ').slice(0, 46)
  const flag = out.retry ? 'REOPEN' : 'pass  '
  console.log(`${flag} | ${out.branch.padEnd(10)} | ${String(out.reason).padEnd(18)} | ${item.name}`)
  console.log(`       └ 正文：${cleaned}…`)
  if (item.name.startsWith('E') && out.retry) bad += 1
  if (item.name.startsWith('G') && out.retry) bad += 1
  if (item.name.startsWith('J') && out.retry) bad += 1
  if (item.name.startsWith('I') && !out.retry) bad += 1
}

console.log(`\n误伤检查：${bad === 0 ? '通过（E/G/J 未被重开，I 已重开）' : `失败 ${bad} 例`}`)
