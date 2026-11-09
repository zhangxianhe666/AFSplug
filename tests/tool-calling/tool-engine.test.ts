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

// —— 回归：GLM 见到字面量 scheme 会切到「网页助手」人格 ——
//
// 实测（2026-11-09，GLM-5.3，客户端 dsh 的 31 个工具 + 真实 system）：
//   https://example.com/a                → parsed=0，声称「只有 open_url」
//   裸链接但不加抓取提示                   → parsed=0（是 URL 本身，不是提示）
//   <user_link>https://…</user_link>      → parsed=0
//   代码围栏 / markdown 链接包住 https://  → parsed=0
//   example.com/a（剥掉 scheme）           → parsed=1，正常调工具
// 结论：触发条件是字面量 `http(s)://`，因此 v1.7.2 统一「剥掉 scheme」。

const glmProvider = {
  ...provider,
  id: 'glm',
  name: 'GLM',
  apiEndpoint: 'https://chatglm.cn',
} as Provider

const webFetchTool = {
  type: 'function' as const,
  function: {
    name: 'WebFetch',
    description: 'Fetch a URL',
    parameters: { type: 'object', properties: { url: { type: 'string' } } },
  },
}

/** dsh 等客户端的抓取工具叫 web_fetch，驼峰/下划线都要能认出来。 */
const dshWebFetchTool = {
  type: 'function' as const,
  function: {
    name: 'web_fetch',
    description: 'Fetch a URL',
    parameters: { type: 'object', properties: { url: { type: 'string' } } },
  },
}

function userTextOf(result: { messages: Array<{ role: string; content: unknown }> }): string {
  return result.messages
    .filter((message) => message.role === 'user')
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map((part: any) => (part?.type === 'text' ? part.text : '')).join('')
          : '',
    )
    .join('\n')
}

test('GLM: system URLs are removed and user links lose the scheme', () => {
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

  const user = userTextOf(result)
  // 任务本体的链接：保留 域名/路径，剥掉 scheme
  assert.match(user, /<user_link>example\.com\/a<\/user_link>/)
  // 提示词里不能再出现可执行的完整地址
  assert.doesNotMatch(user.split('[System reminder')[0], /https?:\/\//)
  // 本轮没有抓取工具时，指引不能点名不存在的工具
  assert.match(user, /available fetch tool/)
})

test('GLM: hint names WebFetch when the client uses the camelCase tool', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({
      messages: [{ role: 'user', content: '总结 https://example.com/post 这篇' }],
      tools: [...tools, webFetchTool],
    }),
    provider: glmProvider,
    actualModel: 'glm-5.3',
  })

  const user = userTextOf(result)
  assert.match(user, /<user_link>example\.com\/post<\/user_link>/)
  assert.match(user, /WebFetch tool/)
  assert.match(user, /prepended/)
})

test('GLM: hint also recognizes snake_case web_fetch and namespaced names', () => {
  for (const name of ['web_fetch', 'default_api:web_fetch', 'fetch_url']) {
    const result = new ToolCallingEngine().transformRequest({
      request: request({
        messages: [{ role: 'user', content: '总结 https://example.com/post 这篇' }],
        tools: [
          ...tools,
          { type: 'function' as const, function: { ...dshWebFetchTool.function, name } },
        ],
      }),
      provider: glmProvider,
      actualModel: 'glm-5.3',
    })

    const user = userTextOf(result)
    assert.match(user, /WebFetch tool/, `tool name ${name} should be treated as a fetch tool`)
  }
})

test('GLM: URLs inside code fences are left untouched', () => {
  const content = '照着跑：\n```\ncurl -H "x: 1" https://api.example.com/v1/run\n```\n再总结 https://example.com/doc'
  const result = new ToolCallingEngine().transformRequest({
    request: request({ messages: [{ role: 'user', content }] }),
    provider: glmProvider,
    actualModel: 'glm-5.3',
  })

  const user = userTextOf(result)
  // 代码块内的原样保留（改了就是损坏内容），代码块外的剥 scheme
  assert.match(user, /curl -H "x: 1" https:\/\/api\.example\.com\/v1\/run/)
  assert.ok(!user.includes('<user_link>https://'))
  assert.match(user, /<user_link>example\.com\/doc<\/user_link>/)
})

test('GLM: markdown link targets lose the scheme but keep the link text', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ messages: [{ role: 'user', content: '参考 [官方文档](https://example.com/docs) 写一段' }] }),
    provider: glmProvider,
    actualModel: 'glm-5.3',
  })

  const user = userTextOf(result)
  // markdown 目标不能包标签（会破坏语法），但 scheme 必须剥掉
  assert.match(user, /\[官方文档\]\(example\.com\/docs\)/)
  assert.ok(!user.includes('<user_link>'))
})

