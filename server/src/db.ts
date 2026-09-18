import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DB_PATH } from "./config.js";

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS feeds (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    url           TEXT NOT NULL UNIQUE,
    note          TEXT DEFAULT '',
    created_at    INTEGER NOT NULL,
    last_fetched_at INTEGER,
    last_error    TEXT
  );

  CREATE TABLE IF NOT EXISTS items (
    id            TEXT PRIMARY KEY,
    feed_id       TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
    guid          TEXT NOT NULL,
    title         TEXT NOT NULL,
    link          TEXT NOT NULL,
    author        TEXT,
    content_html  TEXT,
    content_text  TEXT,
    published_at  INTEGER,
    fetched_at    INTEGER NOT NULL,
    is_read       INTEGER DEFAULT 0,
    is_starred    INTEGER DEFAULT 0,
    UNIQUE (feed_id, guid)
  );

  CREATE TABLE IF NOT EXISTS topics (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    type          TEXT NOT NULL,           -- tweet | article
    angle         TEXT,
    materials     TEXT,                    -- JSON array of strings
    differentiation TEXT,
    language      TEXT,
    status        TEXT DEFAULT 'new',      -- new | writing | done | discarded
    source_item_ids TEXT,                  -- JSON array of item ids
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id            TEXT PRIMARY KEY,
    kind          TEXT NOT NULL,           -- summarize | evaluate | cluster | ideate
    status        TEXT NOT NULL,           -- queued | running | done | error
    input         TEXT,                    -- JSON
    output        TEXT,                    -- JSON
    error         TEXT,
    created_at    INTEGER NOT NULL,
    finished_at   INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_items_feed ON items(feed_id, published_at DESC);
  CREATE INDEX IF NOT EXISTS idx_items_fetched ON items(fetched_at);
`);

// ---- Feeds ----

export interface Feed {
  id: string;
  title: string;
  url: string;
  note: string;
  createdAt: number;
  lastFetchedAt: number | null;
  lastError: string | null;
}

export function listFeeds(): Feed[] {
  const rows = db.prepare("SELECT * FROM feeds ORDER BY created_at ASC").all() as any[];
  return rows.map(rowToFeed);
}

export function getFeed(id: string): Feed | undefined {
  const row = db.prepare("SELECT * FROM feeds WHERE id = ?").get(id) as any;
  return row ? rowToFeed(row) : undefined;
}

export function insertFeed(title: string, url: string, note = ""): Feed {
  const id = randomUUID();
  db.prepare("INSERT INTO feeds (id, title, url, note, created_at) VALUES (?, ?, ?, ?, ?)").run(
    id, title, url, note, Date.now(),
  );
  return getFeed(id)!;
}

export function deleteFeed(id: string): void {
  db.prepare("DELETE FROM feeds WHERE id = ?").run(id);
}

export function updateFeedFetchState(id: string, error: string | null): void {
  db.prepare("UPDATE feeds SET last_fetched_at = ?, last_error = ? WHERE id = ?").run(
    Date.now(), error, id,
  );
}

function rowToFeed(row: any): Feed {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    note: row.note ?? "",
    createdAt: row.created_at,
    lastFetchedAt: row.last_fetched_at,
    lastError: row.last_error,
  };
}

// ---- Items ----

export interface Item {
  id: string;
  feedId: string;
  guid: string;
  title: string;
  link: string;
  author: string | null;
  contentHtml: string | null;
  contentText: string | null;
  publishedAt: number | null;
  fetchedAt: number;
  isRead: boolean;
  isStarred: boolean;
  feedTitle?: string;
}

export function upsertItem(item: Omit<Item, "id" | "fetchedAt" | "isRead" | "isStarred">): boolean {
  // 用 feed_id + guid 做幂等去重；新条目返回 true
  const existing = db.prepare("SELECT id FROM items WHERE feed_id = ? AND guid = ?").get(item.feedId, item.guid) as any;
  if (existing) return false;
  const id = randomUUID();
  db.prepare(`
    INSERT INTO items (id, feed_id, guid, title, link, author, content_html, content_text, published_at, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, item.feedId, item.guid, item.title, item.link, item.author,
    item.contentHtml, item.contentText, item.publishedAt, Date.now(),
  );
  return true;
}

export interface ListItemsOptions {
  feedId?: string;
  unreadOnly?: boolean;
  starredOnly?: boolean;
  query?: string;
  limit?: number;
  offset?: number;
}

