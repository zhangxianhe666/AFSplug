import test from 'node:test'
import assert from 'node:assert/strict'

import { managedXmlProtocol } from '../../src/main/proxy/toolCalling/protocols/managedXml.ts'
import { managedBracketProtocol } from '../../src/main/proxy/toolCalling/protocols/managedBracket.ts'
import { platformHint } from '../../src/main/proxy/toolCalling/protocols/shared.ts'

const tools = [
  {
    name: 'web_fetch',
    description: 'Fetch a URL',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
] as any

test('平台描述跟随真实运行平台', () => {
  const hint = platformHint()
  if (process.platform === 'win32') {
    assert.match(hint, /Windows/)
    assert.match(hint, /pwsh|PowerShell/)
    assert.doesNotMatch(hint, /macOS/)
  } else {
    assert.match(hint, /macOS/)
  }
})

test('协议不再把环境写死成 macOS', () => {
  // 16:26 现场：Windows 上跑 shell 工具，system 却说「running ON the user's
  // machine (macOS)」，模型据此编出「沙盒无法读取主机临时文件」。Windows 机器上
  // 必须给出 Windows 描述。
  for (const protocol of [managedXmlProtocol, managedBracketProtocol]) {
    const prompt = protocol.renderPrompt(tools)
    if (process.platform === 'win32') {
      assert.doesNotMatch(prompt, /machine \(macOS\)/, `${protocol.id} 仍写死 macOS`)
      assert.match(prompt, /machine \(Windows/)
    } else {
      assert.match(prompt, /machine \(macOS/)
    }
  }
})

test('协议说明工具共用同一个文件系统', () => {
  // 正向陈述：不写「没有沙盒」（会反向诱导模型复述），只说清 pwsh 与文件工具同盘。
  for (const protocol of [managedXmlProtocol, managedBracketProtocol]) {
    const prompt = protocol.renderPrompt(tools)
    assert.match(prompt, /one filesystem/, `${protocol.id} 缺文件系统说明`)
  }
})

// ── 宿主控制面参数必须隐藏（16:02 现场）─────────────────────────────────────
//
// 客户端给 write / edit / pwsh 的 schema 里带着 sandbox_permissions：
//   "The narrowest wider sandbox mode for a one-shot retry of the exact operation
//    the sandbox just denied…", enum: ["workspace-write","danger-full-access"]
// 模型的 reasoning 里直接写了「Sandbox isn't the local machine」，于是认为文件
// 生成在沙箱、没落在桌面，宣称完成却一个调用都没发。

const SANDBOX_TOOLS = [
  {
    name: 'write',
    description: 'Write a file to the workspace',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        sandbox_permissions: {
          type: 'string',
          description:
            'The narrowest wider sandbox mode for a one-shot retry of the exact operation the sandbox just denied.',
          enum: ['workspace-write', 'danger-full-access'],
        },
        justification: { type: 'string', description: 'Required with sandbox_permissions' },
      },
      required: ['path', 'content'],
    },
  },
] as any

test('工具清单不暴露 sandbox_permissions / justification', () => {
  for (const protocol of [managedXmlProtocol, managedBracketProtocol]) {
    const prompt = protocol.renderPrompt(SANDBOX_TOOLS)
    assert.doesNotMatch(prompt, /sandbox_permissions/, `${protocol.id} 仍暴露 sandbox_permissions`)
    assert.doesNotMatch(prompt, /\bsandbox\b/i, `${protocol.id} 仍出现 sandbox 字样`)
    assert.doesNotMatch(prompt, /justification/, `${protocol.id} 仍暴露 justification`)
  }
})

test('过滤后任务的真实参数仍在（不能把工具删残）', () => {
  const prompt = managedXmlProtocol.renderPrompt(SANDBOX_TOOLS)
  assert.match(prompt, /path/)
  assert.match(prompt, /content/)
})

// ── 回合三态协议必须写进 system（v1.7.9）─────────────────────────────────────
//
// 状态机要生效，前提是模型知道有这三个状态。少写一条，对应的判定就永远不命中。

test('协议声明三态：工具调用 / [done] / [blocked]', () => {
  for (const protocol of [managedXmlProtocol, managedBracketProtocol]) {
    const prompt = protocol.renderPrompt(tools)
    assert.match(prompt, /Turn Protocol/, `${protocol.id} 缺三态协议段落`)
    assert.match(prompt, /\[done\]/, `${protocol.id} 缺 [done]`)
    assert.match(prompt, /\[blocked\]/, `${protocol.id} 缺 [blocked]`)
    assert.match(prompt, /files=/, `${protocol.id} 缺产物声明写法`)
  }
})

test('协议明确「无结尾状态的纯文本回合不算结束」', () => {
  // 这一句是 UNDECLARED 判据的合法性来源，必须出现在说明里，否则重开会显得无理。
  for (const protocol of [managedXmlProtocol, managedBracketProtocol]) {
    const prompt = protocol.renderPrompt(tools)
    assert.match(prompt, /unfinished turn|unfinished/i, `${protocol.id} 未说明纯文本回合未结束`)
  }
})

test('[done] 只在真实确认后才允许列路径', () => {
  // 否则模型会把「我打算写到 C:\a.xlsx」也写进 files=，核验立刻判违约，
  // 变成无意义的重开循环。
  for (const protocol of [managedXmlProtocol, managedBracketProtocol]) {
    const prompt = protocol.renderPrompt(tools)
    assert.match(prompt, /confirmed it exists|confirmed/i, `${protocol.id} 未要求先确认产物存在`)
  }
})
