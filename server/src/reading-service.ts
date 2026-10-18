import { EventEmitter } from "node:events";
import type { BookType } from "./epub.js";
import { normalizeTitle, parseEpub, splitAtLevel, splitByBodyHeadings } from "./epub.js";
import { ReadingError } from "./reading-error.js";
import {
  clearGenerated,
  deleteBook,
  getBook,
  getBookDetail,
  getToc,
  listBooks,
  insertBook,
  listChaptersWithText,
  listDocuments,
  mergeStoredChapters,
  recoverInterruptedBooks,
  replaceChapters,
  saveChapterNote,
  saveReport,
  setChapterStatus,
  updateBookFields,
  updateChapterSkipped,
  updateChapterTitle,
  type BookDetail,
  type BookSummary,
} from "./reading-db.js";
import { getReadingAccessError } from "./reading-model.js";
import { generateBookReport, generateChapterNote } from "./reading-notes.js";

export const readingEvents = new EventEmitter();

const jobs = new Map<string, Promise<void>>();

export function listLibrary(): BookSummary[] {
  return listBooks();
}

export function getReading(id: string): BookDetail {
  const detail = getBookDetail(id);
  if (!detail) throw new ReadingError("没有找到这本书。", 404);
  return detail;
}

export function importEpubBuffer(data: Buffer): BookDetail {
  if (!Buffer.isBuffer(data) || data.length === 0) throw new ReadingError("请上传 epub 文件。");
  const parsed = parseEpub(data);
  if (parsed.chapters.length === 0) throw new ReadingError("没有从这本书里拆出可阅读的章节。");
  return insertBook({
    title: parsed.title,
    author: parsed.author,
    language: parsed.language,
    bookType: parsed.bookType,
    splitSource: parsed.splitSource,
    splitLevel: parsed.selectedLevel,
    levels: parsed.levels,
    toc: parsed.toc,
    documents: parsed.documents,
    chapters: parsed.chapters,
  });
}

export function updateReading(id: string, patch: {
  title?: string;
  author?: string;
  bookType?: BookType;
  rebuild?: boolean;
}): BookDetail {
  const book = requireBook(id);
  const next: { title?: string; author?: string; bookType?: BookType; bookTypeSource?: "auto" | "manual" } = {};
  if (typeof patch.title === "string") {
    const title = normalizeTitle(patch.title);
    if (!title) throw new ReadingError("书名不能为空。");
    next.title = title;
  }
  if (typeof patch.author === "string") next.author = normalizeTitle(patch.author).slice(0, 200);
  if (patch.bookType) {
    if (patch.bookType !== "fiction" && patch.bookType !== "nonfiction") throw new ReadingError("书籍类型只能是小说或非虚构。");
    if (patch.bookType !== book.bookType && book.confirmed && book.doneCount > 0 && !patch.rebuild) {
      throw new ReadingError("已有笔记是按原来的类型生成的。确认后会清除，并按新类型重新生成。", 409);
    }
    next.bookType = patch.bookType;
    next.bookTypeSource = "manual";
  }
  if (Object.keys(next).length > 0) updateBookFields(id, next);
  if (patch.bookType && patch.bookType !== book.bookType && book.confirmed && book.doneCount > 0 && patch.rebuild) {
    if (jobs.has(id)) throw new ReadingError("这本书正在生成，请等它停下来再改类型。", 409);
    clearGenerated(id);
    updateBookFields(id, { status: "reading", error: null });
    void startReading(id);
  }
  return getReading(id);
}

export function renameReadingChapter(bookId: string, chapterId: string, title: string): BookDetail {
  const book = requireBook(bookId);
  assertEditable(book);
  const cleaned = normalizeTitle(title);
  if (!cleaned) throw new ReadingError("章节标题不能为空。");
  const chapter = listChaptersWithText(bookId).find((item) => item.id === chapterId);
  if (!chapter) throw new ReadingError("没有找到这一章。", 404);
  updateChapterTitle(chapterId, cleaned);
  return getReading(bookId);
}

