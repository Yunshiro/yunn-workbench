import { randomUUID } from "node:crypto";
import { chapterNumberWarnings, type BookType, type ParsedChapter, type ParsedDocument, type SplitLevel, type SplitSource, type TocNode } from "./epub.js";
import type { BookReport, ChapterNote } from "./reading-notes.js";
import { db } from "./db.js";

export type BookStatus = "preview" | "reading" | "error" | "done";
export type NoteStatus = "pending" | "running" | "done" | "error";

export interface BookLevelView {
  depth: number;
  chapterCount: number;
  sampleTitle: string;
}

export interface BookSummary {
  id: string;
  title: string;
  author: string;
  language: string;
  bookType: BookType;
  bookTypeSource: "auto" | "manual";
  status: BookStatus;
  error: string | null;
  splitSource: SplitSource;
  splitLevel: number | null;
  levels: BookLevelView[];
  confirmed: boolean;
  chapterCount: number;
  doneCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface BookChapterView {
  id: string;
  position: number;
  title: string;
  charCount: number;
  noteStatus: NoteStatus;
  noteError: string | null;
  skipped: boolean;
  note: ChapterNote | null;
}

export interface BookDetail extends BookSummary {
  chapters: BookChapterView[];
  report: BookReport | null;
  numberingWarnings: string[];
}

export interface StoredDocument {
  position: number;
  href: string;
  text: string;
  anchors: { id: string; offset: number }[];
  headings: { offset: number; text: string; level: number }[];
}

export interface StoredChapter extends BookChapterView {
  startDoc: number;
  startOffset: number;
  endDoc: number;
  endOffset: number;
  text: string;
}

interface NewBook {
  title: string;
  author: string;
  language: string;
  bookType: BookType;
  splitSource: SplitSource;
  splitLevel: number | null;
  levels: SplitLevel[];
  toc: TocNode[];
  documents: ParsedDocument[];
  chapters: ParsedChapter[];
}

export function listBooks(): BookSummary[] {
  const rows = db.prepare(`
    SELECT b.*,
      (SELECT COUNT(*) FROM book_chapters c WHERE c.book_id = b.id AND c.skipped = 0) AS chapter_count,
      (SELECT COUNT(*) FROM book_chapters c WHERE c.book_id = b.id AND c.skipped = 0 AND c.note_status = 'done') AS done_count
    FROM books b
    ORDER BY b.updated_at DESC
  `).all() as any[];
  return rows.map(rowToSummary);
}

export function getBook(id: string): BookSummary | null {
  const row = db.prepare(`
    SELECT b.*,
      (SELECT COUNT(*) FROM book_chapters c WHERE c.book_id = b.id AND c.skipped = 0) AS chapter_count,
      (SELECT COUNT(*) FROM book_chapters c WHERE c.book_id = b.id AND c.skipped = 0 AND c.note_status = 'done') AS done_count
    FROM books b WHERE b.id = ?
  `).get(id) as any;
  return row ? rowToSummary(row) : null;
}

export function getBookDetail(id: string): BookDetail | null {
  const book = getBook(id);
  if (!book) return null;
  const chapters = listChapterViews(id);
  return {
    ...book,
    chapters,
    report: getReport(id),
    numberingWarnings: chapterNumberWarnings(chapters.map((chapter) => chapter.title)),
  };
}

export function listChapterViews(bookId: string): BookChapterView[] {
  const rows = db.prepare(`
    SELECT c.id, c.position, c.title, c.char_count, c.note_status, c.note_error, c.skipped, n.content_json AS note_json
    FROM book_chapters c
    LEFT JOIN book_notes n ON n.chapter_id = c.id AND n.kind = 'chapter'
    WHERE c.book_id = ?
    ORDER BY c.position ASC
  `).all(bookId) as any[];
  return rows.map(rowToChapter);
}

export function listChaptersWithText(bookId: string): StoredChapter[] {
  const rows = db.prepare(`
    SELECT c.*, n.content_json AS note_json
    FROM book_chapters c
    LEFT JOIN book_notes n ON n.chapter_id = c.id AND n.kind = 'chapter'
    WHERE c.book_id = ?
    ORDER BY c.position ASC
  `).all(bookId) as any[];
  return rows.map((row) => ({
    ...rowToChapter(row),
    startDoc: Number(row.start_doc),
    startOffset: Number(row.start_offset),
    endDoc: Number(row.end_doc),
    endOffset: Number(row.end_offset),
    text: String(row.text || ""),
  }));
}

export function listDocuments(bookId: string): StoredDocument[] {
  const rows = db.prepare("SELECT * FROM book_documents WHERE book_id = ? ORDER BY position ASC").all(bookId) as any[];
  return rows.map((row) => ({
    position: Number(row.position),
    href: String(row.href),
    text: String(row.text || ""),
    anchors: parseJson(row.anchors_json, []),
    headings: parseJson<Array<{ offset: number; text: string; level?: number }>>(row.headings_json, []).map((heading) => ({
      offset: Number(heading.offset) || 0,
      text: String(heading.text || ""),
      level: Number(heading.level) || 9,
    })),
  }));
}

export function getToc(bookId: string): TocNode[] {
  const row = db.prepare("SELECT toc_json FROM books WHERE id = ?").get(bookId) as any;
  return row ? parseJson(row.toc_json, []) : [];
}

export function getReport(bookId: string): BookReport | null {
  const row = db.prepare("SELECT content_json FROM book_notes WHERE book_id = ? AND kind = 'report' LIMIT 1").get(bookId) as any;
  return row ? parseJson(row.content_json, null) : null;
}

export function insertBook(input: NewBook): BookDetail {
  const id = randomUUID();
  const now = Date.now();
  transaction(() => {
    db.prepare(`
      INSERT INTO books (
        id, title, author, language, book_type, book_type_source, status, error,
        split_source, split_level, levels_json, toc_json, confirmed, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'auto', 'preview', NULL, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      id,
      input.title,
      input.author,
      input.language,
      input.bookType,
      input.splitSource,
      input.splitLevel,
      JSON.stringify(input.levels),
      JSON.stringify(input.toc),
      now,
      now,
    );
    insertDocuments(id, input.documents);
    insertChapters(id, input.chapters, now);
  });
  return getBookDetail(id)!;
}

export function replaceChapters(bookId: string, split: { source: SplitSource; level: number | null }, chapters: ParsedChapter[]): void {
  const now = Date.now();
  transaction(() => {
    db.prepare("DELETE FROM book_chapters WHERE book_id = ?").run(bookId);
    insertChapters(bookId, chapters, now);
    db.prepare("UPDATE books SET split_source = ?, split_level = ?, updated_at = ? WHERE id = ?").run(split.source, split.level, now, bookId);
  });
}

export function updateBookFields(id: string, fields: {
  title?: string;
  author?: string;
  bookType?: BookType;
  bookTypeSource?: "auto" | "manual";
  status?: BookStatus;
  error?: string | null;
  confirmed?: boolean;
}): void {
  const current = db.prepare("SELECT * FROM books WHERE id = ?").get(id) as any;
  if (!current) return;
  db.prepare(`
    UPDATE books
    SET title = ?, author = ?, book_type = ?, book_type_source = ?, status = ?, error = ?, confirmed = ?, updated_at = ?
    WHERE id = ?
  `).run(
    fields.title ?? current.title,
    fields.author ?? current.author,
    fields.bookType ?? current.book_type,
    fields.bookTypeSource ?? current.book_type_source,
    fields.status ?? current.status,
    fields.error === undefined ? current.error : fields.error,
    fields.confirmed === undefined ? current.confirmed : fields.confirmed ? 1 : 0,
    Date.now(),
    id,
  );
}

export function updateChapterTitle(id: string, title: string): void {
  db.prepare("UPDATE book_chapters SET title = ?, updated_at = ? WHERE id = ?").run(title, Date.now(), id);
}

export function updateChapterSkipped(id: string, skipped: boolean): void {
  db.prepare("UPDATE book_chapters SET skipped = ?, updated_at = ? WHERE id = ?").run(skipped ? 1 : 0, Date.now(), id);
}

export function setChapterStatus(id: string, status: NoteStatus, error: string | null): void {
  db.prepare("UPDATE book_chapters SET note_status = ?, note_error = ?, updated_at = ? WHERE id = ?").run(status, error, Date.now(), id);
}

export function saveChapterNote(bookId: string, chapterId: string, note: ChapterNote): void {
  const now = Date.now();
  transaction(() => {
    db.prepare("DELETE FROM book_notes WHERE chapter_id = ?").run(chapterId);
    db.prepare(`
      INSERT INTO book_notes (id, book_id, chapter_id, kind, content_json, created_at, updated_at)
      VALUES (?, ?, ?, 'chapter', ?, ?, ?)
    `).run(randomUUID(), bookId, chapterId, JSON.stringify(note), now, now);
    db.prepare("UPDATE book_chapters SET note_status = 'done', note_error = NULL, updated_at = ? WHERE id = ?").run(now, chapterId);
  });
}

export function saveReport(bookId: string, report: BookReport): void {
  const now = Date.now();
  transaction(() => {
    db.prepare("DELETE FROM book_notes WHERE book_id = ? AND kind = 'report'").run(bookId);
    db.prepare(`
      INSERT INTO book_notes (id, book_id, chapter_id, kind, content_json, created_at, updated_at)
      VALUES (?, ?, NULL, 'report', ?, ?, ?)
    `).run(randomUUID(), bookId, JSON.stringify(report), now, now);
  });
}

export function clearGenerated(bookId: string): void {
  const now = Date.now();
  transaction(() => {
    db.prepare("DELETE FROM book_notes WHERE book_id = ?").run(bookId);
    db.prepare("UPDATE book_chapters SET note_status = 'pending', note_error = NULL, updated_at = ? WHERE book_id = ?").run(now, bookId);
  });
}

export function mergeStoredChapters(bookId: string, chapterId: string, documents: StoredDocument[]): StoredChapter | null {
  const chapters = listChaptersWithText(bookId);
  const index = chapters.findIndex((chapter) => chapter.id === chapterId);
  if (index < 0 || index === chapters.length - 1) return null;
  const current = chapters[index];
  const next = chapters[index + 1];
  const text = normalizeJoined(documents, current, next);
  const now = Date.now();
  transaction(() => {
    db.prepare(`
      UPDATE book_chapters
      SET end_doc = ?, end_offset = ?, text = ?, char_count = ?, updated_at = ?
      WHERE id = ?
    `).run(next.endDoc, next.endOffset, text, [...text].length, now, current.id);
    db.prepare("DELETE FROM book_chapters WHERE id = ?").run(next.id);
    const remaining = db.prepare("SELECT id FROM book_chapters WHERE book_id = ? ORDER BY position ASC").all(bookId) as any[];
    remaining.forEach((row, position) => {
      db.prepare("UPDATE book_chapters SET position = ?, updated_at = ? WHERE id = ?").run(position, now, row.id);
    });
  });
  return listChaptersWithText(bookId).find((chapter) => chapter.id === chapterId) ?? null;
}

export function deleteBook(id: string): boolean {
  const result = db.prepare("DELETE FROM books WHERE id = ?").run(id);
  const deleted = Number(result.changes) > 0;
  if (deleted) {
    db.exec("VACUUM");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  return deleted;
}

export function recoverInterruptedBooks(): number {
  const now = Date.now();
  db.prepare("UPDATE book_chapters SET note_status = 'pending', note_error = NULL, updated_at = ? WHERE note_status = 'running'").run(now);
  const result = db.prepare(`
    UPDATE books
    SET status = 'error', error = ?, updated_at = ?
    WHERE status = 'reading'
  `).run("上次生成被中断，已完成的章节会保留，可以继续。", now);
  return Number(result.changes);
}

function insertDocuments(bookId: string, documents: ParsedDocument[]): void {
  const statement = db.prepare(`
    INSERT INTO book_documents (id, book_id, position, href, text, anchors_json, headings_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  documents.forEach((document, position) => {
    statement.run(
      randomUUID(),
      bookId,
      position,
      document.href,
      document.text,
      JSON.stringify(document.anchors),
      JSON.stringify(document.headings),
    );
  });
}

function insertChapters(bookId: string, chapters: ParsedChapter[], now: number): void {
  const statement = db.prepare(`
    INSERT INTO book_chapters (
      id, book_id, position, title, start_doc, start_offset, end_doc, end_offset,
      text, char_count, note_status, note_error, skipped, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?)
  `);
  chapters.forEach((chapter, position) => {
    statement.run(
      randomUUID(),
      bookId,
      position,
      chapter.title,
      chapter.startDoc,
      chapter.startOffset,
      chapter.endDoc,
      chapter.endOffset,
      chapter.text,
      [...chapter.text].length,
      chapter.skipped ? 1 : 0,
      now,
      now,
    );
  });
}

function normalizeJoined(documents: StoredDocument[], current: StoredChapter, next: StoredChapter): string {
  const docs = documents.map((document) => ({ text: document.text }));
  const start = { doc: current.startDoc, offset: current.startOffset };
  const end = { doc: next.endDoc, offset: next.endOffset };
  if (start.doc < 0 || end.doc >= docs.length) return `${current.text}\n\n${next.text}`.trim();
  const parts: string[] = [];
  if (start.doc === end.doc) parts.push(docs[start.doc].text.slice(start.offset, end.offset));
  else {
    parts.push(docs[start.doc].text.slice(start.offset));
    for (let index = start.doc + 1; index < end.doc && index < docs.length; index++) parts.push(docs[index].text);
    if (end.offset > 0 && end.doc < docs.length) parts.push(docs[end.doc].text.slice(0, end.offset));
  }
  return parts.join("\n").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function transaction(run: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    run();
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* 已回滚 */ }
    throw error;
  }
}

function rowToSummary(row: any): BookSummary {
  return {
    id: row.id,
    title: row.title,
    author: row.author || "",
    language: row.language || "",
    bookType: row.book_type === "fiction" ? "fiction" : "nonfiction",
    bookTypeSource: row.book_type_source === "manual" ? "manual" : "auto",
    status: row.status,
    error: row.error ?? null,
    splitSource: row.split_source === "spine" ? "spine" : "toc",
    splitLevel: row.split_level === null || row.split_level === undefined ? null : Number(row.split_level),
    levels: parseJson(row.levels_json, []),
    confirmed: Number(row.confirmed) === 1,
    chapterCount: Number(row.chapter_count || 0),
    doneCount: Number(row.done_count || 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToChapter(row: any): BookChapterView {
  return {
    id: row.id,
    position: Number(row.position),
    title: row.title,
    charCount: Number(row.char_count || 0),
    noteStatus: row.note_status,
    noteError: row.note_error ?? null,
    skipped: Number(row.skipped) === 1,
    note: row.note_json ? parseJson(row.note_json, null) : null,
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try { return JSON.parse(value) as T; }
  catch { return fallback; }
}
