/**
 * 本地图片通道的纯逻辑（无 electron / axios 依赖，可直接单元测试）。
 *
 * 背景：DSH 的 @ 文件引用只把路径当文本发出来，图片字节从未进入请求，模型只看
 * 到一个文件名。ds-trim-gateway 与用户同机，把引用解析成绝对路径并注入
 * `[[local-image:/abs/path]]` 标记；各 provider 适配器消费这个标记。
 *
 * 标记本身与下游 provider 无关，所以抽取、组包这些纯逻辑在这里共享：
 *  - DeepSeek：读盘 → multipart 上传到 /v0/file/upload_file → `ref_file_ids`
 *  - GLM：读盘 → data URI → 复用其原生 image_url 附件通道（见 glm.ts）
 *
 * 两个来自实测的约束：
 *  1) 上传用的 PoW 挑战必须用 target_path = '/api/v0/file/upload_file' 申请，
 *     复用 completion 的挑战会被服务端拒掉（仅 DeepSeek 适用）。
 *  2) 上传失败必须退回纯文本，绝不能阻断对话。
 *
 * @module proxy/adapters/localImage
 */

import { randomBytes } from 'node:crypto'
import { extname } from 'node:path'

/** DeepSeek 网页端上传接口（相对 DEEPSEEK_API_BASE）。 */
export const UPLOAD_TARGET_PATH = '/api/v0/file/upload_file'

/**
 * 上传接口用来声明"这份文件是什么用途"的请求头。
 *
 * 实测文档：上传类型只有 `default` / `expert` / `vision`，**带图请求必须声明
 * `vision`**，否则下游退回纯文本语义——表现就是模型对着图片返回空内容，
 * 而上游既不报错也不给任何解释。上传与 completion 必须用同一个类型。
 */
export const MODEL_TYPE_HEADER = 'x-model-type'

/** 带图请求使用的模型类型。 */
export const VISION_MODEL_TYPE = 'vision'

/**
 * 文件可以被 `ref_file_ids` 引用的终态。
 *
 * 实测状态机是 `PENDING → PARSING → SUCCESS`：**只有 SUCCESS 才能引用**。
 * 把"不是 PENDING"当就绪会踩坑 —— PARSING 阶段引用同样返回
 * `biz_code 9 / invalid ref file id`。
 */
export const READY_FILE_STATUSES: readonly string[] = ['SUCCESS', 'READY', 'DONE']

/** 网页端上传大小上限约 8MB。 */
export const LOCAL_IMAGE_MAX_BYTES = 8 * 1024 * 1024

/** 单次请求最多附带几张图，避免把上游撑爆。 */
export const LOCAL_IMAGE_MAX_COUNT = 4

/** 上传结果的缓存时长：文件 id 会过期，缓存再久也没有意义。 */
export const LOCAL_IMAGE_CACHE_MS = 30 * 60 * 1000

/** 允许的图片扩展名 → MIME。 */
export const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}

/** `extractLocalImages` 的结果。 */
export interface LocalImageMarkers {
  /** 标记里的绝对路径，按出现顺序去重、并已截到上限。 */
  paths: string[]
  /** 抠掉标记后的正文。 */
  cleaned: string
}

/** 标记里出现换行或 `]` 都会被切坏，这类值直接忽略。 */
const MARKER = /\[\[local-image:([^\]\r\n]+)\]\]/g

/**
 * 从 prompt 里取出 `[[local-image:…]]` 标记。
 *
 * 标记是网关与适配器之间的私有协议，绝不能留在送给模型的正文里（会把本地
 * 绝对路径泄露给上游），所以这里既抽取也剥离。
 * @param prompt - 网关拼好的上游正文。
 * @param maxCount - 单次请求最多取几张，默认 {@link LOCAL_IMAGE_MAX_COUNT}。
 * @returns 绝对路径列表与剥离标记后的正文。
 */
export function extractLocalImages(
  prompt: string,
  maxCount: number = LOCAL_IMAGE_MAX_COUNT,
): LocalImageMarkers {
  const paths: string[] = []
  // 每次新建正则：/g 正则带 lastIndex 状态，模块级复用会漏匹配
  const cleaned = prompt.replace(MARKER, (_all, value: string) => {
    const target = value.trim()
    if (target && !paths.includes(target)) paths.push(target)
    return ''
  })
  return {
    paths: paths.slice(0, maxCount),
    // 标记被抠掉后会留下空行，顺手压掉，避免污染正文
    cleaned: cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
  }
}

/**
 * 按扩展名给出图片 MIME；未知扩展名返回空串。
 * 真正的格式判定由服务端按文件内容做，这里只是给出声明值。
 * @param filePath - 本地文件路径。
 * @returns MIME 字符串，未知则 `''`。
 */
