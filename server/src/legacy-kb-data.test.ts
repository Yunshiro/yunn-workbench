import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { db } from "./db.js";
import { app } from "./http.js";

const LEGACY_TABLES = [
  "knowledge_bases",
  "kb_documents",
  "kb_chunks",
  "kb_chunks_fts",
  "kb_sessions",
  "kb_messages",
];

describe("legacy knowledge base data", { concurrency: 1 }, () => {
  let server: Server;

  after(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("starts when the database already contains knowledge base tables and leaves that data unused", async () => {
    const home = process.env.WORKBENCH_HOME || "";
    assert.ok(home && !home.includes("/.workbench"));

    const names = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    for (const table of LEGACY_TABLES) assert.equal(names.has(table), true, table);

    const base = db.prepare("SELECT name, repo_url, chunk_count FROM knowledge_bases WHERE id = ?").get("legacy-kb") as {
      name: string;
      repo_url: string;
      chunk_count: number;
    };
    assert.equal(base.name, "旧笔记");
    assert.equal(base.repo_url, "https://example.com/notes.git");
    assert.equal(base.chunk_count, 2);
    const message = db.prepare("SELECT content FROM kb_messages WHERE id = ?").get("legacy-msg") as { content: string };
    assert.equal(message.content, "旧回答仍在 [1]");
    const chunk = db.prepare("SELECT content FROM kb_chunks_fts WHERE chunk_id = ?").get("legacy-chunk") as { content: string };
    assert.match(chunk.content, /旧片段/);

    const tokenPath = join(home, "kb-credentials", "legacy-kb.token");
    const notePath = join(home, "knowledge-bases", "legacy-kb", "notes.md");
    const sessionPath = join(home, "kb-sessions", "legacy.jsonl");
    assert.equal(readFileSync(tokenPath, "utf8"), "ghp_legacy_secret_do_not_log");
    assert.match(readFileSync(notePath, "utf8"), /旧笔记正文/);
    assert.equal(existsSync(sessionPath), true);
    assert.equal(existsSync(join(home, "kb-empty-hooks")), true);
    assert.equal(existsSync(join(home, "kb-chat-cwd")), true);

    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("无法确定测试端口");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    const removed = await fetch(`${baseUrl}/api/knowledge-bases`);
    assert.equal(removed.status, 404);

    const still = db.prepare("SELECT COUNT(*) AS n FROM knowledge_bases").get() as { n: number };
    assert.equal(Number(still.n), 1);
    assert.equal(readFileSync(tokenPath, "utf8"), "ghp_legacy_secret_do_not_log");
    assert.equal(existsSync(notePath), true);
    assert.equal(existsSync(sessionPath), true);
  });
});
