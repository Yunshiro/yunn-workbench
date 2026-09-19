<p align="center">
  <img src="./web/public/icon.svg" width="104" height="104" alt="Yunn Workbench 图标" />
</p>

<h1 align="center">Yunn Workbench</h1>

<p align="center">
  本地优先的 AI 内容工作台：聚合 RSS 信息，完成阅读筛选、内容分析、选题研究与草稿创作。
</p>

<p align="center">
  <a href="https://github.com/Yunshiro/yunn-workbench/actions/workflows/desktop-build.yml">
    <img src="https://github.com/Yunshiro/yunn-workbench/actions/workflows/desktop-build.yml/badge.svg" alt="Desktop build" />
  </a>
  <a href="https://github.com/Yunshiro/yunn-workbench/releases">
    <img src="https://img.shields.io/github/v/release/Yunshiro/yunn-workbench?include_prereleases&label=release" alt="GitHub Release" />
  </a>
</p>

## 关于项目

Yunn Workbench 希望把内容创作者日常使用的多种工具收进同一个工作台：从订阅信息源开始，经过阅读、收藏和 AI 分析，形成选题，再沉淀为可继续编辑的草稿。

项目同时提供 Web 版和 Electron 桌面版。两者复用同一套 React 界面、Express API 和 SQLite 数据层，因此核心功能保持一致；桌面版会在本机启动后端服务，不依赖远程服务器。

## 核心功能

- **RSS 信息流**：管理订阅源，定时抓取内容，支持分页、已读和收藏状态。
- **AI 内容处理**：对单篇或多篇内容执行摘要、评估、聚类和选题发现。
- **研究工作台**：围绕选题与 Agent 多轮协作，可选择编辑、增长或研究视角。
- **创作者画像**：保存受众、内容领域、表达风格和长期偏好，为任务提供稳定上下文。
- **多模型配置**：支持多个模型配置快速切换，也支持 OpenAI 兼容接口。
- **提示词管理**：在界面中调整任务指令，无需直接修改服务端代码。
- **选题与草稿**：保存候选选题，关联素材，并继续完成草稿写作。
- **本地数据存储**：SQLite、模型配置、提示词和研究会话默认保存在用户本机。
- **Web 与桌面共存**：同一套业务能力可通过浏览器或 macOS、Windows 客户端使用。

## 下载桌面版

