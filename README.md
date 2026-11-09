# AFS — AI 服务统一管理器

<p align="center">
  <img src="build/icons.png" alt="AFS Logo" width="128" height="128">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Release-v1.7.3-blue?style=flat-square&logo=github" alt="Release">
  <img src="https://img.shields.io/badge/License-GPL--3.0-blue?style=flat-square" alt="License">
  <br>
  <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/Electron-33+-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron"></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat-square" alt="Platform">
</p>

<p align="center">
  <strong>多平台 AI 服务统一管理工具 · Multi-platform AI Service Unified Management Tool</strong>
</p>

<p align="center">
  AFS（仓库名 AFSplug）是 Chat2API 的增强分支，通过官方 Web UI 零成本接入主流 AI 模型，提供 OpenAI 兼容 API 接口，支持 DeepSeek、GLM、Kimi、MiniMax、Qwen、Z.ai 等提供商，可无缝对接 Hermes、Cline、Roo-Code、Cherry Studio 等任意 OpenAI 兼容客户端。
</p>

## ✨ 功能特性

- **OpenAI 兼容 API**：标准 `/v1/chat/completions` 端点，开箱即用
- **多提供商支持**：DeepSeek、GLM、Kimi、MiniMax、Perplexity、Qwen、Z.ai 等
- **Function Calling**：通过 prompt 工程为所有模型提供通用工具调用能力
- **上下文管理**：滑动窗口、Token 限制、摘要策略
- **模型映射**：通配符模型名映射，支持首选提供商/账号
- **自定义参数**：自定义 HTTP 头，启用联网搜索、思考模式、深度研究
- **仪表盘监控**：实时请求流量、Token 用量、成功率
- **API Key 管理**：为本地代理生成和管理密钥
- **系统托盘**：菜单栏快速访问状态
- **多语言**：英文 / 简体中文
- **现代化 UI**：暗色/亮色主题

## 🆕 本分支新增（v1.7.3）

- **沙箱幻觉兜底**：GLM / Kimi 网页版在服务端各挂了一个原生工具（GLM 的 `open_url` 与代码解释器、Kimi 的智能体沙箱）。当它切到沙箱执行时，会把沙箱目录当成用户机器报出来——GLM 报 `/mnt/data`、Kimi 报 `/mnt/agents`，整轮 `parsed=0`。现在命中沙箱痕迹就整轮作废重开（1/8 的失败率压到 1/64 量级）
- **「有工具却说没工具」兜底**：注入了 30 个工具，模型却回「我没有获取实时天气数据的工具，你可以自己搜」——这类回答不交给客户端，重开一轮
- **「只说不做」兜底**：模型把行动计划当最终回答交出来（「让我尝试用 python-docx……首先检查当前目录」），一个 tool_call 都没发就结束回合，用户必须再敲一句「继续」。现在这种「零工具调用 + 结尾停在过渡句」的回合会被识别并重开
- **重试带纠偏**：以前重试是把同样的 messages 再发一遍，相同输入大概率同样输出；现在追加一条纠偏消息，明确告诉它上一轮错在哪、本轮只允许输出调用块（按协议自动选 `[function_calls]` 或 `<tool_call>`）
- **工具黑名单 + 认证失败自愈**：可通过 `~/.chat2api/tool-policy.json` 的 `disabledTools`（或 `AFS_DISABLED_TOOLS`）屏蔽指定工具，只过滤注入给模型的清单、不动客户端 tools；同时扫描历史工具结果，命中 401 / `invalid api key` / `token expired` 等鉴权失败就自动摘掉那个工具，避免每轮都撞同一个坏 key
- **Kimi 令牌捕获不再「假成功」**：捕获到的 JWT 会校验 `exp`，过期或剩余不足 1 分钟判失败不写回缓存；自动刷新的成功/失败都写应用日志（含剩余分钟），不再只留在 console 里看不见

## v1.7.2

