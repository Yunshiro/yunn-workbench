import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, Trash, UploadSimple } from "@phosphor-icons/react";
import { api } from "../lib/api";
import { useEvent } from "../lib/sse";
import type { BookChapter, BookChapterNote, BookDetail, BookReport, BookStatus, BookSummary, BookType } from "../lib/types";
import { EmptyState, ErrorBanner, Spinner, Tag } from "../components/ui";

const STATUS_LABEL: Record<BookStatus, string> = {
  preview: "待确认",
  reading: "生成中",
  error: "未完成",
  done: "已完成",
};

function statusColor(status: BookStatus): "yellow" | "blue" | "red" | "green" {
  if (status === "done") return "green";
  if (status === "error") return "red";
  if (status === "reading") return "blue";
  return "yellow";
}

function formatChars(count: number): string {
  if (count >= 10000) return `${(count / 10000).toFixed(count >= 100000 ? 0 : 1)} 万字`;
  return `${count} 字`;
}

function skippedCount(book: { chapters: { skipped: boolean }[] }): number {
  return book.chapters.filter((chapter) => chapter.skipped).length;
}

function progressRatio(book: BookSummary): number {
  const total = book.chapterCount + 1;
  if (total <= 0) return 0;
  const done = book.doneCount + (book.status === "done" ? 1 : 0);
  return Math.min(1, done / total);
}

