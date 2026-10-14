import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(tmpdir(), "workbench-test-"));
seedLegacyKnowledgeBase(home);

const child = spawn(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", "src/legacy-kb-data.test.ts", "src/boards.test.ts"], {
  cwd: dirname(fileURLToPath(import.meta.url)),
  env: { ...process.env, WORKBENCH_HOME: home },
  stdio: "inherit",
});

child.on("exit", (code) => {
  rmSync(home, { recursive: true, force: true });
  process.exit(code ?? 1);
});

/** 模拟升级前已经存在的知识库数据。应用启动后应原样保留，而不是删表或删文件。 */
function seedLegacyKnowledgeBase(root) {
  mkdirSync(join(root, "knowledge-bases", "legacy-kb"), { recursive: true });
  mkdirSync(join(root, "kb-credentials"), { recursive: true });
  mkdirSync(join(root, "kb-sessions"), { recursive: true });
  mkdirSync(join(root, "kb-empty-hooks"), { recursive: true });
  mkdirSync(join(root, "kb-chat-cwd"), { recursive: true });
  writeFileSync(join(root, "knowledge-bases", "legacy-kb", "notes.md"), "# 旧笔记正文\n\n不要删除。\n");
  writeFileSync(join(root, "kb-credentials", "legacy-kb.token"), "ghp_legacy_secret_do_not_log", { mode: 0o600 });
  writeFileSync(join(root, "kb-sessions", "legacy.jsonl"), "{\"type\":\"session\"}\n");
  writeFileSync(join(root, "kb-chat-cwd", ".keep"), "");

  const database = new DatabaseSync(join(root, "workbench.db"));
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE knowledge_bases (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      repo_url        TEXT NOT NULL UNIQUE,
      auth_type       TEXT NOT NULL,
      branch          TEXT,
      local_path      TEXT NOT NULL,
      status          TEXT NOT NULL,
      last_synced_at  INTEGER,
      last_error      TEXT,
      commit_sha      TEXT,
      file_count      INTEGER NOT NULL DEFAULT 0,
      chunk_count     INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE TABLE kb_documents (
      id            TEXT PRIMARY KEY,
      kb_id         TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      path          TEXT NOT NULL,
      title         TEXT NOT NULL,
      content       TEXT NOT NULL,
      content_hash  TEXT NOT NULL,
      frontmatter   TEXT,
      updated_at    INTEGER NOT NULL,
      UNIQUE (kb_id, path)
    );
    CREATE TABLE kb_chunks (
      id            TEXT PRIMARY KEY,
      kb_id         TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      document_id   TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
      path          TEXT NOT NULL,
      title         TEXT NOT NULL,
      heading       TEXT,
      chunk_index   INTEGER NOT NULL,
      content       TEXT NOT NULL,
      start_line    INTEGER NOT NULL,
      end_line      INTEGER NOT NULL
    );
    CREATE TABLE kb_sessions (
      id              TEXT PRIMARY KEY,
      kb_id           TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      title           TEXT NOT NULL,
      pi_session_id   TEXT,
      pi_session_path TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE TABLE kb_messages (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL REFERENCES kb_sessions(id) ON DELETE CASCADE,
      role          TEXT NOT NULL,
      content       TEXT NOT NULL,
      citations     TEXT,
      status        TEXT NOT NULL,
      error         TEXT,
      created_at    INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE kb_chunks_fts USING fts5(
      chunk_id UNINDEXED,
      kb_id UNINDEXED,
      path,
      title,
      heading,
      content,
      tokenize = 'trigram'
    );
    INSERT INTO knowledge_bases (
      id, name, repo_url, auth_type, branch, local_path, status, commit_sha, file_count, chunk_count, created_at, updated_at
    ) VALUES (
      'legacy-kb', '旧笔记', 'https://example.com/notes.git', 'github_token', 'main', 'knowledge-bases/legacy-kb', 'ready', 'abc123', 1, 2, 1700000000000, 1700000000000
    );
    INSERT INTO kb_documents (
      id, kb_id, path, title, content, content_hash, frontmatter, updated_at
    ) VALUES (
      'legacy-doc', 'legacy-kb', 'notes.md', '旧笔记', '旧笔记正文', 'hash', '{"title":"旧笔记"}', 1700000000000
    );
    INSERT INTO kb_chunks (
      id, kb_id, document_id, path, title, heading, chunk_index, content, start_line, end_line
    ) VALUES (
      'legacy-chunk', 'legacy-kb', 'legacy-doc', 'notes.md', '旧笔记', '正文', 0, '旧片段仍在', 1, 2
    );
    INSERT INTO kb_sessions (
      id, kb_id, title, pi_session_id, pi_session_path, created_at, updated_at
    ) VALUES (
      'legacy-session', 'legacy-kb', '旧对话', 'legacy-session', 'kb-sessions/legacy.jsonl', 1700000000000, 1700000000000
    );
    INSERT INTO kb_messages (
      id, session_id, role, content, citations, status, error, created_at
    ) VALUES (
      'legacy-msg', 'legacy-session', 'assistant', '旧回答仍在 [1]', '[]', 'done', NULL, 1700000000000
    );
    INSERT INTO kb_chunks_fts (chunk_id, kb_id, path, title, heading, content)
    VALUES ('legacy-chunk', 'legacy-kb', 'notes.md', '旧笔记', '正文', '旧片段仍在');
  `);
  database.close();
}