export function imageMimeOf(filePath: string): string {
  return IMAGE_MIME_BY_EXT[extname(filePath).toLowerCase()] ?? ''
}

/**
 * 提取标记的开头，供调用方快速判断"这段文本里有没有标记"。
 */
export const LOCAL_IMAGE_MARKER_PREFIX = '[[local-image:'

/**
 * 把一段文本里的 `[[local-image:…]]` 标记替换成上游可引用的 URI。
 *
 * 与 {@link extractLocalImages} 的分工：这里把"读盘/转引用"作为参数注入，让调用方
 * 决定怎么把绝对路径变成上游认识的形式——DeepSeek 走 multipart 上传拿 file_id，
 * GLM 走 data URI。注入之后这段逻辑没有任何 IO，可以直接测。
 * @param text - 含标记的文本。
 * @param toUri - 绝对路径 → 上游引用字符串；返回空串表示这张图跳过。
 * @returns 剥离标记后的文本、成功的 URI 列表、命中的标记张数。
 */
export function resolveLocalImageUris(
  text: string,
  toUri: (absPath: string) => string,
): { cleaned: string; uris: string[]; found: number } {
  const { paths, cleaned } = extractLocalImages(text)
  const uris: string[] = []
  for (const absPath of paths) {
    const uri = toUri(absPath)
    if (uri) uris.push(uri)
  }
  return { cleaned, uris, found: paths.length }
}

/**
 * 把图片字节包成 `data:` URI。
 *
 * GLM 的上传接口（`uploadFile`）原生接受 base64 data URI，所以本地文件只要读成
 * data URI 就能直接复用那条通道，不需要另写一套上传。
 * @param mime - 图片 MIME；为空时退化成 `application/octet-stream`。
 * @param data - 图片字节。
 * @returns 形如 `data:image/png;base64,…` 的字符串。
 */
export function buildDataUri(mime: string, data: Buffer): string {
  return `data:${mime || 'application/octet-stream'};base64,${data.toString('base64')}`
}

/**
 * 从 `GET /v0/file/fetch_files` 的响应里取出某个 file id 的解析状态。
 *
 * 上传后文件的 `status` 初始是 `PENDING`，必须等到离开 `PENDING` 才能被
 * `ref_file_ids` 引用（否则服务端返回 `biz_code 9 / invalid ref file id`，
 * 并污染整个会话）。不同实现的响应层级略有差异，这里做宽容解析。
 * @param payload - fetch_files 的响应体。
 * @param fileId - 要查询的 file id。
 * @returns 状态字符串（如 `PENDING` / `SUCCESS`），取不到返回 `''`。
 */
export function extractFileStatus(payload: unknown, fileId: string): string {
  const entries = collectFileObjects(payload)
  const hit = entries.find(entry => entry.id === fileId) ?? entries[0]
  return typeof hit?.status === 'string' ? hit.status : ''
}

/** 递归捞出响应里所有形如 `{ id, status }` 的文件对象。 */
function collectFileObjects(value: unknown, depth = 0): { id?: string; status?: string }[] {
  // 响应层级可能是 biz_data.files[]、biz_data.list[].file…，留够深度；
  // JSON 无环，深度上限只是防御性护栏。
  if (depth > 8 || value === null || typeof value !== 'object') return []
  if (Array.isArray(value)) {
    return value.flatMap(item => collectFileObjects(item, depth + 1))
  }
  const record = value as Record<string, unknown>
  const found: { id?: string; status?: string }[] = []
  if (typeof record.id === 'string') {
    found.push({
      id: record.id,
      ...typeof record.status === 'string' ? { status: record.status } : {},
    })
  }
  for (const nested of Object.values(record)) {
    if (nested !== null && typeof nested === 'object') {
      found.push(...collectFileObjects(nested, depth + 1))
    }
  }
  return found
}

/**
 * 手工拼 multipart/form-data 正文。
 *
 * 手拼而不是用 FormData/Blob：Electron 主进程里全局 FormData 的可用性与实现
 * 细节不稳定，手拼的字节是确定的、可测试的。
 * @param filename - 上报的文件名（会做头部注入过滤）。
 * @param mime - 文件 MIME。
 * @param data - 文件字节。
 * @param boundary - 指定分隔串（测试用）；省略则随机生成。
 * @returns 待发送的正文与它声明的 boundary。
 */
export function buildMultipartBody(
  filename: string,
  mime: string,
  data: Buffer,
  boundary: string = `----DSHFormBoundary${randomBytes(12).toString('hex')}`,
): { body: Buffer; boundary: string } {
  const safeName = filename.replace(/[\r\n"]/g, '_') || 'image'
  const head = Buffer.from(
    `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n`
    + `Content-Type: ${mime}\r\n\r\n`,
    'utf8',
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  return { body: Buffer.concat([head, data, tail]), boundary }
}
