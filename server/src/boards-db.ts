import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import type { CardMetrics } from "./board-link.js";

export type BoardCardKind = "link" | "note";
export type BoardCardSource = "x" | "web" | "youtube" | "note";
export type BoardCardStatus = "loading" | "ready" | "failed";

export interface Board {
  id: string;
  name: string;
  cardCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface BoardCard {
  id: string;
  boardId: string;
  kind: BoardCardKind;
  source: BoardCardSource;
  status: BoardCardStatus;
  url: string | null;
  title: string;
  authorName: string;
  authorHandle: string;
  authorAvatar: string | null;
  body: string;
  summary: string;
  imageUrl: string | null;
  siteName: string;
  metrics: CardMetrics | null;
  publishedAt: number | null;
  manual: boolean;
  x: number;
  y: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface BoardCitation {
  index: number;
  cardId: string;
  title: string;
  excerpt: string;
  source: BoardCardSource;
}

export interface BoardSession {
  id: string;
  boardId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface BoardSessionRecord extends BoardSession {
  piSessionId: string | null;
  piSessionPath: string | null;
}

export interface BoardMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  citations: BoardCitation[];
  cardIds: string[];
  status: "running" | "done" | "error";
  error: string | null;
  createdAt: number;
}

export interface NewBoardCard {
  boardId: string;
  kind: BoardCardKind;
  source: BoardCardSource;
  status: BoardCardStatus;
  url: string | null;
  dedupeKey: string;
  title?: string;
  authorName?: string;
  authorHandle?: string;
  authorAvatar?: string | null;
  body?: string;
  summary?: string;
  imageUrl?: string | null;
  siteName?: string;
  metrics?: CardMetrics | null;
  publishedAt?: number | null;
  manual?: boolean;
  x: number;
  y: number;
  error?: string | null;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; }
  catch { return fallback; }
}

function rowToBoard(row: any): Board {
  return {
    id: row.id,
    name: row.name,
    cardCount: Number(row.card_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCard(row: any): BoardCard {
  return {
    id: row.id,
    boardId: row.board_id,
    kind: row.kind,
    source: row.source,
    status: row.status,
    url: row.url,
    title: row.title || "",
    authorName: row.author_name || "",
    authorHandle: row.author_handle || "",
    authorAvatar: row.author_avatar,
    body: row.body || "",
    summary: row.summary || "",
    imageUrl: row.image_url,
    siteName: row.site_name || "",
    metrics: parseJson<CardMetrics | null>(row.metrics_json, null),
    publishedAt: row.published_at,
    manual: row.manual === 1,
    x: row.position_x,
    y: row.position_y,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listBoards(): Board[] {
  return (db.prepare(`SELECT b.*, (SELECT COUNT(*) FROM board_cards c WHERE c.board_id = b.id) AS card_count
    FROM boards b ORDER BY b.updated_at DESC`).all() as any[]).map(rowToBoard);
}

export function getBoard(id: string): Board | undefined {
  const row = db.prepare(`SELECT b.*, (SELECT COUNT(*) FROM board_cards c WHERE c.board_id = b.id) AS card_count
    FROM boards b WHERE b.id = ?`).get(id) as any;
  return row ? rowToBoard(row) : undefined;
}

export function insertBoard(name: string): Board {
  const id = randomUUID();
  const now = Date.now();
  db.prepare("INSERT INTO boards (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, name, now, now);
  return getBoard(id)!;
}

export function updateBoard(id: string, name: string): Board | undefined {
  const current = getBoard(id);
  if (!current) return undefined;
  db.prepare("UPDATE boards SET name = ?, updated_at = ? WHERE id = ?").run(name, Date.now(), id);
  return getBoard(id);
}

export function deleteBoard(id: string): boolean {
  const result = db.prepare("DELETE FROM boards WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}

export function touchBoard(id: string): void {
  db.prepare("UPDATE boards SET updated_at = ? WHERE id = ?").run(Date.now(), id);
}

export function listBoardCards(boardId: string): BoardCard[] {
  return (db.prepare("SELECT * FROM board_cards WHERE board_id = ? ORDER BY created_at ASC").all(boardId) as any[]).map(rowToCard);
}

export function countBoardCards(boardId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM board_cards WHERE board_id = ?").get(boardId) as { count: number };
  return Number(row.count);
}

export function getBoardCard(id: string): BoardCard | undefined {
  const row = db.prepare("SELECT * FROM board_cards WHERE id = ?").get(id) as any;
  return row ? rowToCard(row) : undefined;
}

export function findCardByDedupe(boardId: string, dedupeKey: string): BoardCard | undefined {
  const row = db.prepare("SELECT * FROM board_cards WHERE board_id = ? AND dedupe_key = ?").get(boardId, dedupeKey) as any;
  return row ? rowToCard(row) : undefined;
}

export function insertBoardCard(input: NewBoardCard): BoardCard {
  const id = randomUUID();
  const now = Date.now();
  const dedupeKey = input.dedupeKey || `note:${id}`;
  db.prepare(`INSERT INTO board_cards (
    id, board_id, kind, source, status, url, dedupe_key, title, author_name, author_handle, author_avatar,
    body, summary, image_url, site_name, metrics_json, published_at, manual, position_x, position_y, error, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    input.boardId,
    input.kind,
    input.source,
    input.status,
    input.url,
    dedupeKey,
    input.title || "",
    input.authorName || "",
    input.authorHandle || "",
    input.authorAvatar ?? null,
    input.body || "",
    input.summary || "",
    input.imageUrl ?? null,
    input.siteName || "",
    input.metrics ? JSON.stringify(input.metrics) : null,
    input.publishedAt ?? null,
    input.manual ? 1 : 0,
    input.x,
    input.y,
    input.error ?? null,
    now,
    now,
  );
  touchBoard(input.boardId);
  return getBoardCard(id)!;
}

export function updateBoardCard(id: string, patch: Partial<Omit<BoardCard, "id" | "boardId" | "createdAt">>): BoardCard | undefined {
  const current = getBoardCard(id);
  if (!current) return undefined;
  const next = { ...current, ...patch };
  db.prepare(`UPDATE board_cards SET
    kind = ?, source = ?, status = ?, url = ?, title = ?, author_name = ?, author_handle = ?, author_avatar = ?,
    body = ?, summary = ?, image_url = ?, site_name = ?, metrics_json = ?, published_at = ?, manual = ?,
    position_x = ?, position_y = ?, error = ?, updated_at = ?
    WHERE id = ?`).run(
    next.kind,
    next.source,
    next.status,
    next.url,
    next.title,
    next.authorName,
    next.authorHandle,
    next.authorAvatar,
    next.body,
    next.summary,
    next.imageUrl,
    next.siteName,
    next.metrics ? JSON.stringify(next.metrics) : null,
    next.publishedAt,
    next.manual ? 1 : 0,
    next.x,
    next.y,
    next.error,
    Date.now(),
    id,
  );
  touchBoard(current.boardId);
  return getBoardCard(id);
}

export function deleteBoardCard(id: string): BoardCard | undefined {
  const current = getBoardCard(id);
  if (!current) return undefined;
  db.prepare("DELETE FROM board_cards WHERE id = ?").run(id);
  touchBoard(current.boardId);
  return current;
}

function rowToSession(row: any): BoardSessionRecord {
  return {
    id: row.id,
    boardId: row.board_id,
    title: row.title,
    piSessionId: row.pi_session_id,
    piSessionPath: row.pi_session_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toPublicSession(record: BoardSessionRecord): BoardSession {
  const { piSessionId: _piSessionId, piSessionPath: _piSessionPath, ...pub } = record;
  return pub;
}

export function listBoardSessions(boardId: string): BoardSession[] {
  return (db.prepare("SELECT * FROM board_sessions WHERE board_id = ? ORDER BY updated_at DESC").all(boardId) as any[]).map((row) => toPublicSession(rowToSession(row)));
}

export function getBoardSession(id: string): BoardSessionRecord | undefined {
  const row = db.prepare("SELECT * FROM board_sessions WHERE id = ?").get(id) as any;
  return row ? rowToSession(row) : undefined;
}

export function insertBoardSession(boardId: string, title = "新的对话"): BoardSession {
  const id = randomUUID();
  const now = Date.now();
  db.prepare("INSERT INTO board_sessions (id, board_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, boardId, title, now, now);
  return toPublicSession(getBoardSession(id)!);
}

export function updateBoardSession(id: string, patch: Partial<Pick<BoardSessionRecord, "title" | "piSessionId" | "piSessionPath">>): void {
  const current = getBoardSession(id);
  if (!current) return;
  db.prepare("UPDATE board_sessions SET title = ?, pi_session_id = ?, pi_session_path = ?, updated_at = ? WHERE id = ?").run(
    patch.title ?? current.title,
    patch.piSessionId === undefined ? current.piSessionId : patch.piSessionId,
    patch.piSessionPath === undefined ? current.piSessionPath : patch.piSessionPath,
    Date.now(),
    id,
  );
}

export function deleteBoardSession(id: string): boolean {
  const result = db.prepare("DELETE FROM board_sessions WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}

function rowToMessage(row: any): BoardMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    citations: parseJson(row.citations, []),
    cardIds: parseJson(row.card_ids, []),
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
  };
}

export function listBoardMessages(sessionId: string): BoardMessage[] {
  return (db.prepare("SELECT * FROM board_messages WHERE session_id = ? ORDER BY created_at ASC").all(sessionId) as any[]).map(rowToMessage);
}

export function getBoardMessage(id: string): BoardMessage | undefined {
  const row = db.prepare("SELECT * FROM board_messages WHERE id = ?").get(id) as any;
  return row ? rowToMessage(row) : undefined;
}

export function insertBoardMessage(input: {
  sessionId: string;
  role: BoardMessage["role"];
  content: string;
  citations?: BoardCitation[];
  cardIds?: string[];
  status: BoardMessage["status"];
  error?: string | null;
}): BoardMessage {
  const id = randomUUID();
  db.prepare(`INSERT INTO board_messages (id, session_id, role, content, citations, card_ids, status, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    input.sessionId,
    input.role,
    input.content,
    JSON.stringify(input.citations || []),
    JSON.stringify(input.cardIds || []),
    input.status,
    input.error ?? null,
    Date.now(),
  );
  db.prepare("UPDATE board_sessions SET updated_at = ? WHERE id = ?").run(Date.now(), input.sessionId);
  return getBoardMessage(id)!;
}

export function updateBoardMessage(id: string, patch: Partial<Pick<BoardMessage, "content" | "citations" | "cardIds" | "status" | "error">>): BoardMessage | undefined {
  const current = getBoardMessage(id);
  if (!current) return undefined;
  db.prepare("UPDATE board_messages SET content = ?, citations = ?, card_ids = ?, status = ?, error = ? WHERE id = ?").run(
    patch.content ?? current.content,
    JSON.stringify(patch.citations ?? current.citations),
    JSON.stringify(patch.cardIds ?? current.cardIds),
    patch.status ?? current.status,
    patch.error === undefined ? current.error : patch.error,
    id,
  );
  return getBoardMessage(id);
}

export function hasRunningBoardMessage(sessionId: string): boolean {
  const row = db.prepare("SELECT COUNT(*) AS count FROM board_messages WHERE session_id = ? AND status = 'running'").get(sessionId) as { count: number };
  return Number(row.count) > 0;
}