export function listItems(opts: ListItemsOptions = {}): Item[] {
  const where: string[] = [];
  const params: any[] = [];
  if (opts.feedId) { where.push("i.feed_id = ?"); params.push(opts.feedId); }
  if (opts.unreadOnly) { where.push("i.is_read = 0"); }
  if (opts.starredOnly) { where.push("i.is_starred = 1"); }
  if (opts.query) {
    where.push("(i.title LIKE ? OR i.content_text LIKE ?)");
    const q = `%${opts.query}%`;
    params.push(q, q);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = opts.limit ?? 200;
  const offset = opts.offset ?? 0;
  const rows = db.prepare(`
    SELECT i.*, f.title AS feed_title
    FROM items i JOIN feeds f ON f.id = i.feed_id
    ${whereSql}
    ORDER BY i.published_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as any[];
  return rows.map(rowToItem);
}

export function getItem(id: string): Item | undefined {
  const row = db.prepare(`
    SELECT i.*, f.title AS feed_title
    FROM items i JOIN feeds f ON f.id = i.feed_id
    WHERE i.id = ?
  `).get(id) as any;
  return row ? rowToItem(row) : undefined;
}

export function getItemsByIds(ids: string[]): Item[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT i.*, f.title AS feed_title
    FROM items i JOIN feeds f ON f.id = i.feed_id
    WHERE i.id IN (${placeholders})
  `).all(...ids) as any[];
  const map = new Map(rows.map((r: any) => [r.id, rowToItem(r)]));
  // 按传入顺序返回
  return ids.map((id) => map.get(id)).filter(Boolean) as Item[];
}

export function setItemRead(id: string, isRead: boolean): void {
  db.prepare("UPDATE items SET is_read = ? WHERE id = ?").run(isRead ? 1 : 0, id);
}

export function setItemStarred(id: string, isStarred: boolean): void {
  db.prepare("UPDATE items SET is_starred = ? WHERE id = ?").run(isStarred ? 1 : 0, id);
}

export function markAllRead(feedId?: string): void {
  if (feedId) {
    db.prepare("UPDATE items SET is_read = 1 WHERE feed_id = ?").run(feedId);
  } else {
    db.prepare("UPDATE items SET is_read = 1").run();
  }
}

export function countUnread(): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM items WHERE is_read = 0").get() as any;
  return row.n;
}

export function pruneOldItems(days: number): void {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  db.prepare("DELETE FROM items WHERE fetched_at < ?").run(cutoff);
}

function rowToItem(row: any): Item {
  return {
    id: row.id,
    feedId: row.feed_id,
    guid: row.guid,
    title: row.title,
    link: row.link,
    author: row.author,
    contentHtml: row.content_html,
    contentText: row.content_text,
    publishedAt: row.published_at,
    fetchedAt: row.fetched_at,
    isRead: !!row.is_read,
    isStarred: !!row.is_starred,
    feedTitle: row.feed_title,
  };
}

// ---- Topics ----

export interface Topic {
  id: string;
  title: string;
  type: "tweet" | "article";
  angle: string | null;
  materials: string[];
  differentiation: string | null;
  language: string | null;
  status: "new" | "writing" | "done" | "discarded";
  sourceItemIds: string[];
  createdAt: number;
}

export function insertTopic(t: Omit<Topic, "id" | "createdAt" | "status">): Topic {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO topics (id, title, type, angle, materials, differentiation, language, status, source_item_ids, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)
  `).run(
    id, t.title, t.type, t.angle, JSON.stringify(t.materials), t.differentiation,
    t.language, JSON.stringify(t.sourceItemIds), Date.now(),
  );
  return getTopic(id)!;
}

export function listTopics(): Topic[] {
  const rows = db.prepare("SELECT * FROM topics ORDER BY created_at DESC").all() as any[];
  return rows.map(rowToTopic);
}

export function getTopic(id: string): Topic | undefined {
  const row = db.prepare("SELECT * FROM topics WHERE id = ?").get(id) as any;
  return row ? rowToTopic(row) : undefined;
}

export function setTopicStatus(id: string, status: Topic["status"]): void {
  db.prepare("UPDATE topics SET status = ? WHERE id = ?").run(status, id);
}

export function deleteTopic(id: string): void {
  db.prepare("DELETE FROM topics WHERE id = ?").run(id);
}

function rowToTopic(row: any): Topic {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    angle: row.angle,
    materials: safeParse(row.materials, []),
    differentiation: row.differentiation,
    language: row.language,
    status: row.status,
    sourceItemIds: safeParse(row.source_item_ids, []),
    createdAt: row.created_at,
  };
}

// ---- Tasks ----

export interface Task {
  id: string;
  kind: string;
  status: "queued" | "running" | "done" | "error";
  input: any;
  output: any;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export function insertTask(kind: string, input: any): Task {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO tasks (id, kind, status, input, created_at)
    VALUES (?, ?, 'queued', ?, ?)
  `).run(id, kind, JSON.stringify(input), Date.now());
  return getTask(id)!;
}

export function updateTask(id: string, patch: Partial<Pick<Task, "status" | "output" | "error" | "finishedAt">>): void {
  if (patch.status) db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(patch.status, id);
  if (patch.output !== undefined) db.prepare("UPDATE tasks SET output = ? WHERE id = ?").run(JSON.stringify(patch.output), id);
  if (patch.error !== undefined) db.prepare("UPDATE tasks SET error = ? WHERE id = ?").run(patch.error, id);
  if (patch.finishedAt !== undefined) db.prepare("UPDATE tasks SET finished_at = ? WHERE id = ?").run(patch.finishedAt, id);
}

export function getTask(id: string): Task | undefined {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
  return row ? rowToTask(row) : undefined;
}

export function listTasks(limit = 50): Task[] {
  const rows = db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").all(limit) as any[];
  return rows.map(rowToTask);
}

function rowToTask(row: any): Task {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    input: safeParse(row.input, null),
    output: safeParse(row.output, null),
    error: row.error,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function safeParse(json: string | null, fallback: any): any {
  if (!json) return fallback;
  try { return JSON.parse(json); } catch { return fallback; }
}
