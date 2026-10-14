import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { app } from "./http.js";
import {
  getKnowledgeBase,
  insertKnowledgeBase,
  replaceKnowledgeIndex,
  searchKnowledgeChunks,
} from "./knowledge-db.js";
import {
  assertAuthMatches,
  assertGithubToken,
  assertPrivateKeyMaterial,
  assertReadOnlyGitArgs,
  buildCloneArgs,
  buildSyncArgs,
  cloneRepository,
  githubTokenPath,
  gitSubcommand,
  normalizeBranch,
  parseRepoUrl,
  redactSecrets,
  syncRepository,
  writeGithubToken,
} from "./knowledge-git.js";
import {
  buildFtsQuery,
  chunkMarkdown,
  extractKnowledgeTerms,
  readMarkdownTree,
  searchableText,
  selectCitations,
} from "./knowledge-index.js";
import { KnowledgeError } from "./knowledge-error.js";

const SECRET = "ghp_super_secret_token_value";
const FIXTURE = `---
title: 选题方法
tags: [写作, 选题]
aliases:
  - 找题目
---

# 选题方法

从日常笔记里找重复出现的问题。

## 证据

每条选题至少要有三条本地笔记支撑。
`;

const SPOKEN = `---
title: 口播入门
tags: [表达]
aliases:
  - 开口播
---

# 口播入门

做口播时，前三秒先给听众一个留下来的理由。口播不是把稿子念完。
`;

const SPOKEN_EXTRA = `---
title: 镜头前的表达
---

# 镜头前的表达

把一句口播收成听众能复述的话，比堆形容词有用。
`;

const RESIGN = `---
title: 辞职清单
tags: [职业]
---

# 辞职清单

离职前把交接写成清单。辞职不是把情绪发出去，是把责任交出去。
`;

const TOPIC_NOTE = `---
title: 内容选题
tags: [选题]
aliases:
  - 找选题
---

# 内容选题

从重复出现的问题里确定一个读者已经在问的题目。
`;

const WORKFLOW = `---
title: Editorial workflow
tags: [workflow]
---

# Editorial workflow

Keep a local markdown note before you publish.
Use the keyword lighthouse when the draft is ready.
口播 workflow 要短，方便和中文笔记对照。
`;

