import test from 'node:test'
import assert from 'node:assert/strict'
import {
  detectAuthFailedTools,
  partitionDisabledTools,
  resolveToolPolicy,
} from '../../src/main/proxy/toolCalling/toolPolicy.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

/** 真实的 Word COM 失败输出（截取关键行）。 */
const WORD_COM_FAILURE = `Created: C:\\Users\\37806\\Desktop\\文件\\晚秋.docx
[stderr]
New-Object : Retrieving the COM class factory for component with CLSID {000209FF-0000-0000-C000-000000000046} failed du
e to the following error: 80070005 Access is denied. (Exception from HRESULT: 0x80070005 (E_ACCESSDENIED)).
    + CategoryInfo          : NotSpecified: (:) [New-Object], UnauthorizedAccessException
    + FullyQualifiedErrorId : System.UnauthorizedAccessException,Microsoft.PowerShell.Commands.NewObjectCommand`

/** 真实的 web_search 401（截取关键行）。 */
const WEB_SEARCH_401 = 'Error: DeepSeek API error (HTTP 401): {"type":"error","error":{"type":"authentication_error","message":"invalid api key"}}'

function assistantCall(id: string, name: string): ChatMessage {
  return { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }] } as ChatMessage
}

function toolResult(id: string, text: string): ChatMessage {
  return { role: 'tool', tool_call_id: id, content: text } as ChatMessage
}

test('UNC/ACL 类权限错误不会把 pwsh 判成认证失败', () => {
  const failed = detectAuthFailedTools([assistantCall('call_0', 'pwsh'), toolResult('call_0', WORD_COM_FAILURE)])
  assert.equal(failed.size, 0)
})

test('真正的 401 仍然会屏蔽对应工具', () => {
  const failed = detectAuthFailedTools([assistantCall('call_0', 'web_search'), toolResult('call_0', WEB_SEARCH_401)])
  assert.deepEqual([...failed], ['web_search'])
})

test('同一工具后来成功过就解除屏蔽', () => {
  const failed = detectAuthFailedTools([
    assistantCall('call_0', 'web_search'),
    toolResult('call_0', WEB_SEARCH_401),
    assistantCall('call_1', 'web_search'),
    toolResult('call_1', '搜索成功：3 条结果'),
  ])
  assert.equal(failed.size, 0)
})

test('只认最近一次结果：先成功再失败仍然屏蔽', () => {
  const failed = detectAuthFailedTools([
    assistantCall('call_0', 'web_search'),
    toolResult('call_0', '搜索成功：3 条结果'),
    assistantCall('call_1', 'web_search'),
    toolResult('call_1', WEB_SEARCH_401),
  ])
  assert.deepEqual([...failed], ['web_search'])
})

test('dsh 每轮都用 call_0 时不会把失败算到别的工具头上', () => {
  const failed = detectAuthFailedTools([
    assistantCall('call_0', 'pwsh'),
    toolResult('call_0', 'Exit Code: 0'),
    assistantCall('call_0', 'web_search'),
    toolResult('call_0', WEB_SEARCH_401),
    assistantCall('call_0', 'read'),
    toolResult('call_0', 'file content'),
  ])

  assert.deepEqual([...failed], ['web_search'])
})

test('带命名空间前缀的工具名归一化后比较', () => {
  const failed = detectAuthFailedTools([
    assistantCall('call_0', 'default_api:web_search'),
    toolResult('call_0', WEB_SEARCH_401),
  ])
  assert.deepEqual([...failed], ['web_search'])
})

test('partitionDisabledTools 只摘掉被屏蔽的名字', () => {
  const tools = [
    { name: 'web_search', parameters: { type: 'object' }, source: 'openai' as const },
    { name: 'web_fetch', parameters: { type: 'object' }, source: 'openai' as const },
    { name: 'pwsh', parameters: { type: 'object' }, source: 'openai' as const },
  ]
  const { kept, removed } = partitionDisabledTools(tools, new Set(['web_search']))

  assert.deepEqual(removed, ['web_search'])
  assert.deepEqual(kept.map((t) => t.name), ['web_fetch', 'pwsh'])
})

test('配置与环境变量取并集', () => {
  const policy = resolveToolPolicy({ path: 'C:/definitely/not/here.json', env: { AFS_DISABLED_TOOLS: 'Web_Search, foo' } })
  assert.deepEqual(policy.disabledTools.sort(), ['foo', 'web_search'])
})
