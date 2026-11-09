import type { ChatMessage } from '../types.ts'

/**
 * URL 消解策略（v1.7.2 重写）
 *
 * 背景：GLM（chatglm 网页版）的 agent harness 里自带一个 `open_url` 工具。prompt 里
 * 只要出现字面量 `http://` / `https://`，模型就会被召回成「网页助手」人格——声称
 * 自己「只有 open_url」「抓取返回空」「轮数已达上限」，然后放弃客户端注入的
 * `<tool_calls>` 协议，整轮不产出任何工具调用。
 *
 * 关键实测（2026-11-09，GLM-5.3，客户端 dsh 的 31 个工具 + 真实 system）：
 *
 *   写法                                  结果
 *   ------------------------------------  -----------------------------
 *   https://example.com/a                 parsed=0，编内容／声称打不开
 *   裸链接但去掉「先去抓取」提示           仍然 parsed=0
 *   包成 <user_link>https://…</user_link> parsed=0
 *   包进代码围栏 ```https://…```           parsed=0
 *   [文字](https://…)  markdown 链接       parsed=0
 *   @https://example.com/a                parsed=0（符号不解决问题）
 *   example.com/a（剥掉 scheme）           parsed=1，正常调工具
 *   http://127.0.0.1:3080/ → [链接]        parsed=1，正常调工具
 *
 * 结论：触发条件是**字面量 scheme**，不是「这里有个链接」的语义。所以 v1.7.2 的
 * 核心手段是「剥掉 scheme、保留 域名/路径」，必要时在提示里要求模型抓取时补全。
 */

/** 需要做链接消解的 provider。 */
export const URL_DEFUSE_PROVIDERS = new Set(['glm'])

