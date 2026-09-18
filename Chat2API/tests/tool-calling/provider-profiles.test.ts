import test from 'node:test'
import assert from 'node:assert/strict'
import { getProviderToolProfile } from '../../src/main/proxy/toolCalling/providerProfiles.ts'

const calls = [
  { id: 'call_1', name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
]

// XML 方言的提供方：DeepSeek / GLM / Qwen，以及未登记的提供方（默认走 XML）
const XML_PROVIDERS = ['deepseek', 'glm', 'qwen', 'some-unknown-provider']

test('managed providers opt in to managed prompt handling', () => {
  for (const providerId of [...XML_PROVIDERS, 'kimi']) {
    const profile = getProviderToolProfile(providerId)

    assert.equal(profile.managedSupport, true)
    assert.equal(profile.supportsNativeTools, false)
  }
})

test('XML providers use managed_xml, including the unknown-provider default', () => {
  for (const providerId of XML_PROVIDERS) {
    assert.equal(getProviderToolProfile(providerId).preferredManagedProtocol, 'managed_xml')
  }
})

test('Kimi uses the bracket dialect instead of XML', () => {
  // 44f38d6「Kimi K3 工具调用修复」将 Kimi 单独切到 managed_bracket：
  // Kimi 的原生工具调用风格是方括号方言，用 XML 提示词会诱发格式幻觉。
  assert.equal(getProviderToolProfile('kimi').preferredManagedProtocol, 'managed_bracket')
})

test('XML providers render tool history in the neutral XML dialect', () => {
  for (const providerId of XML_PROVIDERS) {
    const profile = getProviderToolProfile(providerId)

    assert.equal(
      profile.formatAssistantToolCalls(calls),
      '<tool_calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/a</parameter></invoke></tool_calls>',
    )
    assert.equal(
      profile.formatToolResult({ toolCallId: 'call_1', content: 'file body' }),
      '<tool_result tool_call_id="call_1">file body</tool_result>',
    )
  }
})

test('Kimi renders tool history in the bracket dialect', () => {
  const profile = getProviderToolProfile('kimi')

  assert.equal(
    profile.formatAssistantToolCalls(calls),
    '[function_calls]\n[call:default_api:read_file]{"filePath":"/tmp/a"}[/call]\n[/function_calls]',
  )
  assert.equal(
    profile.formatToolResult({ toolCallId: 'call_1', content: 'file body' }),
    '[TOOL_RESULT for call_1] file body',
  )
})

test('rendered history never leaks the risk-control signature strings', () => {
  // v1.5.8 起刻意去掉 `<|CHAT2API|...>` 与 `<![CDATA[...]]>`：这两者是上游风控的
  // 敏感特征签名（实测与账号禁言相关）。解析侧仍然兼容它们，但绝不主动生成。
  for (const providerId of [...XML_PROVIDERS, 'kimi']) {
    const profile = getProviderToolProfile(providerId)
    const rendered =
      profile.formatAssistantToolCalls(calls) +
      profile.formatToolResult({ toolCallId: 'call_1', content: 'file body' })

    assert.doesNotMatch(rendered, /CHAT2API/)
    assert.doesNotMatch(rendered, /<!\[CDATA\[/)
  }
})