- **链接策略改为「剥 scheme」**：实测确认 GLM 的触发条件是字面量 `http(s)://`，而不是「这里有个链接」的语义——保留完整地址、换成 `<user_link>`、加不加抓取提示，一样会让它切到「网页助手」人格（`parsed=0`，整轮不产出任何工具调用）。v1.7.2 统一剥掉 `https://` 前缀、只留 `域名/路径`；只有在链接确实是任务本体时（覆盖率 ≥ 50% 且剩余文字 ≤ 60 字，或含「这篇 / 总结一下 / 帮我看看」等指示词）才包 `<user_link>` 并提示「抓取时补全 https://」，模型能正确补全，地址信息不丢
- **上下文里的链接不再被当成任务**：agent 客户端注入的运行时上下文（`[System reminder]`、`runtime context`、工具/技能清单）里的链接一律只剥 scheme、**不追加**抓取指引。之前正是这条把模型引去抓客户端自己的 Web UI 地址，导致整轮工具调用崩掉
- **本地 / 内网地址直接抹成 `[链接]`**：`localhost`、`127.0.0.1`、`::1`、`10.x`、`172.16-31.x`、`192.168.x`。agent 客户端注入的界面地址全是这一类，而真实用户贴的文章链接不会是内网地址，零误伤
- **清单与 markdown 也一并处理**：4 条以上链接按参考清单处理（只剥 scheme，不加提示）；markdown 链接目标 `[文字](url)` 同样剥 scheme（v1.7.1 为「不破坏语法」整条跳过，恰好漏掉这种最常见的投毒形式）；代码围栏内仍保持原样，避免损坏命令与配置
- **两个匹配 bug**：抓取工具名从精确 `=== 'WebFetch'` 改为归一化匹配（`WebFetch` / `web_fetch` / `fetch_url`，兼容 `default_api:` 命名空间前缀），此前 dsh 这类客户端永远判 false，提示退化成含糊的 an available fetch tool；`defuseSystemUrls` 补上 `content` 为 parts 数组的分支（v1.7.1 整条跳过）
- **回归测试**：链接策略抽成独立模块 `toolCalling/linkPolicy.ts`，新增/改写 14 个用例覆盖内网地址、注入上下文、链接清单、markdown、代码围栏、多模态部件与系统消息 parts 数组

## v1.7.1

- **工具调用解析容错**：模型偶发用中文全角引号写 `<invoke name=“Bash”>`，严格正则匹配不到，整段 XML 不报错也不解析、当普通文本透传，界面表现是"模型没调用工具"；现在会自动规范化重试。同时支持裸标签参数（`<command>x</command>`）与 `argument1/arg1/args` 这类占位参数名
- **失败不再被包装成成功**：客户端工具失败仍以 `status=completed` 回传，失败只在正文里，模型看到"有内容"就回"已完成 ✅"并给出不存在的路径。现在命中非零退出码、被信号杀死、Python/Node 崩溃，以及 **POSIX 与 Windows（cmd / PowerShell，中英文）** 的错误文案时，会前置 `[TOOL_ERROR]` 横幅并禁止宣称完成
- **贴链接不再触发"网页助手"人格**：system 中的裸链接替换为 `[链接]`（模型看到 system 里的 http 地址会幻觉 `open_url` 工具）；user 中的链接**保留完整地址**，只包成 `<user_link>…</user_link>` 并附抓取指引，代码块、markdown 链接、图片 URL 与非文本部件都不动
- **Kimi 静默刷新不再弹窗**：原方案"把窗口移到屏幕外"在 macOS 上被 constrain-to-screen 强行拉回屏幕左上角，每 5 分钟露出一次；改为 `opacity=0` + 忽略鼠标 + 不抢焦点，窗口对 Chromium 仍算 visible，SPA 照常发请求但肉眼完全不可见
- **自动刷新开关变成真开关**：此前 UI 初始值写死为关闭、从不读持久化，切换只写一个无人读取的 key，定时器与开关零关联；现在默认开启（Kimi 令牌仅 15 分钟寿命）、切换即真正启停定时器，关闭时卡片会提示需手动续期
- **GLM 令牌被吊销后自动续期**：此前没有 401 处理，而本地缓存时长是写死的 1 小时假设值，网页端退出登录或异地登录被踢后，最长一小时内所有 GLM 请求全部失败；现在收到 401 会清缓存、换新 token 并重试一次（签名与新 nonce 在重试闭包内重新生成）
- **提示词预算修正**：工具清单曾把客户端自己的 system 挤到 3,000 字符，客户端行为准则被截断；改为清单超阈值走紧凑格式（41,390 → 7,402 字符），总预算 20,000 / 客户端保留 12,000

### 历史版本要点