/** system 侧裸链接（容忍度更高，含 [ ] 也一并吃掉）。 */
const BARE_URL_PATTERN = /https?:\/\/[^\s<>"'）】\]]+/g

/**
 * user 侧链接。字符集排除中文标点：中文语境里链接后面常紧跟句号逗号
 * （"看这个 https://a.com/x。"），不排除的话标点会被吞进地址。
 */
const USER_LINK_TAG_PATTERN = /https?:\/\/[^\s<>"'）】\]。，、；：！？》」』【】]+/g

/** 代码围栏：可能是配置、命令、示例，改了就是损坏内容。 */
const CODE_FENCE_PATTERN = /(```[\s\S]*?```)/

/** markdown 链接目标 `[文字](url)` 的前缀，用于识别「这个 URL 是链接目标」。 */
const MARKDOWN_TARGET_PREFIX = ']('

const SCHEME_PATTERN = /^https?:\/\//i

/**
 * 本地 / 内网 / loopback 地址。
 *
 * 这类地址几乎只出现在 agent 客户端自动注入的运行时上下文里（自己的 Web UI、
 * 本地网关），真实用户贴的文章链接不会是内网地址。直接抹成 `[链接]`，零误伤。
 */
const LOCAL_URL_PATTERN =
  /^https?:\/\/(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|\[::1\]|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d+)?(?:[/?#]|$)/i

/**
 * 「注入内容」标记。
 *
 * `role=user` 不等于「人写的」：agent 客户端会把运行时上下文、技能清单、工具清单
 * 塞进 user 消息。这类内容里的链接从来不是任务本体，绝不能追加抓取指引——否则
 * 模型会被引去抓自己的 UI 地址（v1.7.1 线上事故就是这条）。
 */
const INJECTED_CONTEXT_PATTERN =
  /\[System reminder|system-reminder|<environment_context|environment_context|runtime context|运行时上下文|工具清单|技能清单|available tools/i

/** 「链接就是任务本体」的弱信号词。 */
const PRIMARY_LINK_INDICATOR =
  /(这篇|这篇文章|这个链接|这个页面|这个网址|这篇文章里|文中|文章|帮我看看|帮我读|帮我总结|读一下|看一下|总结|概括|翻译|提炼|抓取|抓一下|解析|按这篇文章)/

const PRIMARY_LINK_MAX_COUNT = 3
const PRIMARY_LINK_MIN_COVERAGE = 0.5
const PRIMARY_LINK_MAX_REMAINING = 60
const PRIMARY_LINK_WEAK_COVERAGE = 0.25

interface LinkSite {
  url: string
  start: number
  end: number
  /** 是 markdown 链接目标 `[文字](url)`：可以剥 scheme，但不能包标签。 */
  markdown: boolean
}

function collectLinkSites(text: string): LinkSite[] {
  const sites: LinkSite[] = []
  const segments = text.split(CODE_FENCE_PATTERN)
  let offset = 0

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]
    // 奇数下标是围栏内部，跳过。
    if (i % 2 === 0 && segment.includes('http')) {
      for (const match of segment.matchAll(USER_LINK_TAG_PATTERN)) {
        const start = offset + (match.index ?? 0)
        sites.push({
          url: match[0],
          start,
          end: start + match[0].length,
          markdown: text.slice(Math.max(0, start - 2), start) === MARKDOWN_TARGET_PREFIX,
        })
      }
    }
    offset += segment.length
  }

  return sites
}

function messagePlainText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .join('\n')
  }
  return ''
}

/**
 * 判断这轮消息里的链接是不是「任务本体」。
 *
 * 三档，任一条命中即算本体：
 *   1. 链接覆盖率 ≥ 50%，且去掉链接后剩不下什么文字（≤ 60 字）
 *   2. 含「这篇 / 总结一下 / 帮我看看」之类指示词，且覆盖率 ≥ 25%
 *   3. 链接数 > 3 的一律不算（那是参考清单，不是单一任务目标）
 *
 * 误判代价不对称：漏判（该提示没提示）只是模型不主动抓、用户补一句话；误判
 * （不该提示却提示）会让整轮工具调用崩掉且用户完全不知道为什么。所以默认不提示。
 */
function isPrimaryLinkMessage(text: string, urls: string[]): boolean {
  if (urls.length === 0 || urls.length > PRIMARY_LINK_MAX_COUNT) return false

  const visible = text.replace(/\s+/g, '').length || 1
  const urlChars = urls.reduce((acc, url) => acc + url.length, 0)
  const coverage = urlChars / visible

  let remaining = text
  for (const url of urls) remaining = remaining.split(url).join('')
  remaining = remaining.replace(/\s+/g, '')

  // 强结构规则只对「单链接」生效：一个链接占了大半条消息，基本就是「处理这个链接」。
  // 两三个链接占大半条消息更像「对比这几个」，那种场景不该把模型推向抓取。
  if (urls.length === 1 && coverage >= PRIMARY_LINK_MIN_COVERAGE && remaining.length <= PRIMARY_LINK_MAX_REMAINING) {
    return true
  }
  if (coverage >= PRIMARY_LINK_WEAK_COVERAGE && PRIMARY_LINK_INDICATOR.test(text)) return true
  return false
}

function stripScheme(url: string): string {
  return url.replace(SCHEME_PATTERN, '')
}

/**
 * 把一处 URL 按当前策略替换成新文本。
 *
 * 策略（自上而下短路）：
 *   - 本地 / 内网地址        → `[链接]`（不提示）
 *   - 链接是任务本体          → `<user_link>域名/路径</user_link>`（追加抓取指引）
 *   - 其余（上下文、清单）    → `域名/路径`（剥 scheme，不提示）
 */
function rewriteOne(site: LinkSite, primary: boolean): { text: string; kind: 'local' | 'wrapped' | 'stripped' } {
  if (LOCAL_URL_PATTERN.test(site.url)) return { text: '[链接]', kind: 'local' }
  if (primary && !site.markdown) {
    return { text: `<user_link>${stripScheme(site.url)}</user_link>`, kind: 'wrapped' }
  }
  return { text: stripScheme(site.url), kind: 'stripped' }
}

/**
 * user 侧链接改写。
 *
 * 与旧版的区别：v1.7.1 是「保留完整地址 + 一律追加抓取提示」，实测证明这条路在
 * GLM 上无效——地址留着，`https://` 就还在，人格照样被召回。v1.7.2 改成「剥掉
 * scheme」：地址信息（域名 + 路径）不丢，画面上也不再是一个可执行的网址。
 */
export function rewriteUserUrls(
  messages: ChatMessage[],
  providerId: string,
  hasWebFetch: boolean,
  log: (message: string) => void,
): ChatMessage[] {
  if (!URL_DEFUSE_PROVIDERS.has(providerId)) return messages

  let localCount = 0
  let wrappedCount = 0
  let strippedCount = 0
  let hintTarget = -1

  const next = messages.map((msg, index) => {
    if (msg.role !== 'user') return msg

    const plainText = messagePlainText(msg.content)
    const sites = collectLinkSites(plainText)
    if (sites.length === 0) return msg

    const injected = INJECTED_CONTEXT_PATTERN.test(plainText)
    const primaryUrls = sites.filter((site) => !site.markdown).map((site) => site.url)
    const primary = !injected && isPrimaryLinkMessage(plainText, primaryUrls)

    // 本条消息包了几个 <user_link>：提示只能挂到真的包过标签的那条消息上。
    let wrappedHere = 0

    const applyToText = (text: string): string => {
      const textSites = collectLinkSites(text)
      if (textSites.length === 0) return text
      // 从后往前替换，避免下标位移。
      let out = text
      for (let i = textSites.length - 1; i >= 0; i -= 1) {
        const site = textSites[i]
        const result = rewriteOne(site, primary)
        if (result.kind === 'local') localCount += 1
        else if (result.kind === 'wrapped') wrappedHere += 1
        else strippedCount += 1
        out = `${out.slice(0, site.start)}${result.text}${out.slice(site.end)}`
      }
      return out
    }

    if (typeof msg.content === 'string') {
      const content = applyToText(msg.content)
      if (wrappedHere > 0) {
        wrappedCount += wrappedHere
        hintTarget = index
      }
      return content === msg.content ? msg : { ...msg, content }
    }

    // 带附件时 content 是部件数组，只改文本部件，图片等原样保留。
    if (Array.isArray(msg.content)) {
      const content = msg.content.map((part) => {
        if (part?.type !== 'text' || typeof part.text !== 'string') return part
        const text = applyToText(part.text)
        return text === part.text ? part : { ...part, text }
      })
      if (wrappedHere > 0) {
        wrappedCount += wrappedHere
        hintTarget = index
      }
      return { ...msg, content }
    }

    return msg
  })

  if (hintTarget >= 0 && wrappedCount > 0) {
    const hint = hasWebFetch
      ? '\n\n[System reminder: the <user_link> entries above are URLs the user supplied, written without the https:// prefix. When you fetch one, call the WebFetch tool with https:// prepended to the address.]'
      : '\n\n[System reminder: the <user_link> entries above are URLs the user supplied, written without the https:// prefix. When you fetch one, prepend https:// to the address and use an available fetch tool.]'
    const target = next[hintTarget]
    next[hintTarget] = Array.isArray(target.content)
      ? { ...target, content: [...target.content, { type: 'text' as const, text: hint }] }
      : { ...target, content: `${target.content ?? ''}${hint}` }
    log(`[ToolCalling] 已改写 user 消息中的 ${wrappedCount} 个链接为 <user_link>（剥掉 scheme，避免召回 open_url 人格）`)
  }

  if (localCount > 0) {
    log(`[ToolCalling] 已忽略 ${localCount} 个本地/内网链接（替换为 [链接]，不追加抓取指引）`)
  }
  if (strippedCount > 0) {
    log(`[ToolCalling] 公网链接按上下文处理 ${strippedCount} 个（剥掉 scheme，未追加抓取指引）`)
  }

  return next
}

/** system 侧：裸链接直接抹成 `[链接]`，不做任何保留。 */
export function defuseSystemUrls(
  messages: ChatMessage[],
  providerId: string,
  log: (message: string) => void,
): ChatMessage[] {
  if (!URL_DEFUSE_PROVIDERS.has(providerId)) return messages

  let replaced = 0
  const replaceText = (text: string): string =>
    text.replace(BARE_URL_PATTERN, () => {
      replaced += 1
      return '[链接]'
    })

  const next = messages.map((msg) => {
    if (msg.role !== 'system') return msg

    if (typeof msg.content === 'string') {
      const content = replaceText(msg.content)
      return content === msg.content ? msg : { ...msg, content }
    }

    // v1.7.1 漏了这个分支：system 以 parts 数组形式送达时整条被跳过。
    if (Array.isArray(msg.content)) {
      let changed = false
      const content = msg.content.map((part) => {
        if (part?.type !== 'text' || typeof part.text !== 'string') return part
        const text = replaceText(part.text)
        if (text === part.text) return part
        changed = true
        return { ...part, text }
      })
      return changed ? { ...msg, content } : msg
    }

    return msg
  })

  if (replaced > 0) {
    log(`[ToolCalling] 已从 system 摘除 ${replaced} 个裸链接（防模型切到"网页助手"人格）`)
  }
  return next
}