export function mergeReadingChapter(bookId: string, chapterId: string): BookDetail {
  const book = requireBook(bookId);
  assertEditable(book);
  const merged = mergeStoredChapters(bookId, chapterId, listDocuments(bookId));
  if (!merged) throw new ReadingError("只能把相邻的后一章并进来，最后一章不能再合并。");
  return getReading(bookId);
}

export function switchReadingLevel(bookId: string, depth: number, confirm = false): BookDetail {
  const book = requireBook(bookId);
  assertEditable(book);
  assertSplitConfirmed(bookId, confirm);
  if (!Number.isInteger(depth) || depth < 0) throw new ReadingError("目录层级不正确。");
  const level = book.levels.find((item) => item.depth === depth);
  if (!level) throw new ReadingError("没有这个目录层级。可以改为按正文标题拆。");
  const documents = storedDocuments(bookId);
  const chapters = splitAtLevel(documents, getToc(bookId), depth);
  if (chapters.length === 0) throw new ReadingError("这一层目录没有拆出可阅读的章节。");
  replaceChapters(bookId, { source: "toc", level: depth }, chapters);
  return getReading(bookId);
}

export function switchReadingToHeadings(bookId: string, confirm = false): BookDetail {
  const book = requireBook(bookId);
  assertEditable(book);
  assertSplitConfirmed(bookId, confirm);
  const chapters = splitByBodyHeadings(storedDocuments(bookId));
  if (chapters.length === 0) throw new ReadingError("没有从正文标题里拆出章节。");
  replaceChapters(bookId, { source: "spine", level: null }, chapters);
  return getReading(bookId);
}

export function setReadingChapterSkipped(bookId: string, chapterId: string, skipped: boolean): BookDetail {
  const book = requireBook(bookId);
  assertEditable(book);
  const chapter = listChaptersWithText(bookId).find((item) => item.id === chapterId);
  if (!chapter) throw new ReadingError("没有找到这一章。", 404);
  updateChapterSkipped(chapterId, skipped);
  return getReading(bookId);
}

function storedDocuments(bookId: string) {
  return listDocuments(bookId).map((document) => ({
    href: document.href,
    text: document.text,
    anchors: document.anchors,
    headings: document.headings,
  }));
}

export function confirmReading(id: string): BookDetail {
  const book = requireBook(id);
  if (!book.confirmed) {
    if (book.chapterCount === 0) throw new ReadingError("还没有可生成的章节。");
    updateBookFields(id, { confirmed: true });
  }
  const problem = getReadingAccessError();
  if (problem) {
    updateBookFields(id, { status: "error", error: problem });
    emit(id);
    return getReading(id);
  }
  if (getBook(id)?.status !== "done") {
    updateBookFields(id, { status: "reading", error: null });
    void startReading(id);
  }
  return getReading(id);
}

export function continueReading(id: string): BookDetail {
  const book = requireBook(id);
  if (!book.confirmed) throw new ReadingError("请先确认章节，再开始生成笔记。");
  if (book.status === "done") return getReading(id);
  const problem = getReadingAccessError();
  if (problem) {
    updateBookFields(id, { status: "error", error: problem });
    emit(id);
    return getReading(id);
  }
  updateBookFields(id, { status: "reading", error: null });
  void startReading(id);
  return getReading(id);
}

export function reopenReading(id: string): BookDetail {
  const book = requireBook(id);
  if (jobs.has(id) || book.status === "reading") throw new ReadingError("这本书正在生成，不能返回修改章节。", 409);
  if (book.doneCount > 0) throw new ReadingError("已经有章节生成过笔记。继续会沿用现在的章节，不会重跑已完成的部分。", 409);
  clearGenerated(id);
  updateBookFields(id, { confirmed: false, status: "preview", error: null });
  emit(id);
  return getReading(id);
}

