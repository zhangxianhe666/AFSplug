# AFSplug — Chat2API 管理器

<p align="center">
  <img src="Chat2API/build/icons.png" alt="AFSplug Logo" width="128" height="128">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Release-v1.4.6-blue?style=flat-square&logo=github" alt="Release">
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
  AFSplug 是 Chat2API 的增强分支，通过官方 Web UI 零成本接入主流 AI 模型，提供 OpenAI 兼容 API 接口，支持 DeepSeek、GLM、Kimi、MiniMax、Qwen、Z.ai 等提供商，可无缝对接 Hermes、Cline、Roo-Code、Cherry Studio 等任意 OpenAI 兼容客户端。
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

## 🆕 本分支新增（v1.4.6）

- **Kimi K3 工具调用修复**：provider 切换为 `managed_bracket` 协议，K3 可正常调用工具（原 `managed_xml` 协议 K3 无法识别）
- **Kimi reasoning_effort 支持**：模型名后缀自动识别（`-adv` → 进阶/high，`-fast` → 快速/low），并支持显式 `reasoning_effort` 参数
- **工具描述清洗**：将工具描述中的 `Linux environment` 改写为 `local environment`，防止模型误判运行环境（macOS 被当成 Linux 容器）
- **GLM token 自动刷新增强**：refresh_glm_token.py 重写，更稳定的刷新流程
- **Windows 兼容**：脚本中心 Python 解释器自动探测（python3 → python → py）

## 🤖 支持提供商

| Provider         | Auth Type     | OAuth | Models |
| ---------------- | ------------- | ----- | ------ |
| DeepSeek         | User Token    | Yes   | deepseek-v4-flash, deepseek-v4-pro |
| GLM              | Refresh Token | Yes   | GLM-5.1 |
| Kimi             | JWT Token     | Yes   | Kimi-K2.6 |
| MiniMax          | JWT Token     | Yes   | MiniMax-M2.7 |
| Mimo             | Cookie        | Yes   | MiMo-V2.5-Pro, MiMo-V2.5, MiMo-V2-Flash |
| Perplexity       | Cookie        | Yes   | Auto |
| Qwen (CN)        | SSO Ticket    | Yes   | Qwen3.6, Qwen3.7-Max, Qwen3.5-Flash, Qwen3-Max, Qwen3-Max-Thinking-Preview, Qwen3-Coder |
| Qwen AI (Global) | JWT Token     | Yes   | Qwen3.7-Max, Qwen3.6-Plus, Qwen3.6-35B-A3B, Qwen3.6-27B, Qwen3-Coder |
| Z.ai             | JWT Token     | Yes   | Temporarily unavailable due to frontend captcha risk control |

## 🚀 快速开始

### 开发模式

```bash
cd Chat2API
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
git tag v1.4.6
git push origin v1.4.6
```

> 注意：electron-builder 默认创建 Draft Release，发布后需手动执行
> `gh release edit vX.Y.Z --draft=false --latest` 转为正式发布。

## 📁 项目结构

```
AFSplug/
├── Chat2API/                  # Electron 主项目
│   ├── src/
│   │   ├── main/              # 主进程
│   │   │   ├── proxy/         # 代理服务器（Koa）+ 提供商适配器
│   │   │   ├── oauth/         # OAuth 认证
│   │   │   ├── providers/     # 提供商配置
│   │   │   ├── store/         # 持久化存储
│   │   │   └── ipc/           # IPC 通信
│   │   ├── preload/           # 上下文桥接
│   │   ├── renderer/          # React 前端
│   │   └── shared/            # 共享类型
│   ├── scripts/               # 辅助脚本（GLM token 刷新等）
│   └── package.json
├── .github/workflows/release.yml  # 五平台自动构建
└── README.md
```

## 📖 详细文档

- 完整使用说明：[Chat2API/README.md](Chat2API/README.md)（[中文版](Chat2API/README_CN.md)）
- 开发维基：[Chat2API/CODE_WIKI.md](Chat2API/CODE_WIKI.md)
- 代理内部实现：[Chat2API/AGENTS.md](Chat2API/AGENTS.md)

## 💾 数据存储

应用数据存储在 `~/.chat2api/`：
- `config.json` — 应用配置
- `providers.json` — 提供商设置
- `accounts.json` — 账号凭证（加密）
- `logs/` — 请求日志

## License

GPL-3.0
