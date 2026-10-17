import type { BookType } from "./epub.js";
import { ReadingError } from "./reading-error.js";
import { completeReading } from "./reading-model.js";
import { stripVerdicts, verifyQuotes } from "./reading-quotes.js";

export interface NoteQuote {
  text: string;
  chapterIndex: number;
  chapterTitle: string;
}

export interface ChapterNote {
  kind: BookType;
  summary: string;
  corePoints: string[];
  plot: string;
  characters: string[];
  themes: string[];
  quotes: NoteQuote[];
  outline: string;
  droppedQuoteCount: number;
}

export interface ChapterOutline {
  index: number;
  title: string;
  outline: string;
}

export interface BookReport {
  kind: BookType;
  overview: string;
  chapterOutlines: ChapterOutline[];
  corePoints: string[];
  characters: string[];
  themes: string[];
  quotes: NoteQuote[];
}

const NONFICTION_SYSTEM = `你是读书笔记助手。请根据用户给出的章节原文，为非虚构书写笔记。
规则：
- 只依据原文，不要编造。
- 核心观点写 3 到 5 条，每条一句话。
- quotes 里的原句必须从原文逐字复制，不要改写，不要用省略号拼接，尽量给完整句子。
- 不要评价这本书值不值得读，不要写推荐或不推荐。
- 只输出 JSON，不要使用 markdown 代码块。
{"summary":"本章摘要，2到4句","corePoints":["观点"],"quotes":["原文中的句子"],"outline":"一句话大纲"}`;

const FICTION_SYSTEM = `你是读书笔记助手。请根据用户给出的章节原文，为小说写笔记。
规则：
- 只依据原文，不要编造情节。
- plot 概括这一章发生了什么。
- characters 写出本章着重写到的人物，每人一句。
- themes 写这一章触及的主题或洞见。
- quotes 里的金句必须从原文逐字复制，不要改写。
- 不要评价这本书值不值得读，不要写推荐或不推荐。
- 只输出 JSON，不要使用 markdown 代码块。
{"plot":"本章情节，2到4句","characters":["人物：在本章的情况"],"themes":["主题或洞见"],"quotes":["原文中的句子"],"outline":"一句话情节大纲"}`;

const NONFICTION_REPORT_SYSTEM = `你在汇总一本非虚构书已经生成的章节笔记。
规则：
- 只根据给出的笔记，不要编造原句。
- overview 写全书概述，3 到 6 句。
- corePoints 写贯穿全书的观点，3 到 7 条。
- quoteIndexes 只能从给定原句列表里选，最多 8 个，序号从 0 开始。
- 不要评价这本书值不值得读，不要写推荐或不推荐。章节大纲由系统填写，不要另写。
- 只输出 JSON，不要使用 markdown 代码块。
{"overview":"全书概述","corePoints":["观点"],"quoteIndexes":[0]}`;

const FICTION_REPORT_SYSTEM = `你在汇总一本小说已经生成的章节笔记。
规则：
- 只根据给出的笔记，不要编造原句。
- overview 写全书概述，3 到 6 句，侧重故事和人物，不要下值不值得读的结论。
- characters 概括重要人物。
- themes 概括主题和洞见。
- quoteIndexes 只能从给定原句列表里选，最多 8 个，序号从 0 开始。
- 不要评价这本书值不值得读，不要写推荐或不推荐。章节大纲由系统填写，不要另写。
- 只输出 JSON，不要使用 markdown 代码块。
{"overview":"全书概述","characters":["人物"],"themes":["主题"],"quoteIndexes":[0]}`;

let chunkChars = 12_000;

export function setReadingChunkSizeForTests(size: number | null): void {
  chunkChars = size && size > 0 ? size : 12_000;
}

export async function generateChapterNote(bookType: BookType, title: string, chapterIndex: number, text: string): Promise<ChapterNote> {
  const chunks = splitText(text, chunkChars);
  const partials: ChapterNote[] = [];
  for (const chunk of chunks) {
    const note = await withRetry(() => requestChapter(bookType, title, chapterIndex, chunk, chunks.length > 1));
    partials.push(note);
  }
  if (partials.length === 1) return partials[0];
  const merged = await withRetry(() => requestMerge(bookType, title, partials));
  const candidates = partials.flatMap((note) => note.quotes.map((quote) => quote.text));
  const verified = verifyQuotes(candidates, text, 5);
  return {
    ...merged,
    kind: bookType,
    quotes: verified.quotes.map((quote) => ({ text: quote, chapterIndex, chapterTitle: title })),
    droppedQuoteCount: partials.reduce((sum, note) => sum + note.droppedQuoteCount, 0) + verified.dropped,
  };
}