export default function BooksView() {
  const [books, setBooks] = useState<BookSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BookDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingSplit, setPendingSplit] = useState<{ kind: "level"; depth: number } | { kind: "spine" } | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [authorDraft, setAuthorDraft] = useState("");
  const [chapterDrafts, setChapterDrafts] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const applyDetail = useCallback((next: BookDetail) => {
    setDetail(next);
    setBooks((current) => {
      if (!current) return [next];
      const exists = current.some((book) => book.id === next.id);
      const rest = current.filter((book) => book.id !== next.id);
      return exists ? current.map((book) => book.id === next.id ? next : book) : [next, ...rest];
    });
  }, []);

  const loadBooks = useCallback(async () => {
    const next = await api.listBooks();
    setBooks(next);
    setSelectedId((current) => current && next.some((book) => book.id === current) ? current : next[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void loadBooks().catch((err) => {
      setError((err as Error).message);
      setBooks([]);
    });
  }, [loadBooks]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void api.getBook(selectedId).then((next) => {
      if (!cancelled) setDetail(next);
    }).catch((err) => {
      if (!cancelled) setError((err as Error).message);
    });
    return () => { cancelled = true; };
  }, [selectedId]);

  useEffect(() => {
    if (!detail) return;
    setTitleDraft(detail.title);
    setAuthorDraft(detail.author);
    const drafts: Record<string, string> = {};
    for (const chapter of detail.chapters) drafts[chapter.id] = chapter.title;
    setChapterDrafts(drafts);
  }, [detail]);

  useEffect(() => {
    if (!detail || detail.status !== "reading") return;
    const timer = window.setInterval(() => {
      void api.getBook(detail.id).then((next) => {
        if (selectedRef.current === next.id) applyDetail(next);
      }).catch(() => {});
    }, 1200);
    return () => window.clearInterval(timer);
  }, [detail?.id, detail?.status, applyDetail]);

  useEvent("book_progress", (data) => {
    const bookId = typeof data?.bookId === "string" ? data.bookId : "";
    if (!bookId) return;
    if (data.status === "deleted") {
      setBooks((current) => current?.filter((book) => book.id !== bookId) ?? null);
      setSelectedId((current) => current === bookId ? null : current);
      setDetail((current) => current?.id === bookId ? null : current);
      return;
    }
    setBooks((current) => current?.map((book) => book.id === bookId
      ? {
          ...book,
          status: data.status ?? book.status,
          doneCount: typeof data.doneCount === "number" ? data.doneCount : book.doneCount,
          chapterCount: typeof data.chapterCount === "number" ? data.chapterCount : book.chapterCount,
          error: typeof data.error === "string" ? data.error : data.error === null ? null : book.error,
        }
      : book) ?? null);
    if (selectedRef.current === bookId) {
      void api.getBook(bookId).then((next) => {
        if (selectedRef.current === bookId) applyDetail(next);
      }).catch(() => {});
    }
  });

  function requestSplit(next: { kind: "level"; depth: number } | { kind: "spine" }) {
    if (!detail) return;
    if (detail.hasManualEdits) {
      setPendingSplit(next);
      return;
    }
    applySplit(next);
  }

  function applySplit(next: { kind: "level"; depth: number } | { kind: "spine" }) {
    if (!detail) return;
    const confirm = detail.hasManualEdits;
    setPendingSplit(null);
    void run(() => next.kind === "spine"
      ? api.useBookHeadings(detail.id, confirm)
      : api.setBookLevel(detail.id, next.depth, confirm));
  }

  function selectBook(id: string) {
    setPendingSplit(null);
    setSelectedId(id);
    setError(null);
  }

  async function run(action: () => Promise<BookDetail | void>, after?: (book: BookDetail | void) => void) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result) applyDetail(result);
      after?.(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleImport(file: File) {
    setBusy(true);
    setError(null);
    try {
      const book = await api.importBook(file);
      applyDetail(book);
      setSelectedId(book.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function saveMeta(patch: { title?: string; author?: string }) {
    if (!detail || detail.confirmed) return;
    const nextTitle = (patch.title ?? titleDraft).trim();
    const nextAuthor = (patch.author ?? authorDraft).trim();
    if (!nextTitle) {
      setTitleDraft(detail.title);
      setError("书名不能为空。");
      return;
    }
    if (nextTitle === detail.title && nextAuthor === detail.author) return;
    await run(() => api.updateBook(detail.id, { title: nextTitle, author: nextAuthor }));
  }

  async function changeType(bookType: BookType) {
    if (!detail || bookType === detail.bookType) return;
    setBusy(true);
    setError(null);
    try {
      applyDetail(await api.updateBook(detail.id, { bookType }));
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("重新生成") && window.confirm(`${message}\n\n清除已有笔记并按新类型重新生成？`)) {
        try {
          applyDetail(await api.updateBook(detail.id, { bookType, rebuild: true }));
        } catch (retry) {
          setError((retry as Error).message);
        }
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(book: BookSummary) {
    if (!window.confirm(`删除《${book.title}》及其全部章节、笔记和报告？此操作不能恢复。`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteBook(book.id);
      setBooks((current) => current?.filter((item) => item.id !== book.id) ?? null);
      setSelectedId((current) => current === book.id ? null : current);
      setDetail((current) => current?.id === book.id ? null : current);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="books fade-in">
      <aside className="book-list">
        <div className="book-list__bar">
          <input
            ref={fileRef}
            className="book-file"
            type="file"
            accept=".epub,application/epub+zip"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleImport(file);
            }}
          />
          <button className="btn btn--primary" type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? <Spinner size={14} /> : <UploadSimple size={15} />}
            导入 epub
          </button>
        </div>
        {books === null && <div className="book-list__hint">正在读取书架…</div>}
        {books?.length === 0 && (
          <EmptyState
            icon={BookOpen}
            title="还没有书"
            desc="导入未加密的 epub。导入后先核对章节，确认后才开始写笔记。"
          />
        )}
        {books?.map((book) => (
          <button
            key={book.id}
            type="button"
            className={`book-card${book.id === selectedId ? " book-card--active" : ""}`}
            onClick={() => selectBook(book.id)}
          >
            <div className="book-card__title">{book.title}</div>
            <div className="book-card__meta">
              <span>{book.author || "佚名"}</span>
              <Tag color={statusColor(book.status)}>{STATUS_LABEL[book.status]}</Tag>
            </div>
            <div className="book-card__meta">
              <span>{book.bookType === "fiction" ? "小说" : "非虚构"}</span>
              <span>{book.doneCount}/{book.chapterCount} 章</span>
            </div>
          </button>
        ))}
      </aside>

      <section className="book-detail">
        {error && <ErrorBanner message={error} />}
        {!detail && books !== null && books.length > 0 && <div className="book-list__hint">选择一本书查看章节。</div>}
        {!detail && books?.length === 0 && (
          <EmptyState
            icon={BookOpen}
            title="从一本书开始"
            desc="导入后会先列出拆好的章节。可以合并相邻章节，或换一层目录再确认。"
          />
        )}
        {detail && (
          <>
            <header className="book-detail__head">
              <div>
                <div className="book-detail__kicker">
                  <Tag color={detail.bookType === "fiction" ? "ink" : "gray"}>{detail.bookType === "fiction" ? "小说" : "非虚构"}</Tag>
                  <Tag color={statusColor(detail.status)}>{STATUS_LABEL[detail.status]}</Tag>
                  {detail.bookTypeSource === "manual" && <Tag>已改类型</Tag>}
                </div>
                {detail.confirmed ? (
                  <h2 className="book-detail__title">{detail.title}</h2>
                ) : (
                  <input
                    className="input book-detail__title-input"
                    value={titleDraft}
                    aria-label="书名"
                    onChange={(event) => setTitleDraft(event.target.value)}
                    onBlur={() => void saveMeta({ title: titleDraft })}
                  />
                )}
                {detail.confirmed ? (
                  <p className="book-detail__author">{detail.author || "佚名"}</p>
                ) : (
                  <input
                    className="input"
                    value={authorDraft}
                    aria-label="作者"
                    placeholder="作者"
                    onChange={(event) => setAuthorDraft(event.target.value)}
                    onBlur={() => void saveMeta({ author: authorDraft })}
                  />
                )}
              </div>
              <div className="book-detail__actions">
                {!detail.confirmed && (
                  <select
                    className="select"
                    aria-label="书籍类型"
                    value={detail.bookType}
                    disabled={busy}
                    onChange={(event) => void changeType(event.target.value as BookType)}
                  >
                    <option value="nonfiction">非虚构</option>
                    <option value="fiction">小说</option>
                  </select>
                )}
                {detail.confirmed && detail.status !== "reading" && (
                  <select
                    className="select"
                    aria-label="书籍类型"
                    value={detail.bookType}
                    disabled={busy}
                    onChange={(event) => void changeType(event.target.value as BookType)}
                  >
                    <option value="nonfiction">非虚构</option>
                    <option value="fiction">小说</option>
                  </select>
                )}
                <button className="btn btn--ghost btn--danger" type="button" disabled={busy || detail.status === "reading"} onClick={() => void handleDelete(detail)}>
                  <Trash size={15} />
                  删除
                </button>
              </div>
            </header>

            <div className="book-progress" aria-label="生成进度">
              <div className="book-progress__track">
                <div className="book-progress__bar" style={{ width: `${Math.round(progressRatio(detail) * 100)}%` }} />
              </div>
              <span>
                {detail.status === "preview"
                  ? `${detail.chapterCount} 章待确认${skippedCount(detail) ? `，跳过 ${skippedCount(detail)} 章` : ""}`
                  : detail.status === "done"
                    ? `已完成 ${detail.chapterCount} 章和全书报告`
                    : `已完成 ${detail.doneCount}/${detail.chapterCount} 章`}
              </span>
            </div>

            {detail.error && <ErrorBanner message={detail.error} />}

            {!detail.confirmed && (
              <div className="book-preview">
                <div className="book-levels" role="group" aria-label="拆分方式">
                  {detail.levels.map((level) => (
                    <button
                      key={level.depth}
                      type="button"
                      className={`book-level${detail.splitSource === "toc" && detail.splitLevel === level.depth ? " book-level--active" : ""}`}
                      disabled={busy || (detail.splitSource === "toc" && detail.splitLevel === level.depth)}
                      onClick={() => requestSplit({ kind: "level", depth: level.depth })}
                    >
                      <span>第 {level.depth + 1} 层 · {level.chapterCount} 章</span>
                      {level.sampleTitle && <span className="book-level__sample">{level.sampleTitle}</span>}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={`book-level${detail.splitSource === "spine" ? " book-level--active" : ""}`}
                    disabled={busy || detail.splitSource === "spine"}
                    onClick={() => requestSplit({ kind: "spine" })}
                  >
                    <span>按正文标题拆</span>
                    <span className="book-level__sample">用最上一层标题，例如章而不是节</span>
                  </button>
                </div>
                {detail.splitSource === "spine" && detail.levels.length === 0 && (
                  <p className="book-hint">没有可用目录，已按正文标题拆分。可以合并相邻章节，或跳过目录和版权页。</p>
                )}
                {detail.splitSource === "spine" && detail.levels.length > 0 && (
                  <p className="book-hint">目录和正文对不上，已按正文标题拆分。也可以改用上面的某一层目录。</p>
                )}
                {detail.numberingWarnings.map((warning) => (
                  <p key={warning} className="book-hint" role="status">{warning}</p>
                ))}
                {detail.hasManualEdits && (
                  <p className="book-hint">切换拆分前会先确认。确认后重新划分章节，刚才的合并、改名和跳过会被清掉，再切回来也不会恢复。</p>
                )}
                <ol className="book-chapters">
                  {detail.chapters.map((chapter, index) => (
                    <li key={chapter.id} className={`book-chapter${chapter.skipped ? " book-chapter--skipped" : ""}`}>
                      <span className="book-chapter__index">{index + 1}</span>
                      <input
                        className="input"
                        aria-label={`章节标题 ${index + 1}`}
                        value={chapterDrafts[chapter.id] ?? chapter.title}
                        onChange={(event) => setChapterDrafts((current) => ({ ...current, [chapter.id]: event.target.value }))}
                        onBlur={() => {
                          const title = (chapterDrafts[chapter.id] ?? chapter.title).trim();
                          if (!title || title === chapter.title) {
                            setChapterDrafts((current) => ({ ...current, [chapter.id]: chapter.title }));
                            return;
                          }
                          void run(() => api.renameBookChapter(detail.id, chapter.id, title));
                        }}
                      />
                      <span className="book-chapter__chars">{chapter.skipped ? "已跳过" : formatChars(chapter.charCount)}</span>
                      <button
                        className="btn btn--ghost btn--sm"
                        type="button"
                        disabled={busy}
                        onClick={() => void run(() => api.setBookChapterSkipped(detail.id, chapter.id, !chapter.skipped))}
                      >
                        {chapter.skipped ? "恢复这章" : "跳过这章"}
                      </button>
                      {index < detail.chapters.length - 1 && (
                        <button
                          className="btn btn--ghost btn--sm"
                          type="button"
                          disabled={busy}
                          onClick={() => void run(() => api.mergeBookChapter(detail.id, chapter.id))}
                        >
                          与下一章合并
                        </button>
                      )}
                    </li>
                  ))}
                </ol>
                <button
                  className="btn btn--primary"
                  type="button"
                  disabled={busy || detail.chapterCount === 0}
                  onClick={() => void run(() => api.confirmBook(detail.id))}
                >
                  {busy ? <Spinner size={14} /> : null}
                  确认章节并开始
                </button>
              </div>
            )}

            {detail.confirmed && (
              <div className="book-generated">
                <div className="book-generated__bar">
                  {detail.status === "reading" && (
                    <span className="book-hint"><Spinner size={14} /> 正在生成，已完成的章节会保留。</span>
                  )}
                  {(detail.status === "error" || (detail.status !== "reading" && detail.doneCount < detail.chapterCount)) && (
                    <button className="btn btn--primary" type="button" disabled={busy} onClick={() => void run(() => api.continueBook(detail.id))}>
                      继续生成
                    </button>
                  )}
                  {detail.doneCount === 0 && detail.status !== "reading" && (
                    <button className="btn btn--ghost" type="button" disabled={busy} onClick={() => void run(() => api.reopenBook(detail.id))}>
                      返回修改章节
                    </button>
                  )}
                </div>
                {detail.report && <ReportView report={detail.report} />}
                <ol className="book-notes">
                  {detail.chapters.map((chapter) => (
                    <ChapterNoteView key={chapter.id} chapter={chapter} />
                  ))}
                </ol>
              </div>
            )}
          </>
        )}
      </section>
      {pendingSplit && (
        <div className="modal-backdrop" onMouseDown={() => setPendingSplit(null)} role="presentation">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="split-reset-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal__head">
              <span className="modal__title" id="split-reset-title">重新划分章节</span>
            </div>
            <div className="modal__body">
              <p>切换拆分会重新划分章节，刚才的合并、改名和跳过会被清掉。再切回来也不会恢复这些修改。</p>
              <div className="board-dialog__actions">
                <button className="btn btn--ghost" type="button" onClick={() => setPendingSplit(null)}>取消</button>
                <button className="btn btn--primary" type="button" onClick={() => applySplit(pendingSplit)}>继续切换</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ChapterNoteView({ chapter }: { chapter: BookChapter }) {
  return (
    <li className="book-note">
      <header className="book-note__head">
        <h3>{chapter.title}</h3>
        <span>{formatChars(chapter.charCount)}</span>
        {chapter.skipped && <Tag>已跳过</Tag>}
        {!chapter.skipped && chapter.noteStatus === "running" && <Tag color="blue">生成中</Tag>}
        {!chapter.skipped && chapter.noteStatus === "pending" && <Tag>待生成</Tag>}
        {!chapter.skipped && chapter.noteStatus === "error" && <Tag color="red">失败</Tag>}
      </header>
      {chapter.noteError && <p className="book-note__error">{chapter.noteError}</p>}
      {!chapter.skipped && chapter.note && <NoteBody note={chapter.note} />}
    </li>
  );
}

function NoteBody({ note }: { note: BookChapterNote }) {
  const fiction = note.kind === "fiction";
  return (
    <div className="book-note__body">
      {fiction ? (
        <>
          {note.plot && <Field label="情节" text={note.plot} />}
          <ListField label="人物" items={note.characters} />
          <ListField label="主题与洞见" items={note.themes} />
        </>
      ) : (
        <>
          {note.summary && <Field label="摘要" text={note.summary} />}
          <ListField label="核心观点" items={note.corePoints} />
        </>
      )}
      <QuoteList quotes={note.quotes} />
      {note.droppedQuoteCount > 0 && (
        <p className="book-hint">已去掉 {note.droppedQuoteCount} 条无法在原文中核对的句子。</p>
      )}
    </div>
  );
}

function ReportView({ report }: { report: BookReport }) {
  const fiction = report.kind === "fiction";
  return (
    <article className="book-report">
      <h3>全书报告</h3>
      {report.overview && <Field label="概述" text={report.overview} />}
      {report.chapterOutlines.length > 0 && (
        <div>
          <div className="book-field__label">章节大纲</div>
          <ol className="book-outlines">
            {report.chapterOutlines.map((item) => (
              <li key={item.index}>
                <strong>{item.title}</strong>
                {item.outline && <span>{item.outline}</span>}
              </li>
            ))}
          </ol>
        </div>
      )}
      {fiction ? (
        <>
          <ListField label="人物" items={report.characters} />
          <ListField label="主题与洞见" items={report.themes} />
        </>
      ) : (
        <ListField label="核心观点" items={report.corePoints} />
      )}
      <QuoteList quotes={report.quotes} />
    </article>
  );
}

function Field({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="book-field__label">{label}</div>
      <p className="book-field__text">{text}</p>
    </div>
  );
}

function ListField({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="book-field__label">{label}</div>
      <ul className="book-points">
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </div>
  );
}

function QuoteList({ quotes }: { quotes: BookChapterNote["quotes"] }) {
  if (quotes.length === 0) return null;
  return (
    <div>
      <div className="book-field__label">原句</div>
      <ul className="book-quotes">
        {quotes.map((quote) => (
          <li key={`${quote.chapterIndex}-${quote.text}`}>
            <blockquote>{quote.text}</blockquote>
            <cite>{quote.chapterTitle}</cite>
          </li>
        ))}
      </ul>
    </div>
  );
}