test('GLM: trailing Chinese punctuation stays outside the user_link tag', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ messages: [{ role: 'user', content: '看看这篇 https://example.com/x。然后总结。' }] }),
    provider: glmProvider,
    actualModel: 'glm-5.3',
  })

  const user = userTextOf(result)
  assert.match(user, /<user_link>example\.com\/x<\/user_link>。/)
})

test('GLM: loopback and private-network URLs collapse to a placeholder', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({
      messages: [
        {
          role: 'user',
          content: '本工作区有哪些文件\n\n运行时上下文: http://127.0.0.1:3080/ 网关 http://192.168.1.9:8080/v1',
        },
      ],
    }),
    provider: glmProvider,
    actualModel: 'glm-5.3',
  })

  const user = userTextOf(result)
  assert.doesNotMatch(user.split('[System reminder')[0], /127\.0\.0\.1|192\.168/)
  assert.equal((user.match(/\[链接\]/g) ?? []).length, 2)
  // 上下文里的地址不是任务本体，绝不能追加抓取指引
  assert.doesNotMatch(user, /fetch tool/)
})

test('GLM: public URLs inside injected runtime context are stripped without a hint', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({
      messages: [
        {
          role: 'user',
          content: '本工作区有哪些文件\n\n[runtime context] 文档地址 https://www.workbuddy.cn/docs/overview',
        },
      ],
    }),
    provider: glmProvider,
    actualModel: 'glm-5.3',
  })

  const user = userTextOf(result)
  assert.match(user, /www\.workbuddy\.cn\/docs\/overview/)
  assert.ok(!user.includes('<user_link>'))
  assert.doesNotMatch(user, /fetch tool/)
})

test('GLM: a list of four or more links is treated as reference material', () => {
  const content = '参考这几个：\nhttps://a.com/1\nhttps://a.com/2\nhttps://a.com/3\nhttps://a.com/4'
  const result = new ToolCallingEngine().transformRequest({
    request: request({ messages: [{ role: 'user', content }] }),
    provider: glmProvider,
    actualModel: 'glm-5.3',
  })

  const user = userTextOf(result)
  assert.ok(!user.includes('<user_link>'))
  assert.doesNotMatch(user, /fetch tool/)
  assert.match(user, /a\.com\/1/)
})

test('GLM: two compared links are not treated as a single fetch target', () => {
  const content = '对比 https://a.com/1 和 https://b.com/2 在性能、成本、维护性上的差异，给我表格'
  const result = new ToolCallingEngine().transformRequest({
    request: request({ messages: [{ role: 'user', content }] }),
    provider: glmProvider,
    actualModel: 'glm-5.3',
  })

  const user = userTextOf(result)
  assert.ok(!user.includes('<user_link>'))
  assert.doesNotMatch(user, /fetch tool/)
})

test('GLM: known-answer indicator words still trigger the fetch hint for two links', () => {
  const content = '总结这两篇 https://a.com/1 https://b.com/2'
  const result = new ToolCallingEngine().transformRequest({
    request: request({ messages: [{ role: 'user', content }], tools: [...tools, dshWebFetchTool] }),
    provider: glmProvider,
    actualModel: 'glm-5.3',
  })

  const user = userTextOf(result)
  assert.match(user, /<user_link>a\.com\/1<\/user_link>/)
  assert.match(user, /WebFetch tool/)
})

test('other providers keep user URLs untouched', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ messages: [{ role: 'user', content: '总结 https://example.com/post' }] }),
    provider,
    actualModel: 'deepseek-chat',
  })

  const user = userTextOf(result)
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

test('GLM: system URLs inside multimodal parts are defused too', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({
      messages: [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'Docs: https://www.workbuddy.cn/docs/a' },
            { type: 'text', text: 'More: https://example.com/b' },
          ],
        },
        { role: 'user', content: 'read /tmp/a' },
      ],
    }),
    provider: glmProvider,
    actualModel: 'glm-5.3',
  })

  // 第 0 条是注入的工具提示词，原始 system 在其后。
  const systemMessage = result.messages.find(
    (m) => m.role === 'system' && Array.isArray(m.content),
  ) as { content: any[] }
  const system = systemMessage.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
  assert.doesNotMatch(system, /https?:\/\//)
  assert.equal((system.match(/\[链接\]/g) ?? []).length, 2)
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
  assert.match(text, /<user_link>example\.com\/a<\/user_link>/)
  // 图片部件的 URL 不能被改写
  const image = parts.find((p) => p.type === 'image_url')
  assert.equal(image?.image_url?.url, 'https://cdn.example.com/p.png')
})
