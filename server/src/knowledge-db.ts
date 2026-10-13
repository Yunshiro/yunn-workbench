import { createHash, randomUUID } from "node:crypto";
import { db } from "./db.js";
import { credentialConfigured, type KbAuthType } from "./knowledge-git.js";
import { buildFtsQuery, likeNeedle } from "./knowledge-index.js";

export type KbStatus = "pending" | "syncing" | "ready" | "error";

export interface KnowledgeBase {
  id: string;
  name: string;
  repoUrl: string;
  authType: KbAuthType;
  credentialConfigured: boolean;
  branch: string | null;
  status: KbStatus;
  lastSyncedAt: number | null;
  lastError: string | null;
  commitSha: string | null;
  fileCount: number;
  chunkCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeBaseRecord extends KnowledgeBase {
  localPath: string;
}

export interface KbDocument {
  id: string;
  kbId: string;
  path: string;
  title: string;
  content: string;
  frontmatter: Record<string, string | string[]> | null;
  updatedAt: number;
}

export interface KbSearchHit {
  chunkId: string;
  documentId: string;
  path: string;
  title: string;
  heading: string | null;
  content: string;
  startLine: number;
  endLine: number;
  score: number;
}

export interface KbCitation {
  index: number;
  path: string;
  title: string;
  heading: string | null;
  excerpt: string;
  documentId: string;
}

export interface KbSession {
  id: string;
  kbId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface KbSessionRecord extends KbSession {
  piSessionId: string | null;
  piSessionPath: string | null;
}

export interface KbMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  citations: KbCitation[];
  status: "running" | "done" | "error";
  error: string | null;
  createdAt: number;
}

export interface IndexedChunk {
  heading: string;
  content: string;
  searchText: string;
  startLine: number;
  endLine: number;
}

export interface IndexedDocument {
  path: string;
  title: string;
  content: string;
  contentHash: string;
  frontmatter: Record<string, string | string[]>;
  chunks: IndexedChunk[];
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; }
  catch { return fallback; }
}

