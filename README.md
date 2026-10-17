<p align="center">
  <img src="./web/public/icon.svg" width="104" height="104" alt="Yunn Workbench 图标" />
</p>

<h1 align="center">Yunn Workbench</h1>

<p align="center">
  本地优先的 AI 内容工作台：聚合 RSS 信息，完成阅读筛选、内容分析、选题研究与草稿创作，把链接整理成画板，并对着卡片提问。
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
- **画板**：粘贴 X、网页或 YouTube 链接，自动生成可拖动的卡片和纯文本便签。旁边的对话复用当前模型，并标出引用了哪几张卡片。
- **读书**：导入未加密 epub，先核对拆出的章节，确认后再按章生成笔记和全书报告。
- **本地数据存储**：SQLite、模型配置、提示词、研究会话和画板默认保存在用户本机。
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

## 画板

侧边栏的 **画板** 用来把散落的链接收成一面素材墙，并直接对着这些卡片写稿。

1. 在画板上粘贴链接，或点 **添加链接**。X 帖子（`x.com` / `twitter.com`）会取作者、正文和点赞数；普通网页取标题、摘要和封面；YouTube 取标题、频道和缩略图。
2. 抓取失败时，卡片上可以 **重试**，也可以 **手动粘贴正文**。正文可以再编辑。
3. 双击空白处或点 **新建便签**，写纯文本。便签和链接卡片都能拖动、删除。
4. 右侧对话使用 **Agent 设置** 里已经启用的模型。默认读整面墙；按住 Shift 点选几张卡片后，就只把这几张交给 AI。回答下面列出引用的卡片，点击会在画板上定位。
5. 还没启用模型时，对话会提示去 Agent 设置，而不会直接报错。卡片内容放不进模型上下文时，会请你先选中一部分，不会悄悄截断。

链接由本机服务去抓，页面不会直接请求第三方。画板、卡片位置和对话都写在本机 SQLite 里。设计说明见 [docs/boards.md](docs/boards.md)。

## 读书

侧边栏的 **读书** 用来导入未加密的 epub，按章做笔记，并汇总成一本报告。

导入之后不会立刻调用模型。页面先列出拆好的章节，可以：

1. 改书名、作者，以及「非虚构 / 小说」。类型会决定笔记模板：非虚构写摘要、核心观点和原句；小说写情节、人物、主题与洞见和原句。
2. 如果书里有多层目录，切换用来拆章的那一层（例如「篇」或「章」），或改成 **按正文标题拆**。切换前如果改过章节，会先确认；确认后按新的方式重新划分，并清掉刚才的合并和改名。
3. 把相邻的两章合并，改某一章的标题，或 **跳过这章**。跳过的章节不会生成笔记，也不进入全书报告和进度。目录、版权页和封面会默认跳过，可以恢复。
4. 点 **确认章节并开始**。之后中断或某一章失败，再点 **继续生成** 只会补未完成的章节。还没有任何笔记时，可以返回修改章节。

没有目录、目录是平的、目录对不上正文，或目录只盖住书的一小部分时，会按正文里最上一层标题拆分，例如「第 X 章」或「第 X 回」。标题单独成行也算，哪怕它粘在上一段末尾。节不会被拆成章。这样不会报错，也不会丢掉目录之前的正文。

笔记里的原句会拿章节原文核对，对不上的句子会被丢掉。全书报告包含概述、每章一行大纲、核心观点或人物与主题，以及选出来的原句，不判断值不值得读。

读书使用 **Agent 设置** 里已经启用的模型。DeepSeek 已是内置供应商，可以这样配置：

1. 打开侧边栏 **Agent 设置 → 模型配置 → 内置供应商**。
2. 供应商选 **DeepSeek**，模型用列表里的一项（默认 `deepseek-v4-pro`，也可以选 `deepseek-chat`）。
3. 粘贴自己的 API Key。密钥只写入本机 `~/.workbench/model-profiles.json`（文件权限 `0600`），不要提交到仓库，也不要发到聊天里。
4. 保存后设为 **当前模型**，并做一次连接测试。
5. 也可以在启动前设置环境变量 `DEEPSEEK_API_KEY`。这个值同样只留在本机。

## 数据与环境变量

CLI 和源码运行模式默认将数据保存在：

```text
~/.workbench/
```

首次启动时会自动创建 SQLite 数据库和所需数据表。备份时建议先停止服务，然后复制整个数据目录。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `WORKBENCH_HOME` | `~/.workbench` | 数据库、模型配置、研究会话和画板会话 |
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
                              ├─────> 画板链接抓取（FxTwitter / 网页 / YouTube）
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
| `npm test` | 运行服务端测试（画板、读书与旧数据目录兼容，使用临时数据目录） |
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