export async function generateBookReport(bookType: BookType, notes: ChapterNote[], titles: string[]): Promise<BookReport> {
  const outlines = notes.map((note, index) => ({
    index,
    title: titles[index] || `第${index + 1}章`,
    outline: note.outline || firstSentence(bookType === "fiction" ? note.plot : note.summary),
  }));
  const pool = notes.flatMap((note) => note.quotes);
  const listed = pool.slice(0, 40);
  const raw = await withRetry(() => completeReading({
    system: bookType === "fiction" ? FICTION_REPORT_SYSTEM : NONFICTION_REPORT_SYSTEM,
    user: reportUser(bookType, outlines, notes, listed),
  }));
  const parsed = expectObject(raw);
  const overview = stripVerdicts(asString(parsed.overview)) || outlines.slice(0, 3).map((item) => item.outline).filter(Boolean).join("");
  const picked = pickQuotes(parsed.quoteIndexes, listed);
  return {
    kind: bookType,
    overview,
    chapterOutlines: outlines,
    corePoints: bookType === "nonfiction" ? cleanList(parsed.corePoints, 7) : [],
    characters: bookType === "fiction" ? cleanList(parsed.characters, 8) : [],
    themes: bookType === "fiction" ? cleanList(parsed.themes, 8) : [],
    quotes: picked,
  };
}

async function requestChapter(bookType: BookType, title: string, chapterIndex: number, text: string, partial: boolean): Promise<ChapterNote> {
  const raw = await completeReading({
    system: bookType === "fiction" ? FICTION_SYSTEM : NONFICTION_SYSTEM,
    user: [`章节标题：${title}`, partial ? "这只是同一章的一个片段，请只处理这一段。" : "下面是这一章的原文。", "<<<CHAPTER", text, "CHAPTER>>>"].join("\n"),
  });
  return parseChapter(bookType, title, chapterIndex, text, raw);
}

async function requestMerge(bookType: BookType, title: string, partials: ChapterNote[]): Promise<ChapterNote> {
  const digest = partials.map((note, index) => {
    const body = bookType === "fiction"
      ? `情节：${note.plot}\n人物：${note.characters.join("；")}\n主题：${note.themes.join("；")}`
      : `摘要：${note.summary}\n观点：${note.corePoints.join("；")}`;
    return `片段${index + 1}\n${body}\n大纲：${note.outline}`;
  }).join("\n\n");
  const raw = await completeReading({
    system: bookType === "fiction" ? FICTION_SYSTEM : NONFICTION_SYSTEM,
    user: `章节标题：${title}\n下面是同一章各部分的笔记，请合成一份。不要新写原句。\n${digest}`,
  });
  const parsed = expectObject(raw);
  const note = fieldsFromParsed(bookType, parsed);
  if (!(bookType === "fiction" ? note.plot : note.summary)) {
    throw new ReadingError("模型没有返回可用的章节笔记。", 502, true);
  }
  return { ...note, kind: bookType, quotes: [], droppedQuoteCount: 0 };
}

function parseChapter(bookType: BookType, title: string, chapterIndex: number, text: string, raw: string): ChapterNote {
  const parsed = expectObject(raw);
  const note = fieldsFromParsed(bookType, parsed);
  const missingBody = bookType === "fiction" ? !note.plot : !note.summary || note.corePoints.length === 0;
  if (missingBody) {
    throw new ReadingError("模型没有返回可用的章节笔记。", 502, true);
  }
  return attachQuotes(bookType, title, chapterIndex, text, asStringArray(parsed.quotes), note, 0);
}

function attachQuotes(bookType: BookType, title: string, chapterIndex: number, text: string, candidates: string[], note: Omit<ChapterNote, "quotes" | "droppedQuoteCount" | "kind">, alreadyDropped: number): ChapterNote {
  const verified = verifyQuotes(candidates, text, 5);
  return {
    kind: bookType,
    summary: note.summary,
    corePoints: note.corePoints,
    plot: note.plot,
    characters: note.characters,
    themes: note.themes,
    outline: note.outline || firstSentence(bookType === "fiction" ? note.plot : note.summary),
    quotes: verified.quotes.map((quote) => ({ text: quote, chapterIndex, chapterTitle: title })),
    droppedQuoteCount: alreadyDropped + verified.dropped,
  };
}