- **本地图片真正进入请求**（v1.7.0）：`@文件` 引用图片时，适配器会把本地图片读成字节并按各 provider 的原生通道送出 —— DeepSeek 走 `/v0/file/upload_file`（PoW 挑战按上传接口单独申请）后以 `ref_file_ids` 引用，GLM 复用其 `image_url` 附件通道；模型不再只看到一个文件名
- **两条路由都覆盖**（v1.7.0）：经过 `ds-trim-gateway` 时消费网关注入的 `[[local-image:/abs/path]]` 标记；DSH 直连上游时用 `session workspace` + 引用标签自行还原绝对路径，不依赖网关
- **失败即降级**（v1.7.0）：上传/读盘失败一律退回纯文本，绝不阻断对话；本地路径从 prompt 中剥离，不会泄露到上游
- **DeepSeek 错误不再静默**（v1.7.0）：上游用 `HTTP 200 + JSON 错误体` 报错（如 `40301 INVALID_POW_RESPONSE`）时，现在会记录日志并让请求真正失败，而不是表现为"空响应"
- **图片引用被拒自动恢复**（v1.7.0）：识别 `biz_code 9 / invalid ref file id` 后清空被污染的会话缓存，下一轮自动换新会话，无需重启
- **仓库结构扁平化**（v1.6.0）：移除 `Chat2API/` 中间层，应用代码与配置直接位于仓库根目录；Git 历史经 rename 完整保留
- **应用更名为 AFS**（v1.6.0）：菜单栏/Dock、快捷方式、桌面项、窗口标题、托盘与关于页统一显示 **AFS**，同时保留 `~/.chat2api/` 数据目录、钥匙串条目与 localStorage 键，老用户零迁移
- **工具调用参数归一化**（v1.5.9）：新增 `normalizeToolArguments`，将字符串形态的数组参数（如 `web_search.queries`）自动还原为数组，修复 GLM-5.3 等模型因参数类型不符被客户端拦截的故障
- **Schema 驱动工具提取**（v1.5.9）：managed XML 协议新增 `tryExtractSchemaDrivenCalls`，参数标签未被识别时按 JSON Schema 兜底抽取
- **DeepSeek 模型更名**（v1.5.9）：`deepseek-v4-flash` 对外名改为 `DeepSeek-V4.1-Flash`，旧名登记为 legacy 并迁移历史映射
- **Kimi K3 工具调用修复**：provider 切换为 `managed_bracket` 协议，K3 可正常调用工具
- **Kimi reasoning_effort 支持**：模型名后缀自动识别（`-adv` → 进阶/high，`-fast` → 快速/low）
- **Windows 兼容**：脚本中心 Python 解释器自动探测（python3 → python → py）

## 🤖 支持提供商

| Provider         | Auth Type     | OAuth | Models |
| ---------------- | ------------- | ----- | ------ |
| DeepSeek         | User Token    | Yes   | DeepSeek-V4.1-Flash, deepseek-v4-pro |
| GLM              | Refresh Token | Yes   | GLM-5.3, GLM-5.3-thinking |
| Kimi             | JWT Token     | Yes   | Kimi3, Kimi-K3.1 |
| MiniMax          | JWT Token     | Yes   | MiniMax-M2.7 |
| Mimo             | Cookie        | Yes   | MiMo-V2.5-Pro, MiMo-V2.5, MiMo-V2-Flash |
| Perplexity       | Cookie        | Yes   | Auto |
| Qwen (CN)        | SSO Ticket    | Yes   | Qwen3.6, Qwen3.7-Max, Qwen3.5-Flash, Qwen3-Max, Qwen3-Max-Thinking-Preview, Qwen3-Coder |
| Qwen AI (Global) | JWT Token     | Yes   | Qwen3.7-Max, Qwen3.6-Plus, Qwen3.6-35B-A3B, Qwen3.6-27B, Qwen3-Coder |
| Z.ai             | JWT Token     | Yes   | Temporarily unavailable due to frontend captcha risk control |

## 🚀 快速开始

### 开发模式

```bash
npm install
npm run dev          # macOS / Linux
npm run dev:win      # Windows
```

### 构建安装包

```bash
npm run build:mac    # macOS (dmg, zip)
npm run build:win    # Windows (nsis)
npm run build:linux  # Linux (AppImage, deb)
npm run build:all    # 全平台
```

### 自动化发布

打 `v*` 标签触发 GitHub Actions 五平台并行构建：

```bash
git tag v1.7.3
git push origin v1.7.3
```

> 注意：electron-builder 默认创建 Draft Release，发布后需手动执行
> `gh release edit vX.Y.Z --draft=false --latest` 转为正式发布。

## 📁 项目结构

```
AFSplug/
├── src/
│   ├── main/                  # 主进程
│   │   ├── proxy/             # 代理服务器（Koa）+ 提供商适配器
│   │   ├── oauth/             # OAuth 认证
│   │   ├── providers/         # 提供商配置
│   │   ├── store/             # 持久化存储
│   │   └── ipc/               # IPC 通信
│   ├── preload/               # 上下文桥接
│   ├── renderer/              # React 前端
│   └── shared/                # 共享类型
├── scripts/                   # 辅助脚本（GLM token 刷新等）
├── tests/                     # 测试（node:test + 原生 TS 剥离）
├── build/                     # 图标与打包资源
├── docs/                      # 应用文档、截图与提供商说明
├── .github/workflows/release.yml  # 五平台自动构建
└── package.json
```

## 📖 详细文档

- 完整使用说明：[docs/README.md](docs/README.md)（[中文版](docs/README_CN.md)）
- 开发维基：[CODE_WIKI.md](CODE_WIKI.md)
- 代理内部实现：[AGENTS.md](AGENTS.md)

## 💾 数据存储

应用数据存储在 `~/.chat2api/`（目录名沿用历史命名以兼容旧版本数据，应用更名 AFS 后未做迁移）：
- `data.json` — 应用配置、提供商设置与账号凭证（加密）
- `logs/` — 应用日志
- `request-logs/` — 请求日志

## License

GPL-3.0
