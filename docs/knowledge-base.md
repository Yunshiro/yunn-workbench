# 知识库

知识库是 Yunn Workbench 里独立的只读问答模块。它不接入 RSS、选题或草稿，而是把一个 Git 仓库里的 Markdown 克隆到本机，建立本地索引，再用工作台已经配置好的模型回答问题。

## 需求

1. 提供单独的「知识库」页面。
2. 通过 Git 仓库地址添加知识库。公开仓库直接克隆；私有仓库可以用 GitHub Token（HTTPS）或 SSH 私钥。凭证只保存在本机数据目录，不写入数据库，不返回给前端，也不写进日志。
3. 仓库克隆到数据目录后，索引其中的 `.md` 文件。可以同时保存多个知识库，并用「同步」手动拉取更新、重建索引。
4. 核心交互是对话。服务端先在本地检索相关 Markdown 片段，再调用当前启用的模型回答。会话保存在本机，方式与现有研究会话相同：SQLite 保存消息，Pi 会话文件保存多轮上下文。
5. 每条回答列出引用的源文件。点击后在界面中渲染原始 Markdown，并显示路径。
6. 第一版严格只读。不允许写文件、提交或推送到知识库仓库。

## 非目标

- 不编辑、不提交、不推送仓库，也不运行仓库自带的 Git hooks。
- 不把知识库内容和凭证发送到除当前模型服务以外的外部检索服务。
- 不替代 RSS 信息流、选题或草稿箱。

## 使用流程

1. 在 Agent 设置中启用一个模型。知识库回答复用这套多模型配置，包括 OpenAI 兼容接口。
2. 打开「知识库」，填写仓库地址。私有 HTTPS 仓库粘贴 GitHub Token；SSH 地址粘贴未加密私钥。
3. 等待首次克隆和索引完成。侧栏会显示 Markdown 篇数和短提交号。
4. 在对话里提问。回答下方的「引用来源」可以打开原文。
5. 仓库有更新时，点击「同步」。这只会 `fetch` 到本地镜像并重建索引。

可以拿公开仓库 `https://github.com/Yunshiro/yunn-second-brain` 试用。索引认的是仓库里的 Markdown，以及文件开头的 YAML frontmatter（`title`、`tags`、`aliases` / `alias`、`description`）。

## 设计

```text
知识库页面
  -> /api/knowledge-bases
  -> 本地 Git 镜像（只读）
  -> Markdown 分块
  -> SQLite FTS5 / BM25
  -> 当前模型
  -> 回答 + 引用
  -> 原文 Markdown
```

### 凭证

| 方式 | 适用地址 | 存放位置 |
| --- | --- | --- |
| 无 | HTTPS 公开仓库 | 不保存凭证 |
| GitHub Token | HTTPS | `kb-credentials/<id>.token`，权限 `0600` |
| SSH 私钥 | `git@host:path` 或 `ssh://` | `kb-credentials/<id>.key`，权限 `0600` |

Token 通过 `GIT_ASKPASS` 传给 Git，不放进命令参数，也不写入克隆出来的 `remote.origin.url`。SSH 使用 `IdentitiesOnly`，不会借用用户默认私钥。带密码的私钥会直接拒绝。全局 Git credential helper 会被清空，避免意外使用或写回系统钥匙串。

接口只返回 `authType` 和 `credentialConfigured`。错误信息在保存前会去掉凭证原文。

### 只读同步

允许的 Git 子命令只有 `clone`、`fetch`、`reset`、`clean`、`rev-parse`。

- 克隆使用 `--no-recurse-submodules`。
- `core.hooksPath` 指向数据目录里的空目录，仓库 hooks 不会执行。
- 关闭 `protocol.file` 和 `protocol.ext`，生产路径不接受本地文件协议。
- `remote.origin.pushurl` 固定为 `DISABLED`。
- 同步是 `git fetch`，然后在本地 `reset --hard FETCH_HEAD` 和 `git clean -fd`。没有 `commit`，也没有 `push`。

镜像位于 `knowledge-bases/<id>`。删除知识库时只删除这个目录、对应凭证和数据库记录。

### 索引

索引器递归读取 `.md`，跳过 `.git`、`node_modules` 等目录和符号链接。单个文件超过 512KB，或全部 Markdown 超过 32MB / 5000 个文件时停止并报错，避免把数据目录撑满。

分块规则：

- 解析文件开头的简易 YAML frontmatter。`title`、`tags`、`aliases` 会进入检索文本。
- 按标题层级切开。过长的段落再按约 1400 字拆开，并保留少量重叠。
- 没有 frontmatter 标题时，用一级标题，最后退回文件名。

检索使用 SQLite FTS5 的 `trigram` 分词和 `bm25()`。trigram 不依赖外部分词器，但单个查询词至少要 3 个字符。提问会先按从长到短去掉常见疑问词、语气词和时间填充词（例如「怎么样」「有什么」「靠什么」「以后」「今天」「一下」），避免留下「怎么」「什么」这样的残片，再抽出关键词：3 字及以上仍走 FTS5，2 字关键词用 `LIKE` 匹配同一知识库的标题、章节和正文。命中按不同关键词的数量从高到低排序，再用 bm25 和关键词出现位置打破平局；只命中其中一个词的片段也会保留。没有任何命中时返回空结果。

### 问答和引用

每次提问先取最多 8 个片段，把路径、标题和章节放进提示词。模型只能依据这些摘录回答，并使用 `[1]` 这样的编号。若回答里出现编号，引用来源只保留被引用的文件；若模型没有标编号，则列出本次检索到的全部来源，避免出现没有出处的回答。

点击来源读取的是索引时保存的原文，不接受跑出该知识库文档表的路径。原文在页面里渲染，HTML 会按文本处理。

对话记录在 `kb_sessions` 和 `kb_messages`。同一会话还会保存一份 Pi 会话，用于多轮上下文。Pi 会话的工作目录不是仓库目录，并且关闭了全部工具，因此回答过程也不能改仓库。

回答通过 SSE 的 `kb_message` 和 `kb_message_delta` 推到页面。同步状态使用 `kb_status`。

### 数据表

`knowledge_bases`、`kb_documents`、`kb_chunks`、`kb_chunks_fts`、`kb_sessions`、`kb_messages`。

这些表在启动时用 `CREATE TABLE IF NOT EXISTS` 补齐，旧的 `~/.workbench/workbench.db` 不需要手工迁移。知识库记录不会随 RSS 保留策略删除。

## API

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/knowledge-bases` | 列出知识库 |
| `POST` | `/api/knowledge-bases` | 添加并开始首次同步 |
| `PATCH` | `/api/knowledge-bases/:id` | 修改名称、分支或凭证 |
| `DELETE` | `/api/knowledge-bases/:id` | 删除本地镜像和索引 |
| `POST` | `/api/knowledge-bases/:id/sync` | 手动同步 |
| `GET` | `/api/knowledge-bases/:id/document?path=` | 读取一篇原文 |
| `GET/POST` | `/api/knowledge-bases/:id/sessions` | 列出会话或新建会话 |
| `GET/POST` | `/api/knowledge-bases/:id/sessions/:sessionId/messages` | 读取或发送问题 |

错误仍然是 `{ "error": "..." }`。