function rowToKnowledgeBase(row: any): KnowledgeBaseRecord {
  const authType = row.auth_type as KbAuthType;
  return {
    id: row.id,
    name: row.name,
    repoUrl: row.repo_url,
    authType,
    credentialConfigured: credentialConfigured(row.id, authType),
    branch: row.branch,
    localPath: row.local_path,
    status: row.status,
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
    commitSha: row.commit_sha,
    fileCount: row.file_count,
    chunkCount: row.chunk_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toPublicKnowledgeBase(record: KnowledgeBaseRecord): KnowledgeBase {
  const { localPath: _localPath, ...pub } = record;
  return pub;
}

export function listKnowledgeBases(): KnowledgeBase[] {
  return (db.prepare("SELECT * FROM knowledge_bases ORDER BY created_at DESC").all() as any[]).map((row) => toPublicKnowledgeBase(rowToKnowledgeBase(row)));
}

export function getKnowledgeBase(id: string): KnowledgeBase | undefined {
  const record = getKnowledgeBaseRecord(id);
  return record ? toPublicKnowledgeBase(record) : undefined;
}

export function getKnowledgeBaseRecord(id: string): KnowledgeBaseRecord | undefined {
  const row = db.prepare("SELECT * FROM knowledge_bases WHERE id = ?").get(id) as any;
  return row ? rowToKnowledgeBase(row) : undefined;
}

export function listKnowledgeBaseRecords(): KnowledgeBaseRecord[] {
  return (db.prepare("SELECT * FROM knowledge_bases ORDER BY created_at DESC").all() as any[]).map(rowToKnowledgeBase);
}

export function insertKnowledgeBase(input: {
  name: string;
  repoUrl: string;
  authType: KbAuthType;
  branch: string | null;
}): KnowledgeBaseRecord {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`INSERT INTO knowledge_bases (
    id, name, repo_url, auth_type, branch, local_path, status, file_count, chunk_count, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?)`).run(
    id, input.name, input.repoUrl, input.authType, input.branch, `knowledge-bases/${id}`, now, now,
  );
  return getKnowledgeBaseRecord(id)!;
}

export function updateKnowledgeBaseRecord(id: string, patch: Partial<{
  name: string;
  authType: KbAuthType;
  branch: string | null;
  status: KbStatus;
  lastSyncedAt: number | null;
  lastError: string | null;
  commitSha: string | null;
  fileCount: number;
  chunkCount: number;
}>): KnowledgeBaseRecord | undefined {
  const current = getKnowledgeBaseRecord(id);
  if (!current) return undefined;
  db.prepare(`UPDATE knowledge_bases SET
    name = ?, auth_type = ?, branch = ?, status = ?, last_synced_at = ?, last_error = ?,
    commit_sha = ?, file_count = ?, chunk_count = ?, updated_at = ?
    WHERE id = ?`).run(
    patch.name ?? current.name,
    patch.authType ?? current.authType,
    patch.branch === undefined ? current.branch : patch.branch,
    patch.status ?? current.status,
    patch.lastSyncedAt === undefined ? current.lastSyncedAt : patch.lastSyncedAt,
    patch.lastError === undefined ? current.lastError : patch.lastError,
    patch.commitSha === undefined ? current.commitSha : patch.commitSha,
    patch.fileCount ?? current.fileCount,
    patch.chunkCount ?? current.chunkCount,
    Date.now(),
    id,
  );
  return getKnowledgeBaseRecord(id);
}

export function deleteKnowledgeBaseRecord(id: string): void {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM kb_chunks_fts WHERE kb_id = ?").run(id);
    db.prepare("DELETE FROM knowledge_bases WHERE id = ?").run(id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function replaceKnowledgeIndex(kbId: string, docs: IndexedDocument[]): { fileCount: number; chunkCount: number } {
  const insertDoc = db.prepare(`INSERT INTO kb_documents (
    id, kb_id, path, title, content, content_hash, frontmatter, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertChunk = db.prepare(`INSERT INTO kb_chunks (
    id, kb_id, document_id, path, title, heading, chunk_index, content, start_line, end_line
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertFts = db.prepare(`INSERT INTO kb_chunks_fts (
    chunk_id, kb_id, path, title, heading, content
  ) VALUES (?, ?, ?, ?, ?, ?)`);
  const now = Date.now();
  let chunkCount = 0;
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM kb_chunks_fts WHERE kb_id = ?").run(kbId);
    db.prepare("DELETE FROM kb_documents WHERE kb_id = ?").run(kbId);
    for (const doc of docs) {
      const documentId = randomUUID();
      insertDoc.run(documentId, kbId, doc.path, doc.title, doc.content, doc.contentHash, JSON.stringify(doc.frontmatter), now);
      doc.chunks.forEach((chunk, index) => {
        const chunkId = randomUUID();
        insertChunk.run(chunkId, kbId, documentId, doc.path, doc.title, chunk.heading, index, chunk.content, chunk.startLine, chunk.endLine);
        insertFts.run(chunkId, kbId, doc.path, doc.title, chunk.heading, chunk.searchText);
        chunkCount += 1;
      });
    }
    db.prepare("UPDATE knowledge_bases SET file_count = ?, chunk_count = ?, updated_at = ? WHERE id = ?").run(docs.length, chunkCount, now, kbId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { fileCount: docs.length, chunkCount };
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function getKnowledgeDocument(kbId: string, path: string): KbDocument | undefined {
  if (!path || path.includes("..") || path.startsWith("/")) return undefined;
  const row = db.prepare("SELECT * FROM kb_documents WHERE kb_id = ? AND path = ?").get(kbId, path) as any;
  if (!row) return undefined;
  return {
    id: row.id,
    kbId: row.kb_id,
    path: row.path,
    title: row.title,
    content: row.content,
    frontmatter: parseJson(row.frontmatter, null),
    updatedAt: row.updated_at,
  };
}

function mapHit(row: any): KbSearchHit {
  return {
    chunkId: row.id,
    documentId: row.document_id,
    path: row.path,
    title: row.title,
    heading: row.heading,
    content: row.content,
    startLine: row.start_line,
    endLine: row.end_line,
    score: Number(row.score) || 0,
  };
}

export function searchKnowledgeChunks(kbId: string, question: string, limit = 8): KbSearchHit[] {
  const bounded = Math.min(Math.max(limit, 1), 20);
  const ftsQuery = buildFtsQuery(question);
  if (ftsQuery) {
    try {
      const rows = db.prepare(`SELECT c.id, c.document_id, c.path, c.title, c.heading, c.content, c.start_line, c.end_line,
          bm25(kb_chunks_fts, 1.0, 8.0, 3.0, 1.0) AS score
        FROM kb_chunks_fts
        JOIN kb_chunks c ON c.id = kb_chunks_fts.chunk_id
        WHERE kb_chunks_fts MATCH ? AND kb_chunks_fts.kb_id = ?
        ORDER BY score
        LIMIT ?`).all(ftsQuery, kbId, bounded) as any[];
      if (rows.length > 0) return rows.map(mapHit);
    } catch {
      /* 查询语法不被 trigram 接受时，退回子串匹配 */
    }
  }
  const needle = likeNeedle(question);
  if (!needle) return [];
  const pattern = `%${needle.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  const rows = db.prepare(`SELECT id, document_id, path, title, heading, content, start_line, end_line, 0 AS score
    FROM kb_chunks
    WHERE kb_id = ? AND (content LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR IFNULL(heading, '') LIKE ? ESCAPE '\\')
    LIMIT ?`).all(kbId, pattern, pattern, pattern, bounded) as any[];
  return rows.map(mapHit);
}

function rowToSession(row: any): KbSessionRecord {
  return {
    id: row.id,
    kbId: row.kb_id,
    title: row.title,
    piSessionId: row.pi_session_id,
    piSessionPath: row.pi_session_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toPublicSession(record: KbSessionRecord): KbSession {
  const { piSessionId: _piSessionId, piSessionPath: _piSessionPath, ...pub } = record;
  return pub;
}

export function listKnowledgeSessions(kbId: string): KbSession[] {
  return (db.prepare("SELECT * FROM kb_sessions WHERE kb_id = ? ORDER BY updated_at DESC").all(kbId) as any[]).map((row) => toPublicSession(rowToSession(row)));
}

export function getKnowledgeSession(id: string): KbSessionRecord | undefined {
  const row = db.prepare("SELECT * FROM kb_sessions WHERE id = ?").get(id) as any;
  return row ? rowToSession(row) : undefined;
}

export function insertKnowledgeSession(kbId: string, title = "新的对话"): KbSession {
  const id = randomUUID();
  const now = Date.now();
  db.prepare("INSERT INTO kb_sessions (id, kb_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, kbId, title, now, now);
  return toPublicSession(getKnowledgeSession(id)!);
}

export function updateKnowledgeSession(id: string, patch: Partial<Pick<KbSessionRecord, "title" | "piSessionId" | "piSessionPath">>): void {
  const current = getKnowledgeSession(id);
  if (!current) return;
  db.prepare("UPDATE kb_sessions SET title = ?, pi_session_id = ?, pi_session_path = ?, updated_at = ? WHERE id = ?").run(
    patch.title ?? current.title,
    patch.piSessionId === undefined ? current.piSessionId : patch.piSessionId,
    patch.piSessionPath === undefined ? current.piSessionPath : patch.piSessionPath,
    Date.now(),
    id,
  );
}

export function deleteKnowledgeSession(id: string): boolean {
  const result = db.prepare("DELETE FROM kb_sessions WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}

function rowToMessage(row: any): KbMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    citations: parseJson(row.citations, []),
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
  };
}

export function listKnowledgeMessages(sessionId: string): KbMessage[] {
  return (db.prepare("SELECT * FROM kb_messages WHERE session_id = ? ORDER BY created_at ASC").all(sessionId) as any[]).map(rowToMessage);
}

export function getKnowledgeMessage(id: string): KbMessage | undefined {
  const row = db.prepare("SELECT * FROM kb_messages WHERE id = ?").get(id) as any;
  return row ? rowToMessage(row) : undefined;
}

export function insertKnowledgeMessage(input: {
  sessionId: string;
  role: KbMessage["role"];
  content: string;
  citations?: KbCitation[];
  status: KbMessage["status"];
  error?: string | null;
}): KbMessage {
  const id = randomUUID();
  db.prepare(`INSERT INTO kb_messages (id, session_id, role, content, citations, status, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    input.sessionId,
    input.role,
    input.content,
    JSON.stringify(input.citations || []),
    input.status,
    input.error ?? null,
    Date.now(),
  );
  db.prepare("UPDATE kb_sessions SET updated_at = ? WHERE id = ?").run(Date.now(), input.sessionId);
  return getKnowledgeMessage(id)!;
}

export function updateKnowledgeMessage(id: string, patch: Partial<Pick<KbMessage, "content" | "citations" | "status" | "error">>): KbMessage | undefined {
  const current = getKnowledgeMessage(id);
  if (!current) return undefined;
  db.prepare("UPDATE kb_messages SET content = ?, citations = ?, status = ?, error = ? WHERE id = ?").run(
    patch.content ?? current.content,
    JSON.stringify(patch.citations ?? current.citations),
    patch.status ?? current.status,
    patch.error === undefined ? current.error : patch.error,
    id,
  );
  return getKnowledgeMessage(id);
}

export function hasRunningKnowledgeMessage(sessionId: string): boolean {
  const row = db.prepare("SELECT COUNT(*) AS count FROM kb_messages WHERE session_id = ? AND status = 'running'").get(sessionId) as { count: number };
  return Number(row.count) > 0;
}
