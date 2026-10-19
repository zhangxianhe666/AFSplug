/**
 * DSH「直连上游」路由下的本地图片引用解析（纯逻辑，不做任何 IO）。
 *
 * 背景：DSH 的 `@文件` 引用只发一个文本标签
 * `<workspace-reference path="…" kind="file" />`，图片字节从不进入请求。
 *
 * 两条路由的处理方式不同：
 *  - 走 **ds-trim-gateway**（`baseURL: 127.0.0.1:8001`）时，网关已把引用解析成绝对路径
 *    并注入 `[[local-image:/abs/path]]` 标记，适配器只需消费标记；
 *  - 走 **直连上游**（如 DSH 的 provider `afs` → `127.0.0.1:8080`，承载 GLM / Kimi / Qwen
 *    等模型）时**根本不经过网关**，也就没有任何标记 —— 适配器必须自己算。
 *
 * 好在这类请求里本来就带着算绝对路径所需的全部信息：
 *  - 引用标签自身（通常是相对路径）
 *  - 运行时上下文里的 `session workspace: "…"`
 * 所以「相对路径 → 绝对路径」可以在这里独立完成，不依赖网关。
 *
 * @module proxy/adapters/workspaceReference
 */

import { isAbsolute, join } from 'node:path'
import { LOCAL_IMAGE_MAX_COUNT, imageMimeOf } from './localImage'

/**
 * 运行时上下文里会话工作目录的写法。
 *
 * 实际文本形如：
 * `… may modify files under the session workspace: "/Users/me/Downloads/零/测试". Some …`
 * 注意工具参数说明里也会出现 `session workspace`（但不带引号），所以必须要求引号，
 * 否则会把工具描述误当目录。
 */
const SESSION_WORKSPACE = /session workspace\s*[:：]?\s*"([^"\n]+)"/

/** DSH 的 @ 引用标签（属性顺序不保证，先整体取标签再取 path）。 */
const REFERENCE_TAG = /<workspace-reference\b[^>]*>/g

/** 标签里的 path 属性。 */
const PATH_ATTRIBUTE = /\bpath\s*=\s*"([^"]*)"/

/**
 * 从运行时上下文的文本里取出会话工作目录。
 * @param text - 可能含 `session workspace: "…"` 的文本。
 * @returns 绝对路径；取不到返回空串。
 */
export function extractWorkspaceRoot(text: string): string {
  const matched = SESSION_WORKSPACE.exec(text)
  return matched ? matched[1].trim().replace(/[/\\]+$/, '') : ''
}

/**
 * 把引用里的路径解析成绝对路径。
 * @param refPath - 标签里的 path（也可能是绝对路径）。
 * @param root - 会话工作目录，用来解析相对路径。
 * @returns 绝对路径；无从解析时返回空串。
 */
export function resolveReferencePath(refPath: string, root: string): string {
  const cleaned = refPath.trim()
  if (!cleaned) return ''
  if (isAbsolute(cleaned)) return cleaned
  return root ? join(root, cleaned) : ''
}

/**
 * 从请求里的若干段文本中收集本地图片的绝对路径（只保留图片扩展名）。
 *
 * 先在所有文本里找一次会话工作目录，再逐段解析引用标签 —— 顺序无关，
 * 因为运行时上下文往往**排在引用之前**、也可能在之后。
 * @param texts - 请求里各条消息的文本。
 * @param maxCount - 最多取几张，默认 {@link LOCAL_IMAGE_MAX_COUNT}。
 * @returns 去重并截断后的绝对路径，以及找到的会话工作目录。
 */
export function collectWorkspaceImagePaths(
  texts: readonly string[],
  maxCount: number = LOCAL_IMAGE_MAX_COUNT,
): { paths: string[]; root: string } {
  const root = extractWorkspaceRoot(texts.join('\n'))
  const paths: string[] = []

  for (const text of texts) {
    // /g 正则有 lastIndex 状态，逐段新建，模块级复用会漏匹配
    for (const tag of text.match(new RegExp(REFERENCE_TAG.source, 'g')) ?? []) {
      const raw = PATH_ATTRIBUTE.exec(tag)?.[1]?.trim()
      // 非图片引用（.pdf/.docx 等）直接跳过：这里只负责图片通道
      if (!raw || !imageMimeOf(raw)) continue
      const absPath = resolveReferencePath(raw, root)
      if (absPath && !paths.includes(absPath)) paths.push(absPath)
    }
  }

  return { paths: paths.slice(0, maxCount), root }
}

/**
 * 判断一段文本里是否出现过 DSH 的引用标签（用于日志/诊断）。
 * @param text - 待检查文本。
 * @returns 是否出现 `<workspace-reference`。
 */
export function containsWorkspaceReference(text: string): boolean {
  return text.includes('<workspace-reference')
}
