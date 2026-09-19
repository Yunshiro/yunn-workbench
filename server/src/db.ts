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

  CREATE TABLE IF NOT EXISTS drafts (
    id            TEXT PRIMARY KEY,
    topic_id      TEXT REFERENCES topics(id) ON DELETE SET NULL,
    title         TEXT NOT NULL DEFAULT '',
    content       TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'draft', -- draft | published
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id            TEXT PRIMARY KEY,
    kind          TEXT NOT NULL,           -- summarize | evaluate | cluster | ideate
    status        TEXT NOT NULL,           -- queued | running | done | error
    input         TEXT,                    -- JSON
    output        TEXT,                    -- JSON
    trace         TEXT DEFAULT '[]',       -- JSON agent action trace
    session_id    TEXT,
    session_path  TEXT,
    profile_snapshot TEXT,
    last_activity_at INTEGER,
    error         TEXT,
    created_at    INTEGER NOT NULL,
    finished_at   INTEGER
  );

  CREATE TABLE IF NOT EXISTS creator_profiles (
    id            TEXT PRIMARY KEY,
    card_name     TEXT NOT NULL DEFAULT '默认画像',
    is_active     INTEGER NOT NULL DEFAULT 0,
    name          TEXT DEFAULT '',
    domains       TEXT DEFAULT '[]',
    audience      TEXT DEFAULT '',
    goals         TEXT DEFAULT '',
    tone          TEXT DEFAULT '',
    avoid_topics  TEXT DEFAULT '[]',
    output_preferences TEXT DEFAULT '{}',
    version       INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memory_facts (
    id            TEXT PRIMARY KEY,
    profile_id    TEXT,
    category      TEXT NOT NULL,
    content       TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'candidate',
    source_type   TEXT NOT NULL DEFAULT 'manual',
    source_id     TEXT,
    confidence    REAL NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    last_used_at  INTEGER
  );

  CREATE TABLE IF NOT EXISTS research_messages (
    id            TEXT PRIMARY KEY,
    task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    role          TEXT NOT NULL,
    mode          TEXT,
    content       TEXT NOT NULL,
    status        TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    delivered_at  INTEGER
  );

  CREATE TABLE IF NOT EXISTS research_revisions (
    id            TEXT PRIMARY KEY,
    task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    revision      INTEGER NOT NULL,
    output        TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    UNIQUE(task_id, revision)
  );

  CREATE INDEX IF NOT EXISTS idx_items_feed ON items(feed_id, published_at DESC);
  CREATE INDEX IF NOT EXISTS idx_items_fetched ON items(fetched_at);
  CREATE INDEX IF NOT EXISTS idx_drafts_topic ON drafts(topic_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_research_messages_task ON research_messages(task_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_research_revisions_task ON research_revisions(task_id, revision);
`);

// Lightweight forward migration for databases created before research traces existed.
const taskColumns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
if (!taskColumns.some((column) => column.name === "trace")) {
  db.exec("ALTER TABLE tasks ADD COLUMN trace TEXT DEFAULT '[]'");
}
for (const [name, definition] of [
  ["session_id", "TEXT"],
  ["session_path", "TEXT"],
  ["profile_snapshot", "TEXT"],
  ["last_activity_at", "INTEGER"],
] as const) {
  if (!taskColumns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
  }
}

// Forward migration from the original single creator profile.
const profileColumns = db.prepare("PRAGMA table_info(creator_profiles)").all() as Array<{ name: string }>;
if (!profileColumns.some((column) => column.name === "card_name")) {
  db.exec("ALTER TABLE creator_profiles ADD COLUMN card_name TEXT NOT NULL DEFAULT '默认画像'");
}
if (!profileColumns.some((column) => column.name === "is_active")) {
  db.exec("ALTER TABLE creator_profiles ADD COLUMN is_active INTEGER NOT NULL DEFAULT 0");
}
const memoryColumns = db.prepare("PRAGMA table_info(memory_facts)").all() as Array<{ name: string }>;
if (!memoryColumns.some((column) => column.name === "profile_id")) {
  db.exec("ALTER TABLE memory_facts ADD COLUMN profile_id TEXT");
}
const profileCount = Number((db.prepare("SELECT COUNT(*) AS count FROM creator_profiles").get() as any).count);
if (profileCount > 0) {
  const activeCount = Number((db.prepare("SELECT COUNT(*) AS count FROM creator_profiles WHERE is_active = 1").get() as any).count);
  if (activeCount === 0) {
    db.prepare("UPDATE creator_profiles SET is_active = 1 WHERE id = (SELECT id FROM creator_profiles ORDER BY created_at ASC LIMIT 1)").run();
  }
  const activeId = (db.prepare("SELECT id FROM creator_profiles WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1").get() as any)?.id;
  if (activeId) db.prepare("UPDATE memory_facts SET profile_id = ? WHERE profile_id IS NULL").run(activeId);
}
db.exec("CREATE INDEX IF NOT EXISTS idx_memory_facts_profile ON memory_facts(profile_id, updated_at DESC)");

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

export function countItems(opts: ListItemsOptions = {}): number {
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
  const row = db.prepare(`
    SELECT COUNT(*) AS n
    FROM items i
    ${whereSql}
  `).get(...params) as { n: number };
  return row.n;
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
  draftCount: number;
  createdAt: number;
}

export function insertTopic(t: Omit<Topic, "id" | "createdAt" | "status" | "draftCount">): Topic {
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
  const rows = db.prepare(`
    SELECT topics.*, (SELECT COUNT(*) FROM drafts WHERE drafts.topic_id = topics.id) AS draft_count
    FROM topics ORDER BY created_at DESC
  `).all() as any[];
  return rows.map(rowToTopic);
}

export function getTopic(id: string): Topic | undefined {
  const row = db.prepare(`
    SELECT topics.*, (SELECT COUNT(*) FROM drafts WHERE drafts.topic_id = topics.id) AS draft_count
    FROM topics WHERE topics.id = ?
  `).get(id) as any;
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
    draftCount: Number(row.draft_count || 0),
    createdAt: row.created_at,
  };
}

// ---- Drafts ----

export interface Draft {
  id: string;
  topicId: string | null;
  topicTitle: string | null;
  title: string;
  content: string;
  status: "draft" | "published";
  createdAt: number;
  updatedAt: number;
}

export function listDrafts(options: { topicId?: string; status?: Draft["status"] } = {}): Draft[] {
  const where: string[] = [];
  const params: string[] = [];
  if (options.topicId) {
    where.push("d.topic_id = ?");
    params.push(options.topicId);
  }
  if (options.status) {
    where.push("d.status = ?");
    params.push(options.status);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db.prepare(`
    SELECT d.*, t.title AS topic_title
    FROM drafts d LEFT JOIN topics t ON t.id = d.topic_id
    ${whereSql}
    ORDER BY d.updated_at DESC
  `).all(...params) as any[];
  return rows.map(rowToDraft);
}

export function getDraft(id: string): Draft | undefined {
  const row = db.prepare(`
    SELECT d.*, t.title AS topic_title
    FROM drafts d LEFT JOIN topics t ON t.id = d.topic_id
    WHERE d.id = ?
  `).get(id) as any;
  return row ? rowToDraft(row) : undefined;
}

export function insertDraft(input: { topicId?: string | null; title?: string; content?: string }): Draft {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO drafts (id, topic_id, title, content, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'draft', ?, ?)
  `).run(id, input.topicId ?? null, input.title?.trim() || "未命名草稿", input.content || "", now, now);
  return getDraft(id)!;
}

export function updateDraft(id: string, patch: Partial<Pick<Draft, "topicId" | "title" | "content" | "status">>): Draft | undefined {
  const updates: string[] = [];
  const params: Array<string | null | number> = [];
  if (Object.prototype.hasOwnProperty.call(patch, "topicId")) {
    updates.push("topic_id = ?");
    params.push(patch.topicId ?? null);
  }
  if (patch.title !== undefined) {
    updates.push("title = ?");
    params.push(patch.title.trim() || "未命名草稿");
  }
  if (patch.content !== undefined) {
    updates.push("content = ?");
    params.push(patch.content);
  }
  if (patch.status !== undefined) {
    updates.push("status = ?");
    params.push(patch.status);
  }
  if (updates.length === 0) return getDraft(id);
  updates.push("updated_at = ?");
  params.push(Date.now(), id);
  db.prepare(`UPDATE drafts SET ${updates.join(", ")} WHERE id = ?`).run(...params);
  return getDraft(id);
}

export function deleteDraft(id: string): void {
  db.prepare("DELETE FROM drafts WHERE id = ?").run(id);
}

function rowToDraft(row: any): Draft {
  return {
    id: row.id,
    topicId: row.topic_id,
    topicTitle: row.topic_title,
    title: row.title,
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---- Tasks ----

export interface Task {
  id: string;
  kind: string;
  status: "queued" | "running" | "awaiting_feedback" | "completed" | "done" | "error" | "cancelled";
  input: any;
  output: any;
  trace: TaskTrace[];
  sessionId: string | null;
  sessionPath: string | null;
  profileSnapshot: CreatorContextSnapshot | null;
  lastActivityAt: number | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface TaskTrace {
  id: string;
  tool: string;
  label: string;
  status: "running" | "done" | "error";
  input: Record<string, unknown>;
  summary: string | null;
  startedAt: number;
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

export function updateTask(id: string, patch: Partial<Pick<Task, "status" | "output" | "trace" | "sessionId" | "sessionPath" | "profileSnapshot" | "lastActivityAt" | "error" | "finishedAt">>): void {
  if (patch.status) db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(patch.status, id);
  if (patch.output !== undefined) db.prepare("UPDATE tasks SET output = ? WHERE id = ?").run(JSON.stringify(patch.output), id);
  if (patch.trace !== undefined) db.prepare("UPDATE tasks SET trace = ? WHERE id = ?").run(JSON.stringify(patch.trace), id);
  if (patch.sessionId !== undefined) db.prepare("UPDATE tasks SET session_id = ? WHERE id = ?").run(patch.sessionId, id);
  if (patch.sessionPath !== undefined) db.prepare("UPDATE tasks SET session_path = ? WHERE id = ?").run(patch.sessionPath, id);
  if (patch.profileSnapshot !== undefined) db.prepare("UPDATE tasks SET profile_snapshot = ? WHERE id = ?").run(JSON.stringify(patch.profileSnapshot), id);
  if (patch.lastActivityAt !== undefined) db.prepare("UPDATE tasks SET last_activity_at = ? WHERE id = ?").run(patch.lastActivityAt, id);
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

export function deleteTask(id: string): boolean {
  return db.prepare("DELETE FROM tasks WHERE id = ?").run(id).changes > 0;
}

function rowToTask(row: any): Task {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    input: safeParse(row.input, null),
    output: safeParse(row.output, null),
    trace: safeParse(row.trace, []),
    sessionId: row.session_id ?? null,
    sessionPath: row.session_path ?? null,
    profileSnapshot: safeParse(row.profile_snapshot, null),
    lastActivityAt: row.last_activity_at ?? null,
    error: row.error,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

// ---- Creator profile and long-term memory ----

export interface CreatorProfile {
  id: string;
  cardName: string;
  isActive: boolean;
  name: string;
  domains: string[];
  audience: string;
  goals: string;
  tone: string;
  avoidTopics: string[];
  outputPreferences: { platforms?: string[]; language?: string; length?: string };
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryFact {
  id: string;
  profileId: string;
  category: string;
  content: string;
  status: "candidate" | "active" | "disabled";
  sourceType: "manual" | "topic_confirmation" | "agent";
  sourceId: string | null;
  confidence: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

export interface CreatorContextSnapshot {
  profile: CreatorProfile;
  memories: MemoryFact[];
}

function rowToCreatorProfile(row: any): CreatorProfile {
  return {
    id: row.id,
    cardName: row.card_name || "未命名画像",
    isActive: !!row.is_active,
    name: row.name ?? "",
    domains: safeParse(row.domains, []),
    audience: row.audience ?? "",
    goals: row.goals ?? "",
    tone: row.tone ?? "",
    avoidTopics: safeParse(row.avoid_topics, []),
    outputPreferences: safeParse(row.output_preferences, {}),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type CreatorProfileInput = Omit<CreatorProfile, "id" | "isActive" | "version" | "createdAt" | "updatedAt">;

function ensureCreatorProfile(): CreatorProfile {
  const existing = db.prepare("SELECT * FROM creator_profiles ORDER BY is_active DESC, created_at ASC LIMIT 1").get() as any;
  if (existing) return rowToCreatorProfile(existing);
  const now = Date.now();
  db.prepare("INSERT INTO creator_profiles (id, card_name, is_active, created_at, updated_at) VALUES ('default', '默认画像', 1, ?, ?)").run(now, now);
  return rowToCreatorProfile(db.prepare("SELECT * FROM creator_profiles WHERE id = 'default'").get());
}

export function listCreatorProfiles(): CreatorProfile[] {
  ensureCreatorProfile();
  return (db.prepare("SELECT * FROM creator_profiles ORDER BY is_active DESC, updated_at DESC").all() as any[]).map(rowToCreatorProfile);
}

export function getCreatorProfile(id?: string): CreatorProfile {
  ensureCreatorProfile();
  const row = id
    ? db.prepare("SELECT * FROM creator_profiles WHERE id = ?").get(id)
    : db.prepare("SELECT * FROM creator_profiles WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1").get();
  if (!row) {
    if (id) throw new Error("创作者画像不存在");
    return ensureCreatorProfile();
  }
  return rowToCreatorProfile(row);
}

export function createCreatorProfile(input?: Partial<CreatorProfileInput>): CreatorProfile {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO creator_profiles (id, card_name, is_active, name, domains, audience, goals, tone, avoid_topics, output_preferences, version, created_at, updated_at)
    VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id, input?.cardName?.trim() || "未命名画像", input?.name || "", JSON.stringify(input?.domains || []),
    input?.audience || "", input?.goals || "", input?.tone || "", JSON.stringify(input?.avoidTopics || []),
    JSON.stringify(input?.outputPreferences || {}), now, now,
  );
  return getCreatorProfile(id);
}

export function saveCreatorProfile(id: string, input: CreatorProfileInput): CreatorProfile {
  const current = getCreatorProfile(id);
  db.prepare(`
    UPDATE creator_profiles SET card_name = ?, name = ?, domains = ?, audience = ?, goals = ?, tone = ?,
      avoid_topics = ?, output_preferences = ?, version = ?, updated_at = ? WHERE id = ?
  `).run(
    input.cardName.trim() || "未命名画像", input.name, JSON.stringify(input.domains), input.audience, input.goals, input.tone,
    JSON.stringify(input.avoidTopics), JSON.stringify(input.outputPreferences),
    current.version + 1, Date.now(), id,
  );
  return getCreatorProfile(id);
}

export function activateCreatorProfile(id: string): CreatorProfile {
  getCreatorProfile(id);
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE creator_profiles SET is_active = 0 WHERE is_active = 1").run();
    db.prepare("UPDATE creator_profiles SET is_active = 1, updated_at = ? WHERE id = ?").run(Date.now(), id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getCreatorProfile(id);
}

export function duplicateCreatorProfile(id: string): CreatorProfile {
  const source = getCreatorProfile(id);
  const copy = createCreatorProfile({
    cardName: `${source.cardName} 副本`, name: source.name, domains: source.domains,
    audience: source.audience, goals: source.goals, tone: source.tone,
    avoidTopics: source.avoidTopics, outputPreferences: source.outputPreferences,
  });
  const memories = listMemories(undefined, id);
  for (const memory of memories) {
    insertMemory({
      profileId: copy.id, category: memory.category, content: memory.content, status: memory.status,
      sourceType: memory.sourceType, sourceId: memory.sourceId, confidence: memory.confidence,
    });
  }
  return copy;
}

export function deleteCreatorProfile(id: string): void {
  const profiles = listCreatorProfiles();
  if (profiles.length <= 1) throw new Error("至少需要保留一张创作者画像");
  const target = profiles.find((profile) => profile.id === id);
  if (!target) throw new Error("创作者画像不存在");
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM memory_facts WHERE profile_id = ?").run(id);
    db.prepare("DELETE FROM creator_profiles WHERE id = ?").run(id);
    if (target.isActive) {
      db.prepare("UPDATE creator_profiles SET is_active = 1, updated_at = ? WHERE id = (SELECT id FROM creator_profiles ORDER BY updated_at DESC LIMIT 1)").run(Date.now());
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function rowToMemory(row: any): MemoryFact {
  return {
    id: row.id,
    profileId: row.profile_id,
    category: row.category,
    content: row.content,
    status: row.status,
    sourceType: row.source_type,
    sourceId: row.source_id,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

export function listMemories(status?: MemoryFact["status"], profileId?: string): MemoryFact[] {
  const targetProfileId = profileId || getCreatorProfile().id;
  const rows = status
    ? db.prepare("SELECT * FROM memory_facts WHERE profile_id = ? AND status = ? ORDER BY updated_at DESC").all(targetProfileId, status)
    : db.prepare("SELECT * FROM memory_facts WHERE profile_id = ? ORDER BY updated_at DESC").all(targetProfileId);
  return (rows as any[]).map(rowToMemory);
}

export function insertMemory(input: Pick<MemoryFact, "category" | "content"> & Partial<Pick<MemoryFact, "profileId" | "status" | "sourceType" | "sourceId" | "confidence">>): MemoryFact {
  const profileId = input.profileId || getCreatorProfile().id;
  const duplicate = db.prepare("SELECT * FROM memory_facts WHERE profile_id = ? AND content = ? AND status != 'disabled'").get(profileId, input.content) as any;
  if (duplicate) return rowToMemory(duplicate);
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO memory_facts (id, profile_id, category, content, status, source_type, source_id, confidence, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, profileId, input.category, input.content, input.status ?? "candidate", input.sourceType ?? "manual", input.sourceId ?? null, input.confidence ?? 1, now, now);
  return getMemory(id)!;
}

export function getMemory(id: string): MemoryFact | undefined {
  const row = db.prepare("SELECT * FROM memory_facts WHERE id = ?").get(id) as any;
  return row ? rowToMemory(row) : undefined;
}

export function updateMemory(id: string, patch: Partial<Pick<MemoryFact, "category" | "content" | "status">>): MemoryFact | undefined {
  const current = getMemory(id);
  if (!current) return undefined;
  db.prepare("UPDATE memory_facts SET category = ?, content = ?, status = ?, updated_at = ? WHERE id = ?").run(
    patch.category ?? current.category, patch.content ?? current.content, patch.status ?? current.status, Date.now(), id,
  );
  return getMemory(id);
}

export function deleteMemory(id: string): void {
  db.prepare("DELETE FROM memory_facts WHERE id = ?").run(id);
}

export function getCreatorContextSnapshot(): CreatorContextSnapshot {
  const profile = getCreatorProfile();
  const memories = listMemories("active", profile.id).slice(0, 20);
  if (memories.length > 0) {
    const now = Date.now();
    const ids = memories.map((memory) => memory.id);
    db.prepare(`UPDATE memory_facts SET last_used_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`).run(now, ...ids);
  }
  return { profile, memories };
}

// ---- Research messages and revisions ----

export interface ResearchMessage {
  id: string;
  taskId: string;
  role: "user" | "assistant";
  mode: "steer" | "follow_up" | null;
  content: string;
  status: "queued" | "delivered" | "failed";
  createdAt: number;
  deliveredAt: number | null;
}

export function insertResearchMessage(taskId: string, role: ResearchMessage["role"], content: string, mode: ResearchMessage["mode"], status: ResearchMessage["status"]): ResearchMessage {
  const id = randomUUID();
  db.prepare(`INSERT INTO research_messages (id, task_id, role, mode, content, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, taskId, role, mode, content, status, Date.now());
  return getResearchMessage(id)!;
}

export function getResearchMessage(id: string): ResearchMessage | undefined {
  const row = db.prepare("SELECT * FROM research_messages WHERE id = ?").get(id) as any;
  return row ? rowToResearchMessage(row) : undefined;
}

export function updateResearchMessage(id: string, status: ResearchMessage["status"]): ResearchMessage | undefined {
  db.prepare("UPDATE research_messages SET status = ?, delivered_at = ? WHERE id = ?").run(status, status === "delivered" ? Date.now() : null, id);
  return getResearchMessage(id);
}

export function listResearchMessages(taskId: string): ResearchMessage[] {
  return (db.prepare("SELECT * FROM research_messages WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as any[]).map(rowToResearchMessage);
}

function rowToResearchMessage(row: any): ResearchMessage {
  return { id: row.id, taskId: row.task_id, role: row.role, mode: row.mode, content: row.content, status: row.status, createdAt: row.created_at, deliveredAt: row.delivered_at };
}

export interface ResearchRevision {
  id: string;
  taskId: string;
  revision: number;
  output: any;
  createdAt: number;
}

export function insertResearchRevision(taskId: string, output: any): ResearchRevision {
  const row = db.prepare("SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM research_revisions WHERE task_id = ?").get(taskId) as any;
  const id = randomUUID();
  db.prepare("INSERT INTO research_revisions (id, task_id, revision, output, created_at) VALUES (?, ?, ?, ?, ?)").run(id, taskId, row.next, JSON.stringify(output), Date.now());
  return getResearchRevision(taskId, row.next)!;
}

export function listResearchRevisions(taskId: string): ResearchRevision[] {
  return (db.prepare("SELECT * FROM research_revisions WHERE task_id = ? ORDER BY revision DESC").all(taskId) as any[]).map(rowToResearchRevision);
}

export function getResearchRevision(taskId: string, revision: number): ResearchRevision | undefined {
  const row = db.prepare("SELECT * FROM research_revisions WHERE task_id = ? AND revision = ?").get(taskId, revision) as any;
  return row ? rowToResearchRevision(row) : undefined;
}

function rowToResearchRevision(row: any): ResearchRevision {
  return { id: row.id, taskId: row.task_id, revision: row.revision, output: safeParse(row.output, null), createdAt: row.created_at };
}

function safeParse(json: string | null, fallback: any): any {
  if (!json) return fallback;
  try { return JSON.parse(json); } catch { return fallback; }
}