function indexMarkdown(path: string, markdown: string) {
  const chunked = chunkMarkdown(path, markdown);
  return {
    path,
    title: chunked.title,
    content: markdown,
    contentHash: path,
    frontmatter: { title: chunked.title, tags: chunked.tags, aliases: chunked.aliases },
    chunks: chunked.chunks.map((chunk) => ({
      ...chunk,
      searchText: searchableText({
        title: chunked.title,
        tags: chunked.tags,
        aliases: chunked.aliases,
        description: chunked.description,
        heading: chunk.heading,
        content: chunk.content,
      }),
    })),
  };
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "KB Test",
      GIT_AUTHOR_EMAIL: "kb@example.com",
      GIT_COMMITTER_NAME: "KB Test",
      GIT_COMMITTER_EMAIL: "kb@example.com",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

describe("knowledge base", { concurrency: 1 }, () => {
  let server: Server;
  let baseUrl = "";

  before(async () => {
    assert.ok(process.env.WORKBENCH_HOME && !process.env.WORKBENCH_HOME.includes("/.workbench"));
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("无法确定测试端口");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("parses https and ssh repository urls", () => {
    const https = parseRepoUrl("https://github.com/Yunshiro/yunn-second-brain");
    assert.equal(https.protocol, "https");
    assert.equal(https.name, "yunn-second-brain");
    const ssh = parseRepoUrl("git@github.com:Yunshiro/yunn-second-brain.git");
    assert.equal(ssh.protocol, "ssh");
    assert.equal(ssh.name, "yunn-second-brain");
    assert.equal(parseRepoUrl("ssh://git@github.com/Yunshiro/yunn-second-brain.git").protocol, "ssh");
    assert.throws(() => parseRepoUrl("file:///tmp/notes"), KnowledgeError);
    assert.throws(() => parseRepoUrl("/tmp/notes"), KnowledgeError);
    assert.throws(() => parseRepoUrl("https://user:token@github.com/Yunshiro/notes.git"), KnowledgeError);
    assert.throws(() => assertAuthMatches("ssh", "none"), KnowledgeError);
    assert.throws(() => assertAuthMatches("https", "ssh_key"), KnowledgeError);
    assert.equal(normalizeBranch("feature/notes"), "feature/notes");
    assert.throws(() => normalizeBranch("../main"), KnowledgeError);
    assert.throws(() => assertGithubToken("short"), KnowledgeError);
    assert.throws(() => assertPrivateKeyMaterial(`-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n${"A".repeat(80)}`), KnowledgeError);
  });

  it("keeps git commands read-only and out of the token", () => {
    const args = buildCloneArgs("https://github.com/Yunshiro/yunn-second-brain.git", "/tmp/kb-dest", null, "/tmp/kb-hooks", false);
    assert.equal(gitSubcommand(args), "clone");
    assert.equal(args.includes("push"), false);
    assert.equal(args.includes("commit"), false);
    assert.ok(args.includes("remote.origin.pushurl=DISABLED"));
    assert.ok(args.includes("protocol.file.allow=never"));
    assert.equal(args.join(" ").includes(SECRET), false);
    const local = buildCloneArgs("/tmp/source", "/tmp/dest", null, "/tmp/kb-hooks", true);
    assert.equal(local.includes("protocol.file.allow=never"), false);
    for (const group of buildSyncArgs("main", "/tmp/kb-hooks", false)) assertReadOnlyGitArgs(group);
    assert.throws(() => assertReadOnlyGitArgs(["push", "origin", "main"]), KnowledgeError);
    assert.throws(() => assertReadOnlyGitArgs(["commit", "-m", "x"]), KnowledgeError);
    assert.equal(redactSecrets(`failed ${SECRET}`, [SECRET]).includes(SECRET), false);
  });

  it("chunks markdown with frontmatter and citations", () => {
    const chunked = chunkMarkdown("notes/topic.md", FIXTURE);
    assert.equal(chunked.title, "选题方法");
    assert.deepEqual(chunked.tags, ["写作", "选题"]);
    assert.deepEqual(chunked.aliases, ["找题目"]);
    const evidence = chunked.chunks.find((chunk) => chunk.heading.includes("证据"));
    assert.ok(evidence);
    assert.match(evidence.content, /三条本地笔记/);
    assert.equal(chunked.chunks.some((chunk) => chunk.content.includes("title:")), false);
    const query = buildFtsQuery("选题需要几条本地笔记支撑？");
    assert.match(query || "", /本地笔记/);
    assert.deepEqual(selectCitations("依据 [2] 与 [12]。", [{ index: 1 }, { index: 2 }, { index: 12 }]).map((item) => item.index), [2, 12]);
    assert.equal(selectCitations("没有编号", [{ index: 1 }, { index: 2 }]).length, 2);
  });

  it("searches indexed markdown with fts and does not leak secrets", async () => {
    const first = insertKnowledgeBase({ name: "笔记", repoUrl: "https://example.com/notes.git", authType: "github_token", branch: "main" });
    const second = insertKnowledgeBase({ name: "其他", repoUrl: "https://example.com/other.git", authType: "none", branch: "main" });
    const chunked = chunkMarkdown("notes/topic.md", FIXTURE);
    replaceKnowledgeIndex(first.id, [{
      path: "notes/topic.md",
      title: chunked.title,
      content: FIXTURE,
      contentHash: "abc",
      frontmatter: { title: chunked.title, tags: chunked.tags, aliases: chunked.aliases },
      chunks: chunked.chunks.map((chunk) => ({
        ...chunk,
        searchText: searchableText({
          title: chunked.title,
          tags: chunked.tags,
          aliases: chunked.aliases,
          heading: chunk.heading,
          content: chunk.content,
        }),
      })),
    }]);
    replaceKnowledgeIndex(second.id, [{
      path: "db.md",
      title: "数据库",
      content: "数据库迁移手册",
      contentHash: "def",
      frontmatter: {},
      chunks: [{ heading: "数据库", content: "数据库迁移手册", searchText: "数据库迁移手册", startLine: 1, endLine: 1 }],
    }]);

    const hits = searchKnowledgeChunks(first.id, "选题需要几条本地笔记支撑？");
    assert.ok(hits.some((hit) => hit.content.includes("三条本地笔记")));
    assert.equal(hits.some((hit) => hit.path === "db.md"), false);
    assert.ok(searchKnowledgeChunks(first.id, "找题目").some((hit) => hit.path === "notes/topic.md"));
    assert.ok(searchKnowledgeChunks(first.id, "笔记").some((hit) => hit.content.includes("笔记")));
    assert.equal(searchKnowledgeChunks(second.id, "三条本地笔记").length, 0);

    writeGithubToken(first.id, SECRET);
    const mode = statSync(githubTokenPath(first.id)).mode & 0o777;
    assert.equal(mode, 0o600);
    const listed = await fetch(`${baseUrl}/api/knowledge-bases`).then((res) => res.text());
    assert.equal(listed.includes(SECRET), false);
    assert.match(listed, /"credentialConfigured":true/);
    const pub = getKnowledgeBase(first.id);
    assert.equal(JSON.stringify(pub).includes(SECRET), false);
    assert.equal(Object.hasOwn(pub || {}, "localPath"), false);

    const rejected = await fetch(`${baseUrl}/api/knowledge-bases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "file:///tmp/private-notes", authType: "github_token", token: SECRET }),
    });
    const body = await rejected.text();
    assert.equal(rejected.status, 400);
    assert.equal(body.includes(SECRET), false);
  });

  it("retrieves chinese keywords after stripping question words", () => {
    const kb = insertKnowledgeBase({
      name: "第二大脑",
      repoUrl: "https://example.com/yunn-second-brain.git",
      authType: "none",
      branch: "main",
    });
    replaceKnowledgeIndex(kb.id, [
      indexMarkdown("notes/koubo.md", SPOKEN),
      indexMarkdown("notes/koubo-extra.md", SPOKEN_EXTRA),
      indexMarkdown("notes/resign.md", RESIGN),
      indexMarkdown("notes/topic.md", TOPIC_NOTE),
      indexMarkdown("notes/workflow.md", WORKFLOW),
    ]);

    const spokenTerms = extractKnowledgeTerms("怎么做好口播？");
    assert.equal(spokenTerms.ftsTerms.includes("怎么做好口播"), false);
    assert.equal(spokenTerms.ftsTerms.includes("怎么做好"), false);
    assert.equal(spokenTerms.ftsTerms.includes("做好口播"), false);
    assert.ok(spokenTerms.likeTerms.includes("口播"));
    assert.equal(buildFtsQuery("怎么做好口播？"), null);
    assert.equal(extractKnowledgeTerms("如何辞职").likeTerms.includes("如何"), false);
    assert.ok(extractKnowledgeTerms("如何辞职").likeTerms.includes("辞职"));
    assert.ok(extractKnowledgeTerms("什么是内容选题").ftsTerms.includes("内容选题"));
    assert.equal(extractKnowledgeTerms("什么是内容选题").ftsTerms.some((term) => term.includes("什么")), false);
    assert.ok(extractKnowledgeTerms("lighthouse workflow").ftsTerms.includes("lighthouse"));
    assert.ok(extractKnowledgeTerms("口播workflow").likeTerms.includes("口播"));
    assert.ok(extractKnowledgeTerms("口播workflow").ftsTerms.includes("workflow"));

    const spoken = searchKnowledgeChunks(kb.id, "怎么做好口播？");
    assert.ok(spoken.some((hit) => hit.path === "notes/koubo.md" && hit.content.includes("口播")));
    assert.equal(spoken.some((hit) => hit.path === "notes/resign.md"), false);
    assert.ok(searchKnowledgeChunks(kb.id, "口播").some((hit) => hit.path === "notes/koubo.md"));
    assert.ok(searchKnowledgeChunks(kb.id, "口播").some((hit) => hit.path === "notes/koubo-extra.md"));
    assert.equal(searchKnowledgeChunks(kb.id, "口播", 1).length, 1);
    assert.ok(searchKnowledgeChunks(kb.id, "辞职").some((hit) => hit.path === "notes/resign.md" && hit.content.includes("辞职")));
    assert.ok(searchKnowledgeChunks(kb.id, "如何辞职").some((hit) => hit.path === "notes/resign.md"));
    assert.ok(searchKnowledgeChunks(kb.id, "怎样做好口播？").some((hit) => hit.content.includes("口播")));
    assert.ok(searchKnowledgeChunks(kb.id, "什么是内容选题").some((hit) => hit.path === "notes/topic.md"));
    assert.ok(searchKnowledgeChunks(kb.id, "什么是辞职").some((hit) => hit.path === "notes/resign.md"));
    assert.equal(searchKnowledgeChunks(kb.id, "什么是辞职").some((hit) => hit.path === "notes/koubo.md"), false);
    assert.ok(searchKnowledgeChunks(kb.id, "内容选题").some((hit) => hit.path === "notes/topic.md"));
    assert.ok(searchKnowledgeChunks(kb.id, "lighthouse").some((hit) => hit.path === "notes/workflow.md"));
    assert.ok(searchKnowledgeChunks(kb.id, "markdown").some((hit) => hit.content.toLowerCase().includes("markdown")));
    const mixed = searchKnowledgeChunks(kb.id, "口播 workflow");
    assert.equal(mixed[0]?.path, "notes/workflow.md");
    assert.ok(searchKnowledgeChunks(kb.id, "口播workflow").some((hit) => hit.path === "notes/workflow.md"));
    assert.equal(searchKnowledgeChunks(kb.id, "量子纠缠").length, 0);
    assert.equal(searchKnowledgeChunks(kb.id, "xyzzyplugh").length, 0);
  });

  it("clones and syncs a local fixture without pushing", async () => {
    const root = mkdtempSync(join(tmpdir(), "kb-git-"));
    const source = join(root, "source");
    const dest = join(root, "dest");
    try {
      git(root, ["init", "-b", "main", source]);
      writeFileSync(join(source, "topic.md"), FIXTURE);
      git(source, ["add", "topic.md"]);
      git(source, ["-c", "user.name=KB Test", "-c", "user.email=kb@example.com", "commit", "-m", "init"]);
      const before = git(source, ["rev-parse", "HEAD"]);
      const kb = insertKnowledgeBase({ name: "本地", repoUrl: "https://example.com/local-notes.git", authType: "github_token", branch: null });
      writeGithubToken(kb.id, SECRET);
      const cloned = await cloneRepository({
        kbId: kb.id,
        fetchUrl: source,
        branch: null,
        authType: "github_token",
        dest,
        allowFileProtocol: true,
      });
      assert.equal(cloned.commitSha, before);
      assert.equal(git(dest, ["remote", "get-url", "--push", "origin"]), "DISABLED");
      assert.equal(readFileSync(join(dest, ".git", "config"), "utf8").includes(SECRET), false);
      const indexed = readMarkdownTree(dest);
      assert.equal(indexed.length, 1);

      writeFileSync(join(source, "topic.md"), `${FIXTURE}\n补充：发布前再核对来源。\n`);
      git(source, ["add", "topic.md"]);
      git(source, ["-c", "user.name=KB Test", "-c", "user.email=kb@example.com", "commit", "-m", "update"]);
      const afterSha = git(source, ["rev-parse", "HEAD"]);
      const synced = await syncRepository({
        kbId: kb.id,
        repoDir: dest,
        branch: cloned.branch,
        authType: "github_token",
        allowFileProtocol: true,
      });
      assert.equal(git(source, ["rev-parse", "HEAD"]), afterSha);
      assert.equal(synced.commitSha, afterSha);
      assert.match(readFileSync(join(dest, "topic.md"), "utf8"), /发布前再核对来源/);
      assert.equal(git(dest, ["status", "--porcelain"]), "");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
