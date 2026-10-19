import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import { build } from 'esbuild'

const root = process.cwd()

/**
 * DSH「直连上游」路由下的本地图片引用解析。
 *
 * 背景：DSH 里配了两类路由——走 trim 网关的（有 `[[local-image:…]]` 标记）和
 * **直连上游的**（如 provider `afs` → 127.0.0.1:8080，承载 GLM/Kimi/Qwen）。
 * 后者不经过网关，没有任何标记，只能由适配器自己从
 * `<workspace-reference>` + 运行时上下文里的 `session workspace` 算出绝对路径。
 *
 * 这段逻辑一旦算错，表现是"模型看不到图"而毫无报错，所以逐条锁住。
 */
const mod = await (async () => {
  const result = await build({
    entryPoints: [join(root, 'src/main/proxy/adapters/workspaceReference.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
  })
  const code = result.outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
})()

/** 真实会话里的运行时上下文（原文照抄）。 */
const RUNTIME_CONTEXT = [
  'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
  '',
  'Current DSH file policy: workspace-write. Any available operation enforced by the DSH '
  + 'file sandbox may modify files under the session workspace: '
  + '"/Users/zhangxianhe/Downloads/zero/测试". Some platform temporary areas may also be writable.',
  '',
  'Approval policy: ask.',
].join('\n')

const ref = (p) => `<workspace-reference path="${p}" kind="file" />`

test('抽出会话工作目录', () => {
  assert.equal(mod.extractWorkspaceRoot(RUNTIME_CONTEXT), '/Users/zhangxianhe/Downloads/zero/测试')
})

test('工具描述里的 session workspace（无引号）不得被误当目录', () => {
  // 工具参数说明里会出现这种句子，它没有引号
  const toolDoc = 'a relative path is resolved against the session workspace; '
    + 'use it to locate files.'
  assert.equal(mod.extractWorkspaceRoot(toolDoc), '')
})

test('相对路径按 session workspace 补全成绝对路径', () => {
  const { paths, root } = mod.collectWorkspaceImagePaths([
    '@图片_20251204161442.png 理解图片内容',
    RUNTIME_CONTEXT,
    ref('图片_20251204161442.png'),
  ])

  assert.equal(root, '/Users/zhangxianhe/Downloads/zero/测试')
  assert.deepEqual(paths, ['/Users/zhangxianhe/Downloads/zero/测试/图片_20251204161442.png'])
})

test('顺序无关：引用排在运行时上下文之前也能解析', () => {
  const { paths } = mod.collectWorkspaceImagePaths([ref('a.png'), RUNTIME_CONTEXT])
  assert.deepEqual(paths, ['/Users/zhangxianhe/Downloads/zero/测试/a.png'])
})

test('绝对路径引用不依赖 workspace', () => {
  const { paths } = mod.collectWorkspaceImagePaths([ref('/tmp/shots/screen.png')])
  assert.deepEqual(paths, ['/tmp/shots/screen.png'])
})

test('没有 workspace 时相对路径无法解析（不猜）', () => {
  const { paths, root } = mod.collectWorkspaceImagePaths([ref('a.png')])
  assert.equal(root, '')
  assert.deepEqual(paths, [])
})

test('只认图片扩展名，文档引用被跳过', () => {
  const { paths } = mod.collectWorkspaceImagePaths([
    RUNTIME_CONTEXT,
    ref('报告.pdf'),
    ref('照片.jpg'),
    ref('说明.docx'),
    ref('截图.webp'),
  ])
  assert.deepEqual(paths, [
    '/Users/zhangxianhe/Downloads/zero/测试/照片.jpg',
    '/Users/zhangxianhe/Downloads/zero/测试/截图.webp',
  ])
})

test('去重并按上限截断', () => {
  const many = ['1.png', '2.png', '1.png', '3.png', '4.png', '5.png'].map(ref)
  const { paths } = mod.collectWorkspaceImagePaths([RUNTIME_CONTEXT, ...many])
  assert.equal(paths.length, 4, '默认上限 4 张')
  assert.equal(new Set(paths).size, 4, '不能重复')
})

test('属性顺序变化也能取到 path', () => {
  const { paths } = mod.collectWorkspaceImagePaths([
    RUNTIME_CONTEXT,
    '<workspace-reference kind="file" path="b.png" />',
  ])
  assert.deepEqual(paths, ['/Users/zhangxianhe/Downloads/zero/测试/b.png'])
})

test('containsWorkspaceReference 用于诊断日志', () => {
  assert.equal(mod.containsWorkspaceReference(ref('a.png')), true)
  assert.equal(mod.containsWorkspaceReference('普通文本'), false)
})

test('重复调用同一条文本结果稳定（/g 正则不得残留状态）', () => {
  const texts = [RUNTIME_CONTEXT, ref('a.png'), ref('b.png')]
  const first = mod.collectWorkspaceImagePaths(texts).paths
  const second = mod.collectWorkspaceImagePaths(texts).paths
  assert.deepEqual(second, first)
})
