import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  detectFalseFileClaim,
  extractAbsolutePaths,
  findWorkspaceRoot,
  groundingNudge,
} from '../../src/main/proxy/toolCalling/grounding.ts'

// 每个用例一个临时工作区，真实落盘，避免 mock 掉存在性判断
const root = mkdtempSync(path.join(tmpdir(), 'afs-ground-'))
const ws = path.join(root, 'ws')
mkdirSync(ws, { recursive: true })

const systemMsg = { role: 'system', content: `You are a coding agent.\nWorking directory: ${ws}` }

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

// ── 路径提取 ────────────────────────────────────────────────────────────────

test('extract: 抓 Windows 绝对路径，去掉尾部标点', () => {
  const paths = extractAbsolutePaths('已保存到 C:\\Users\\a\\Desktop\\BU.xlsx。')
  assert.deepEqual(paths, ['C:\\Users\\a\\Desktop\\BU.xlsx'])
})

test('extract: 不把 URL 当本地路径', () => {
  const paths = extractAbsolutePaths('下载链接：https://sfile.chatglm.cn/file/BU.xlsx')
  assert.ok(paths.every((p) => !p.includes('http')))
})

test('extract: 排除占位符与通配符', () => {
  const paths = extractAbsolutePaths('可以放在 C:\\path\\to\\your\\file.txt 或 C:\\tmp\\*.log 里')
  assert.deepEqual(paths, [])
})

test('workspace: 能识别 Working directory', () => {
  assert.equal(findWorkspaceRoot([systemMsg]), ws)
})

test('workspace: 没有声明时返回 null', () => {
  assert.equal(findWorkspaceRoot([{ role: 'system', content: 'You are helpful.' }]), null)
})

// ── 假阳性防护（这些是「改了 A 出 B」的来源）──────────────────────────────────

test('guard: 只是提到路径、没有创建断言 → 不重试', () => {
  const verdict = detectFalseFileClaim(
    reply('建议你把配置写到 C:\\Users\\a\\Desktop\\config.json 里，这样比较好维护。'),
    { messages: [systemMsg] },
  )
  assert.equal(verdict.retry, false)
  assert.equal(verdict.reason, 'no_claim')
})

test('guard: 有 tool_calls 一律放行', () => {
  const verdict = detectFalseFileClaim(
    reply('已写入 BU.xlsx', [{ id: 'call_0', type: 'function', function: { name: 'pwsh', arguments: '{}' } }]),
    { messages: [systemMsg] },
  )
  assert.equal(verdict.retry, false)
  assert.equal(verdict.reason, 'has_tool_calls')
})

test('guard: 长篇分析里出现路径但不含创建断言 → 不重试', () => {
  const long = '这是分析。'.repeat(80) + '脚本里会读取 assets/logo.png 这个资源。'
  const verdict = detectFalseFileClaim(reply(long), { messages: [systemMsg] })
  assert.equal(verdict.retry, false)
})

test('guard: 父目录不存在 → 判 unverifiable，不重试（可能是远程客户端）', () => {
  const target = path.join(ws, 'no-such-dir', 'deep', 'out.xlsx')
  const verdict = detectFalseFileClaim(reply(`已写入 ${target}`), { messages: [systemMsg] })
  assert.equal(verdict.retry, false)
  assert.equal(verdict.reason, 'unverifiable')
})

test('guard: Windows 上的 /mnt/data 只记日志不重试', () => {
  const verdict = detectFalseFileClaim(
    reply('已写入 /mnt/data/BU.xlsx'),
    { messages: [systemMsg] },
  )
  assert.equal(verdict.retry, false)
  if (process.platform === 'win32') {
    assert.equal(verdict.reason, 'alien_root')
    assert.deepEqual(verdict.alien, ['/mnt/data/BU.xlsx'])
  }
})

// ── 幂等：已存在的文件绝不重试 ──────────────────────────────────────────────

test('guard: 目标已存在 → idempotent_ok，不重试', () => {
  const target = path.join(ws, 'done.xlsx')
  writeFileSync(target, 'x')
  const verdict = detectFalseFileClaim(reply(`已写入 ${target}`), { messages: [systemMsg] })
  assert.equal(verdict.retry, false)
  assert.ok(verdict.reason === 'verified' || verdict.reason === 'idempotent_ok')
})

test('guard: 已存在但 mtime 很旧 → 仍不重试，只记 stale', () => {
  const target = path.join(ws, 'old.md')
  writeFileSync(target, 'x')
  const verdict = detectFalseFileClaim(reply(`已保存到 ${target}`), {
    messages: [systemMsg],
    now: Date.now() + 24 * 60 * 60 * 1000,
    staleWindowMs: 60_000,
  })
  assert.equal(verdict.retry, false)
  assert.deepEqual(verdict.stale, [target])
})

// ── 真正该抓的：谎报落盘 ────────────────────────────────────────────────────

test('guard: 断言写入 + 父目录在 + 文件不在 → 重试（绝对路径）', () => {
  delete process.env.AFS_GROUNDING_DRYRUN
  delete process.env.AFS_DISABLE_GROUNDING
  const target = path.join(ws, 'BU.xlsx')
  const verdict = detectFalseFileClaim(reply(`已写入 ${target}（工作表：NBA今日战况）`), {
    messages: [systemMsg],
  })
  assert.equal(verdict.retry, true)
  assert.equal(verdict.reason, 'missing_target')
  assert.deepEqual(verdict.missing, [target])
})

test('guard: 只说裸文件名 + 有工作目录 → 也能补全核验', () => {
  const verdict = detectFalseFileClaim(reply('已完成。文件位置：**BU2.xlsx**'), {
    messages: [systemMsg],
  })
  // 「已完成」不是创建断言，这里应当不判假；换成「已写入」才判
  assert.equal(verdict.retry, false)

  const verdict2 = detectFalseFileClaim(reply('已写入 Excel 文件 **BU2.xlsx**（工作表：比分）'), {
    messages: [systemMsg],
  })
  assert.equal(verdict2.retry, true)
  assert.ok(verdict2.missing[0].endsWith('BU2.xlsx'))
})

test('guard: DRYRUN 下只记日志、不重试', () => {
  const target = path.join(ws, 'dry.xlsx')
  process.env.AFS_GROUNDING_DRYRUN = '1'
  try {
    const verdict = detectFalseFileClaim(reply(`已写入 ${target}`), { messages: [systemMsg] })
    assert.equal(verdict.retry, false)
    assert.equal(verdict.reason, 'missing_target')
  } finally {
    delete process.env.AFS_GROUNDING_DRYRUN
  }
})

test('nudge: 只写正向动作，不出现否定句与禁止物名称', () => {
  const text = groundingNudge(['C:\\ws\\BU.xlsx'], 'managed_bracket')
  assert.ok(text.includes('C:\\ws\\BU.xlsx'))
  assert.ok(text.includes('[function_calls]'))
  assert.ok(!/没有|不要|禁止|沙盒|联网|轮数/.test(text))
})

test('nudge: xml 协议给 xml 示例', () => {
  const text = groundingNudge(['C:\\ws\\BU.xlsx'], 'managed_xml')
  assert.ok(text.includes('<tool_call>'))
  assert.ok(!text.includes('[function_calls]'))
})
