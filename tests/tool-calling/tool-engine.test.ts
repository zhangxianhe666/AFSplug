import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolCallingEngine } from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import type { ChatCompletionRequest } from '../../src/main/proxy/types.ts'
import type { Provider } from '../../src/main/store/types.ts'

const provider = {
  id: 'deepseek',
  name: 'DeepSeek',
  type: 'builtin',
  authType: 'userToken',
  apiEndpoint: 'https://chat.deepseek.com',
  headers: {},
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
} as Provider

const tools = [
  {
    type: 'function' as const,
    function: {
      name: 'default_api:read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { filePath: { type: 'string' } } },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'default_api:list_dir',
      description: 'List a directory',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  },
]

function request(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'read /tmp/a' }],
    tools,
    ...overrides,
  }
}

test('OpenAI tools plus DeepSeek choose managed prompt', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.mode, 'managed')
  assert.equal(result.plan.protocol, 'managed_xml')
  assert.equal(result.plan.shouldInjectPrompt, true)
  assert.equal(result.tools, undefined)
  assert.equal(result.plan.tools.length, 2)
  // 注入的提示词教的是中性格式 `<tool_calls><invoke ...>`，不再出现
  // `<|CHAT2API|...>` —— 后者是服务端风控的敏感特征签名（解析侧仍然兼容它，
  // 见 tool-parser.test.ts 的 Chat2API 用例，但绝不在提示词里教）。
  assert.match(result.messages[0].content as string, /<tool_calls><invoke name="exact_tool_name">/)
  assert.doesNotMatch(result.messages[0].content as string, /CHAT2API/)
})

test('explicit Cherry Studio MCP adapter uses managed prompt and preserves tool names', () => {
  const result = new ToolCallingEngine({ clientAdapterId: 'cherry-studio-mcp' }).transformRequest({
    request: request({
      messages: [
        { role: 'system', content: 'In this environment you have access to a set of tools' },
        { role: 'user', content: 'read /tmp/a' },
      ],
    }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.clientAdapterId, 'cherry-studio-mcp')
  assert.equal(result.plan.mode, 'managed')
  assert.equal(result.plan.shouldInjectPrompt, true)
  assert.equal(result.plan.tools[0].name, 'default_api:read_file')
  assert.equal(result.plan.tools[0].source, 'mcp')
})

test('client prompt signatures do not override selected adapter', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({
      messages: [
        { role: 'system', content: 'You are Kilo, the best coding agent. Tool definitions:' },
        { role: 'user', content: 'read /tmp/a' },
      ],
    }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.clientAdapterId, 'standard-openai-tools')
  assert.equal(result.plan.mode, 'managed')
  assert.equal(result.plan.shouldInjectPrompt, true)
})

test('No tools choose disabled', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ tools: undefined }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.mode, 'disabled')
  assert.equal(result.plan.shouldInjectPrompt, false)
})

test('Store mode off chooses disabled', () => {
  const result = new ToolCallingEngine({ mode: 'off', enabled: false }).transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.mode, 'disabled')
  assert.equal(result.tools, tools)
})

test('tool_choice none chooses disabled even when tools are present', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ tool_choice: 'none' }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.mode, 'disabled')
  assert.equal(result.plan.toolChoiceMode, 'none')
})

test('tool_choice required preserves required policy on the plan', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ tool_choice: 'required' }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.toolChoiceMode, 'required')
  assert.deepEqual([...result.plan.allowedToolNames].sort(), ['default_api:list_dir', 'default_api:read_file'])
})

test('forced function choice narrows allowed tool names to the selected function', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ tool_choice: { type: 'function', function: { name: 'default_api:list_dir' } } }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.toolChoiceMode, 'forced')
  assert.equal(result.plan.forcedToolName, 'default_api:list_dir')
  assert.deepEqual(result.plan.tools.map((tool) => tool.name), ['default_api:list_dir'])
})

test('non-stream parsing only accepts the selected provider protocol', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
  })
  const result: any = {
    choices: [{
      message: {
        role: 'assistant',
        content: '[function_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]',
      },
      finish_reason: 'stop',
    }],
  }

  engine.applyNonStreamResponse(result, transformed.plan)

  assert.equal(result.choices[0].message.tool_calls, undefined)
  assert.equal(result.choices[0].message.content, '[function_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]')
})

// —— 回归：GLM 见到 system 里的裸链接会切到"网页助手"人格 ——
// 实测（2026-11-04）：客户端 system 含一个 workbuddy.cn 链接时，GLM-5.3 会声称
// "只有一个 open_url 工具""轮数已达上限（3/3）"，3/3 放弃本地工具、不产出 tool_calls；
// 把该链接替换成占位符后 2/2 正常调用 Skill。因此发往 GLM 前必须摘掉 system 里的链接。

const glmProvider = {
  ...provider,
  id: 'glm',
  name: 'GLM',
  apiEndpoint: 'https://chatglm.cn',
} as Provider