function fieldsFromParsed(bookType: BookType, parsed: Record<string, unknown>) {
  if (bookType === "fiction") {
    return {
      summary: "",
      corePoints: [] as string[],
      plot: stripVerdicts(asString(parsed.plot)),
      characters: cleanList(parsed.characters, 8),
      themes: cleanList(parsed.themes, 6),
      outline: stripVerdicts(asString(parsed.outline)).slice(0, 200),
    };
  }
  return {
    summary: stripVerdicts(asString(parsed.summary)),
    corePoints: cleanList(parsed.corePoints, 5),
    plot: "",
    characters: [] as string[],
    themes: [] as string[],
    outline: stripVerdicts(asString(parsed.outline)).slice(0, 200),
  };
}

function reportUser(bookType: BookType, outlines: ChapterOutline[], notes: ChapterNote[], quotes: NoteQuote[]): string {
  const chapters = notes.map((note, index) => {
    const lines = [`${index + 1}. ${outlines[index]?.title || ""}`, `大纲：${outlines[index]?.outline || ""}`];
    if (bookType === "fiction") {
      lines.push(`情节：${clip(note.plot, 240)}`, `人物：${note.characters.slice(0, 4).join("；")}`, `主题：${note.themes.slice(0, 3).join("；")}`);
    } else {
      lines.push(`摘要：${clip(note.summary, 240)}`, `观点：${note.corePoints.slice(0, 3).join("；")}`);
    }
    return lines.join("\n");
  }).join("\n\n");
  const quoteLines = quotes.map((quote, index) => `[${index}] （${quote.chapterTitle}）${quote.text}`).join("\n");
  return `章节笔记：\n${chapters}\n\n原句列表（只能使用这些序号）：\n${quoteLines || "（没有核对过的原句）"}`;
}

function pickQuotes(value: unknown, pool: NoteQuote[]): NoteQuote[] {
  if (!Array.isArray(value)) return pool.slice(0, 8);
  const picked: NoteQuote[] = [];
  const seen = new Set<number>();
  for (const item of value) {
    const index = Number(item);
    if (!Number.isInteger(index) || index < 0 || index >= pool.length || seen.has(index)) continue;
    seen.add(index);
    picked.push(pool[index]);
    if (picked.length >= 8) break;
  }
  return picked.length > 0 ? picked : pool.slice(0, 8);
}

export function splitText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const paragraphs = text.split(/\n+/);
  const chunks: string[] = [];
  let current = "";
  const push = (block: string) => {
    if (block.length <= size) {
      chunks.push(block);
      return;
    }
    for (let index = 0; index < block.length; index += size) chunks.push(block.slice(index, index + size));
  };
  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) continue;
    if (!current) {
      if (paragraph.length > size) push(paragraph);
      else current = paragraph;
      continue;
    }
    if (`${current}\n${paragraph}`.length > size) {
      push(current);
      current = paragraph.length > size ? "" : paragraph;
      if (paragraph.length > size) push(paragraph);
    } else current = `${current}\n${paragraph}`;
  }
  if (current) push(current);
  return chunks.filter((chunk) => chunk.trim());
}

async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ReadingError && error.retryable) return run();
    throw error;
  }
}

function expectObject(raw: string): Record<string, unknown> {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ReadingError("模型没有返回可用的结果。", 502, true);
  }
  return parsed as Record<string, unknown>;
}

function extractJsonObject(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced?.[1] ?? text;
  for (let start = 0; start < source.length; start++) {
    if (source[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let end = start; end < source.length; end++) {
      const character = source[end];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === "\"") inString = false;
        continue;
      }
      if (character === "\"") inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(source.slice(start, end + 1)); }
          catch { break; }
        }
      }
    }
  }
  return null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [item.trim()];
    if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
      const text = (item as { text: string }).text.trim();
      return text ? [text] : [];
    }
    return [];
  });
}

function cleanList(value: unknown, limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of asStringArray(value)) {
    const cleaned = stripVerdicts(item);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
    if (result.length >= limit) break;
  }
  return result;
}

function firstSentence(text: string): string {
  const match = text.match(/^[^。！？\n]{4,80}[。！？]?/u);
  return (match?.[0] || text).slice(0, 200);
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