前往 [GitHub Releases](https://github.com/Yunshiro/yunn-workbench/releases) 下载最新版本：

- macOS Apple Silicon：下载 `.dmg`
- Windows x64：下载 `Yunn-Workbench-Setup.exe`

桌面版已经包含运行所需的前端、服务端和 Electron 环境，普通用户不需要安装 Node.js。首次使用时，只需要在 **Agent 设置** 中配置自己的模型服务和 API Key。

> [!WARNING]
> 当前 Beta 安装包未进行代码签名。macOS 可能提示无法验证开发者，可在 Finder 中右键应用并选择“打开”；Windows 可能显示“未知发布者”或 SmartScreen 提示。请只从本仓库的 Releases 页面下载安装包。

## 从源码运行 Web 版

### 环境要求

- Node.js 24
- npm
- Git
- 可访问 RSS 地址和所选模型服务的网络环境

### 安装

```bash
git clone https://github.com/Yunshiro/yunn-workbench.git
cd yunn-workbench
npm run install:all
```

### 开发模式

分别启动服务端和前端：

```bash
npm run dev:server
```

```bash
npm run dev:web
```

浏览器访问 <http://127.0.0.1:5173>。Vite 会把 `/api` 请求代理到默认的 `3001` 端口。

### 单进程运行

先构建前端，再由 Express 同时提供 API 和静态页面：

```bash
npm run build:web
npm start
```

浏览器访问 <http://127.0.0.1:3001>。

## 开发桌面版

安装全部依赖：

```bash
npm run install:all
npm run install:desktop
```

启动 Electron：

```bash
npm run desktop
```

生成当前操作系统的安装包：

```bash
npm run make:desktop
```

- macOS 会生成 DMG 和 ZIP。
- Windows 会生成 Squirrel 安装程序。
- Pi Agent 包含平台相关模块，因此 macOS 和 Windows 安装包需要在对应系统上构建。

仓库中的 GitHub Actions 可在 macOS 和 Windows Runner 上生成未签名安装包，也可通过推送 `v*` 标签自动触发构建。

## 配置 AI 模型

推荐在应用的 **Agent 设置 → 模型配置** 中添加和切换模型。当前内置支持：

- Anthropic
- OpenAI
- Google Gemini
- DeepSeek
- OpenRouter
- xAI
- Groq
- Mistral
- Z.AI
- Kimi For Coding
- 自定义 OpenAI 兼容接口

也可以通过环境变量提供 API Key：

| 服务 | 环境变量 |
| --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| xAI | `XAI_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| Z.AI | `ZAI_API_KEY` |
| Kimi For Coding | `KIMI_API_KEY` |

通过界面保存的密钥只写入本机模型配置文件，并使用受限文件权限保存。执行 AI 任务时，所选内容会发送给当前启用的模型服务，请根据自己的隐私要求选择供应商。

## 数据与环境变量

Web 版默认将数据保存在：

```text
~/.workbench/
```

桌面版使用 Electron 的用户数据目录：

```text
macOS:   ~/Library/Application Support/Yunn Workbench/data/
Windows: %APPDATA%\Yunn Workbench\data\
```

首次启动时会自动创建 SQLite 数据库和所需数据表。备份时建议先退出应用，然后复制整个数据目录。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `WORKBENCH_HOME` | `~/.workbench` | 数据库、模型配置和研究会话目录 |
| `WORKBENCH_PORT` | `3001` | API 与生产页面端口 |
| `WORKBENCH_HOST` | `127.0.0.1` | 服务监听地址 |
| `WORKBENCH_WEB_DIST` | `web/dist` | 前端构建产物目录 |
| `WORKBENCH_THINKING` | `medium` | Agent 推理级别 |

服务默认只监听本机回环地址。项目当前没有面向公网部署设计的用户认证层，请勿直接把 API 暴露到公网。

## 项目结构

```text
yunn-workbench/
├── server/                  # Express API、SQLite、RSS 与 Pi Agent
│   └── src/
├── web/                     # React + Vite 前端
│   └── src/
│       ├── components/
│       ├── lib/
│       ├── styles/
│       └── views/
├── desktop/                 # Electron 主进程与打包配置
│   ├── assets/
│   ├── scripts/
│   └── src/
└── .github/workflows/       # macOS / Windows 自动构建
```

数据流大致如下：

```text
React UI ── API / SSE ──> Express ──> SQLite
                              ├─────> RSS feeds
                              └─────> Pi Agent / model provider
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run install:all` | 安装 Web 和 Server 依赖 |
| `npm run install:desktop` | 安装 Electron 依赖 |
| `npm run dev:server` | 启动服务端开发模式 |
| `npm run dev:web` | 启动前端开发模式 |
| `npm run build:web` | 类型检查并构建前端 |
| `npm start` | 启动服务端及已构建的 Web 页面 |
| `npm run desktop` | 启动桌面开发版 |
| `npm run package:desktop` | 生成未安装的桌面应用包 |
| `npm run make:desktop` | 生成桌面安装程序 |

## 参与贡献

欢迎提交 Issue 和 Pull Request。提交前请至少运行：

```bash
npm run build:web
cd server && npm exec -- tsc --noEmit
cd ../desktop && npm exec -- tsc -p tsconfig.json --noEmit
```

提交信息建议使用 Conventional Commits，例如：

```text
feat: add feed filtering
fix: prevent duplicate RSS items
```

## 当前状态

项目处于 Beta 阶段，功能和本地数据结构仍可能调整。升级前建议备份数据目录，并在 Release 页面查看版本说明。

## 许可证

仓库目前尚未添加开源许可证文件，相关使用与分发授权以未来加入的 `LICENSE` 文件为准。