test('GLM: bare URLs are removed from system but kept in the user message', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({
      messages: [
        { role: 'system', content: 'See the docs at https://www.workbuddy.cn/docs/workbuddy/Overview. Then act.' },
        { role: 'user', content: '帮我抓一下 https://example.com/a 这个页面' },
      ],
    }),
    provider: glmProvider,
    actualModel: 'glm-5.3',
  })

  const system = result.messages[0].content as string
  assert.doesNotMatch(system, /https?:\/\//)
  assert.match(system, /\[链接\]/)

  // user 侧「保留但改写」：地址一个字符不改，只包一层 <user_link>
  const user = result.messages.find((m) => m.role === 'user')?.content as string
  assert.match(user, /<user_link>https:\/\/example\.com\/a<\/user_link>/)
  // 本轮没有 WebFetch 时，指引不能点名不存在的工具
  assert.match(user, /available fetch tool/)
})

// —— user 侧链接改写：保留地址，但换一层表达 ——

const webFetchTool = {
  type: 'function' as const,
  function: {
    name: 'WebFetch',
    description: 'Fetch a URL',
    parameters: { type: 'object', properties: { url: { type: 'string' } } },
  },
}

test('GLM: user link hint names WebFetch when the tool is available', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({
      messages: [{ role: 'user', content: '总结 https://example.com/post 这篇' }],
      tools: [...tools, webFetchTool],
    }),
    provider: glmProvider,
    actualModel: 'glm-5.3',
  })

  const user = result.messages.find((m) => m.role === 'user')?.content as string
  assert.match(user, /<user_link>https:\/\/example\.com\/post<\/user_link>/)
  assert.match(user, /WebFetch tool/)
})

test('GLM: URLs inside code fences are left untouched', () => {
  const content = '照着跑：\n```\ncurl -H "x: 1" https://api.example.com/v1/run\n```\n再总结 https://example.com/doc'
  const result = new ToolCallingEngine().transformRequest({
    request: request({ messages: [{ role: 'user', content }] }),
    provider: glmProvider,
    actualModel: 'glm-5.3',
  })

  const user = result.messages.find((m) => m.role === 'user')?.content as string
  // 代码块内的原样保留，代码块外被包标记
  assert.match(user, /curl -H "x: 1" https:\/\/api\.example\.com\/v1\/run/)
  assert.ok(!user.includes('<user_link>https://api.example.com/v1/run</user_link>'))
  assert.match(user, /<user_link>https:\/\/example\.com\/doc<\/user_link>/)
})

test('GLM: markdown link targets are left untouched', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ messages: [{ role: 'user', content: '参考 [官方文档](https://example.com/docs) 写一段' }] }),
    provider: glmProvider,
    actualModel: 'glm-5.3',
  })

  const user = result.messages.find((m) => m.role === 'user')?.content as string
  assert.match(user, /\[官方文档\]\(https:\/\/example\.com\/docs\)/)
  assert.ok(!user.includes('<user_link>'))
})

test('other providers keep user URLs untouched', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ messages: [{ role: 'user', content: '总结 https://example.com/post' }] }),
    provider,
    actualModel: 'deepseek-chat',
  })

  const user = result.messages.find((m) => m.role === 'user')?.content as string
  assert.match(user, /https:\/\/example\.com\/post/)
  assert.ok(!user.includes('<user_link>'))
})

test('other providers keep system URLs untouched', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({
      messages: [
        { role: 'system', content: 'See the docs at https://www.workbuddy.cn/docs/workbuddy/Overview.' },
        { role: 'user', content: 'read /tmp/a' },
      ],
    }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.match(result.messages[0].content as string, /https:\/\/www\.workbuddy\.cn/)
})

test('GLM: trailing Chinese punctuation stays outside the user_link tag', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ messages: [{ role: 'user', content: '看看这篇 https://example.com/x。然后总结。' }] }),
    provider: glmProvider,
    actualModel: 'glm-5.3',
  })

  const user = result.messages.find((m) => m.role === 'user')?.content as string
  assert.match(user, /<user_link>https:\/\/example\.com\/x<\/user_link>。/)
})

test('GLM: user links inside multimodal text parts are rewritten too', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看看 https://example.com/a' },
            { type: 'image_url', image_url: { url: 'https://cdn.example.com/p.png' } },
          ],
        },
      ],
    }),
    provider: glmProvider,
    actualModel: 'glm-5.3',
  })

  const parts = result.messages.find((m) => m.role === 'user')?.content as any[]
  const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('')
  assert.match(text, /<user_link>https:\/\/example\.com\/a<\/user_link>/)
  // 图片部件的 URL 不能被改写
  const image = parts.find((p) => p.type === 'image_url')
  assert.equal(image?.image_url?.url, 'https://cdn.example.com/p.png')
})
