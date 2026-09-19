<p align="center">
  <img src="./web/public/icon.svg" width="104" height="104" alt="Yunn Workbench 图标" />
</p>

<h1 align="center">Yunn Workbench</h1>

<p align="center">
  本地优先的 AI 内容工作台：聚合 RSS 信息，完成阅读筛选、内容分析、选题研究与草稿创作。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/yunn-workbench">
    <img src="https://img.shields.io/npm/v/yunn-workbench?label=npm" alt="npm version" />
  </a>
  <img src="https://img.shields.io/badge/node-%3E%3D24-339933" alt="Node.js >= 24" />
</p>

## 关于项目

Yunn Workbench 希望把内容创作者日常使用的多种工具收进同一个工作台：从订阅信息源开始，经过阅读、收藏和 AI 分析，形成选题，再沉淀为可继续编辑的草稿。

项目以 npm CLI 的形式发布。运行 `yworkbench` 后会在本机启动 Express 服务并自动打开浏览器，React 界面、API 和 SQLite 数据均在本机运行，不依赖远程 Yunn Workbench 服务。

## 核心功能

- **RSS 信息流**：管理订阅源，定时抓取内容，支持分页、已读和收藏状态。
- **AI 内容处理**：对单篇或多篇内容执行摘要、评估、聚类和选题发现。
- **研究工作台**：围绕选题与 Agent 多轮协作，可选择编辑、增长或研究视角。
- **创作者画像**：保存受众、内容领域、表达风格和长期偏好，为任务提供稳定上下文。
- **多模型配置**：支持多个模型配置快速切换，也支持 OpenAI 兼容接口。
- **提示词管理**：在界面中调整任务指令，无需直接修改服务端代码。
- **选题与草稿**：保存候选选题，关联素材，并继续完成草稿写作。
- **本地数据存储**：SQLite、模型配置、提示词和研究会话默认保存在用户本机。
- **跨平台 CLI**：通过同一个 npm 包在 macOS、Windows 和 Linux 上启动完整工作台。

## 安装与运行

### 环境要求

- Node.js 24 或更高版本
- npm
- 一个现代浏览器

### 全局安装

```bash
npm install -g yunn-workbench@beta
```

安装完成后运行：

```bash
yworkbench
```

命令会自动选择一个空闲的本地端口并打开默认浏览器。终端需要保持运行；按 `Ctrl+C` 可以停止服务。

不想全局安装时，也可以直接运行：

```bash
npx yunn-workbench@beta
```

### 命令选项

```bash
yworkbench --port 3001
yworkbench --data-dir ./workbench-data
yworkbench --no-open
yworkbench --version
yworkbench --help
```

| 选项 | 用途 |
| --- | --- |
| `--port <端口>` | 指定本地端口，默认自动选择空闲端口 |
| `--data-dir <目录>` | 指定数据库、模型配置和会话目录 |
| `--no-open` | 启动后不自动打开浏览器 |
| `-v, --version` | 显示当前版本 |
| `-h, --help` | 显示命令帮助 |

### 更新与卸载

```bash
npm install -g yunn-workbench@beta
npm uninstall -g yunn-workbench
```

卸载 npm 包不会删除 `~/.workbench` 中的本地数据。

### 首次启动

1. 打开侧边栏的 **Agent 设置**。
2. 新建模型配置，选择服务商和模型，并填写自己的 API Key。
3. 保存并启用配置，通过连接测试后即可使用 AI 任务。
4. 前往 **订阅源** 添加 RSS 地址，开始构建自己的信息流。

应用数据和 API Key 默认只保存在本机。具体目录和备份方式参见下方的“数据与环境变量”。

## 从源码运行

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

### 构建并运行完整工作台

构建前端和服务端，再通过 CLI 启动：

```bash
npm run build
npm start
```

CLI 会输出实际访问地址并自动打开浏览器。

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

CLI 和源码运行模式默认将数据保存在：

```text
~/.workbench/
```

首次启动时会自动创建 SQLite 数据库和所需数据表。备份时建议先停止服务，然后复制整个数据目录。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `WORKBENCH_HOME` | `~/.workbench` | 数据库、模型配置和研究会话目录 |
| `WORKBENCH_PORT` | CLI 自动选择；源码服务为 `3001` | API 与生产页面端口 |
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
└── cli/                     # yworkbench 命令入口
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
| `npm run install:all` | 安装根包、Web 和 Server 依赖 |
| `npm run dev:server` | 启动服务端开发模式 |
| `npm run dev:web` | 启动前端开发模式 |
| `npm run build:web` | 类型检查并构建前端 |
| `npm run build:server` | 构建服务端 |
| `npm run build` | 构建可发布的完整工作台 |
| `npm start` | 通过 CLI 启动已构建的工作台 |
| `npm pack` | 构建并生成 npm 发布包 |
| `npm run publish:beta` | 以 `beta` dist-tag 发布到 npm |

## 参与贡献

欢迎提交 Issue 和 Pull Request。提交前请至少运行：

```bash
npm run build
cd server && npm exec -- tsc --noEmit
cd .. && node cli/yworkbench.js --help
```

提交信息建议使用 Conventional Commits，例如：

```text
feat: add feed filtering
fix: prevent duplicate RSS items
```

## 当前状态

项目处于 Beta 阶段，功能和本地数据结构仍可能调整。升级 npm 包前建议备份数据目录，并查看版本说明。

## 许可证

仓库目前尚未添加开源许可证文件，相关使用与分发授权以未来加入的 `LICENSE` 文件为准。
