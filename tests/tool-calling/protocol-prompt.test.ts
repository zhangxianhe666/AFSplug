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