export function removeReading(id: string): void {
  if (jobs.has(id)) throw new ReadingError("这本书正在生成，请等它停下来再删除。", 409);
  if (!deleteBook(id)) throw new ReadingError("没有找到这本书。", 404);
  readingEvents.emit("book_progress", { bookId: id, status: "deleted", doneCount: 0, chapterCount: 0, error: null });
}

export function recoverInterruptedReading(): number {
  return recoverInterruptedBooks();
}

export function startReading(bookId: string): Promise<void> {
  const existing = jobs.get(bookId);
  if (existing) return existing;
  const job = runReading(bookId).finally(() => jobs.delete(bookId));
  jobs.set(bookId, job);
  return job;
}

async function runReading(bookId: string): Promise<void> {
  const book = getBook(bookId);
  if (!book || !book.confirmed) return;
  const problem = getReadingAccessError();
  if (problem) {
    updateBookFields(bookId, { status: "error", error: problem });
    emit(bookId);
    return;
  }
  updateBookFields(bookId, { status: "reading", error: null });
  emit(bookId);
  const chapters = listChaptersWithText(bookId).filter((chapter) => !chapter.skipped);
  if (chapters.length === 0) {
    updateBookFields(bookId, { status: "error", error: "没有可生成的章节。请先恢复被跳过的章节。" });
    emit(bookId);
    return;
  }
  for (const chapter of chapters) {
    if (chapter.noteStatus === "done" && chapter.note) continue;
    try {
      setChapterStatus(chapter.id, "running", null);
      emit(bookId);
      const current = getBook(bookId);
      const note = await generateChapterNote(current?.bookType || book.bookType, chapter.title, chapter.position, chapter.text);
      saveChapterNote(bookId, chapter.id, note);
      emit(bookId);
    } catch (error) {
      const message = messageOf(error);
      setChapterStatus(chapter.id, "error", message);
      updateBookFields(bookId, { status: "error", error: message });
      emit(bookId);
      return;
    }
  }
  const finished = listChaptersWithText(bookId).filter((chapter) => !chapter.skipped);
  const latest = getBook(bookId);
  if (!latest) return;
  if (finished.some((chapter) => chapter.noteStatus !== "done" || !chapter.note)) {
    updateBookFields(bookId, { status: "error", error: latest.error || "还有章节没有生成笔记。" });
    emit(bookId);
    return;
  }
  try {
    const report = await generateBookReport(
      latest.bookType,
      finished.map((chapter) => chapter.note!),
      finished.map((chapter) => chapter.title),
    );
    saveReport(bookId, report);
    updateBookFields(bookId, { status: "done", error: null });
    emit(bookId);
  } catch (error) {
    updateBookFields(bookId, { status: "error", error: messageOf(error) });
    emit(bookId);
  }
}

function requireBook(id: string): BookSummary {
  const book = getBook(id);
  if (!book) throw new ReadingError("没有找到这本书。", 404);
  return book;
}

function assertEditable(book: BookSummary): void {
  if (book.confirmed || book.status === "reading") {
    throw new ReadingError("章节已经确认，不能再改划分。还没生成完的章节可以继续，已完成的不会重跑。", 409);
  }
}

function assertSplitConfirmed(bookId: string, confirm: boolean): void {
  const detail = getBookDetail(bookId);
  if (detail?.hasManualEdits && !confirm) {
    throw new ReadingError("章节已有手动修改。切换拆分会清掉合并、改名和跳过，请确认后再切换。", 409);
  }
}

function emit(bookId: string): void {
  const book = getBook(bookId);
  if (!book) return;
  readingEvents.emit("book_progress", {
    bookId,
    status: book.status,
    doneCount: book.doneCount,
    chapterCount: book.chapterCount,
    error: book.error,
  });
}

function messageOf(error: unknown): string {
  if (error instanceof ReadingError) return error.message;
  return String((error as Error).message || error).slice(0, 300);
}
