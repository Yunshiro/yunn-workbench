import { inflateRawSync } from "node:zlib";
import { posix } from "node:path";
import { ReadingError } from "./reading-error.js";

export type BookType = "fiction" | "nonfiction";
export type SplitSource = "toc" | "spine";

export interface TocNode {
  title: string;
  href: string | null;
  fragment: string | null;
  children: TocNode[];
}

export interface TextAnchor {
  id: string;
  offset: number;
}

export interface TextHeading {
  offset: number;
  text: string;
  /** 1–3 来自 h1–h3，9 表示普通段落里识别出的标题。 */
  level: number;
}

export interface ParsedDocument {
  href: string;
  text: string;
  anchors: TextAnchor[];
  headings: TextHeading[];
}

export interface TextPosition {
  doc: number;
  offset: number;
}

export interface ParsedChapter {
  title: string;
  startDoc: number;
  startOffset: number;
  endDoc: number;
  endOffset: number;
  text: string;
  skipped: boolean;
}

export interface SplitLevel {
  depth: number;
  chapterCount: number;
  sampleTitle: string;
}

export interface ParsedEpub {
  title: string;
  author: string;
  language: string;
  bookType: BookType;
  splitSource: SplitSource;
  levels: SplitLevel[];
  selectedLevel: number | null;
  /** 章号不连续时的非阻断提示，例如「第十回可能缺失」。不阻止导入。 */
  numberingWarnings: string[];
  documents: ParsedDocument[];
  toc: TocNode[];
  chapters: ParsedChapter[];
}

const MIN_CHAPTER_CHARS = 24;
const MAX_UNCOMPRESSED_FILE = 8 * 1024 * 1024;
const MAX_UNCOMPRESSED_TOTAL = 48 * 1024 * 1024;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  bull: "•",
  copy: "©",
};

interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

/**
 * 拆章节只看 epub 自带的目录、spine 顺序和正文里的章节标题。
 * 不根据书名或文件名做特例。
 */
export function parseEpub(data: Buffer): ParsedEpub {
  const files = unzipEpub(data);
  assertReadable(files);
  const container = readText(files, "META-INF/container.xml");
  if (!container) throw corrupt();
  const opfPath = containerPath(container);
  const opfText = readText(files, opfPath);
  if (!opfText) throw corrupt();
  const opfDir = posix.dirname(opfPath);
  const baseDir = opfDir === "." ? "" : opfDir;
  const opf = parsePackage(opfText, baseDir);
  if (opf.spine.length === 0) throw new ReadingError("这本 epub 里没有可阅读的正文。");

  const documents = opf.spine.map((href) => {
    const html = readText(files, href);
    if (html === undefined) throw corrupt();
    const extracted = extractHtml(html);
    return { href, ...extracted };
  });
  if (!documents.some((document) => document.text.trim().length >= MIN_CHAPTER_CHARS)) {
    throw new ReadingError("这本 epub 里没有可阅读的正文。");
  }

  const toc = readToc(files, opf);
  const planned = planSplits(documents, toc);
  const meta = `${opf.subjects}\n${opf.description}`;
  return {
    title: cleanBookTitle(opf.title),
    author: opf.author,
    language: opf.language,
    bookType: detectBookType(planned.chapters.map((chapter) => chapter.title), meta),
    splitSource: planned.source,
    levels: planned.levels,
    selectedLevel: planned.selectedLevel,
    numberingWarnings: planned.numberingWarnings,
    documents,
    toc,
    chapters: planned.chapters,
  };
}

export function splitAtLevel(documents: ParsedDocument[], toc: TocNode[], depth: number): ParsedChapter[] {
  const level = buildLevel(documents, toc, depth);
  if (!level || level.resolved / Math.max(level.cuts, 1) < 0.5 || level.chapters.length === 0) {
    throw new ReadingError("这一层目录对不上正文，换一层或改为按正文标题拆。");
  }
  return level.chapters;
}

/** 按正文里的章节标题拆。有多层标题时只切最上面一层，例如章，而不是章下面的节。 */
export function splitByBodyHeadings(documents: ParsedDocument[]): ParsedChapter[] {
  return chaptersFromSpine(documents);
}

export function planSplits(documents: ParsedDocument[], toc: TocNode[]): {
  source: SplitSource;
  levels: SplitLevel[];
  selectedLevel: number | null;
  chapters: ParsedChapter[];
  numberingWarnings: string[];
} {
  const spineChapters = chaptersFromSpine(documents);
  if (toc.length === 0) {
    return planResult("spine", [], null, spineChapters);
  }
  const maxDepth = treeDepth(toc);
  const built: Array<{ depth: number; chapters: ParsedChapter[]; cuts: number; resolved: number }> = [];
  for (let depth = 0; depth <= maxDepth; depth++) {
    const level = buildLevel(documents, toc, depth);
    if (!level) continue;
    if (level.cuts === 0 || level.resolved / level.cuts < 0.5 || level.chapters.length === 0) continue;
    built.push({ depth, ...level });
  }
  if (built.length === 0) {
    return planResult("spine", [], null, spineChapters);
  }
  let best = built[0];
  let bestScore = scoreChapters(best.chapters);
  for (const level of built.slice(1)) {
    const score = scoreChapters(level.chapters);
    if (score > bestScore) {
      best = level;
      bestScore = score;
    }
  }
  const totalChars = documents.reduce((sum, document) => sum + [...document.text].length, 0);
  const useSpine = isPoorSplit(best.chapters, spineChapters, totalChars);
  return planResult(
    useSpine ? "spine" : "toc",
    built.map((level) => ({
      depth: level.depth,
      chapterCount: level.chapters.length,
      sampleTitle: sampleTitle(level.chapters),
    })),
    useSpine ? null : best.depth,
    useSpine ? spineChapters : best.chapters,
  );
}

function planResult(
  source: SplitSource,
  levels: SplitLevel[],
  selectedLevel: number | null,
  chapters: ParsedChapter[],
): {
  source: SplitSource;
  levels: SplitLevel[];
  selectedLevel: number | null;
  chapters: ParsedChapter[];
  numberingWarnings: string[];
} {
  return {
    source,
    levels,
    selectedLevel,
    chapters,
    numberingWarnings: chapterNumberWarnings(chapters.map((chapter) => chapter.title)),
  };
}

function isPoorSplit(chapters: ParsedChapter[], spineChapters: ParsedChapter[], totalChars: number): boolean {
  const covered = chapters.reduce((sum, chapter) => sum + [...chapter.text].length, 0);
  if (totalChars > 0 && covered / totalChars < 0.9) return true;
  return spineChapters.length >= 4 && chapters.length * 2 < spineChapters.length;
}

export function cleanBookTitle(raw: string): string {
  let title = raw.replace(/\u3000/g, " ").replace(/\s+/g, " ").trim();
  title = title.replace(/^[【\[][^】\]]{1,30}[】\]]\s*/g, "").trim();
  title = title.replace(/[（(][^（）()]{0,120}[）)]/g, (match) => {
    if (/[!！]|出品|出版|畅销|推荐|新版|经典|改编|电视|电影|热播|必读|精校|珍藏/.test(match)) return "";
    if (match.length > 30) return "";
    return match;
  }).replace(/\s+/g, " ").trim();

  const parts = title.split(/\s*[:：]\s*/).filter(Boolean);
  if (parts.length >= 2) {
    const left = parts[0];
    const right = parts.slice(1).join("：");
    const marketing = /经典|丛书|系列|出品|出版|畅销|推荐|新版|珍藏|精校|全译|原版|根据|改编|电视剧|电影|热播|影响最大|豆瓣|爆款|必读/;
    const leftMarketing = marketing.test(left) && left.length <= 16;
    const rightMarketing = marketing.test(right);
    if (leftMarketing && !rightMarketing) title = right;
    else if (rightMarketing && left.length >= 1 && left.length <= 40) title = left;
  }

  const quoted = [...title.matchAll(/《([^》]{1,30})》/g)].map((match) => match[1]);
  const repeated = quoted.find((name) => title.replace(`《${name}》`, "").includes(name));
  if (repeated && /[!！]|经典|出品|新版|根据|改编|电视/.test(title)) title = repeated;
  title = title.replace(/\s+/g, " ").trim();
  return title || raw.trim();
}

export function detectBookType(titles: string[], meta: string): BookType {
  if (/小说|长篇小说|虚构小说|\bnovel\b|\bfiction\b/i.test(meta)) return "fiction";
  const bare = titles.filter((title) => /^第\s*[0-9０-９一二三四五六七八九十百千零〇○◯ＯｏOo两廿卅]+\s*[章回]$/u.test(title.trim()));
  if (titles.length >= 8 && bare.length / titles.length >= 0.6) return "fiction";
  return "nonfiction";
}

export function normalizeTitle(title: string): string {
  return title.replace(/\u3000/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

export function sliceDocuments(documents: { text: string }[], start: TextPosition, end: TextPosition): string {
  if (start.doc < 0 || start.doc >= documents.length || comparePosition(end, start) <= 0) return "";
  if (start.doc === end.doc) return documents[start.doc].text.slice(start.offset, end.offset);
  const parts = [documents[start.doc].text.slice(start.offset)];
  for (let index = start.doc + 1; index < end.doc && index < documents.length; index++) parts.push(documents[index].text);
  if (end.doc < documents.length && end.offset > 0) parts.push(documents[end.doc].text.slice(0, end.offset));
  return parts.join("\n");
}

export function normalizeChapterText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\u3000/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function corrupt(): ReadingError {
  return new ReadingError("这个文件不是有效的 epub，或已经损坏。");
}

function chapterTitleScore(title: string): number {
  const text = title.trim();
  if (/第\s*[0-9０-９一二三四五六七八九十百千零〇○◯ＯｏOo两廿卅]+\s*章/u.test(text) || /^chapter\s+\d+/i.test(text)) return 5;
  if (/第\s*[0-9０-９一二三四五六七八九十百千零〇○◯ＯｏOo两廿卅]+\s*回/u.test(text)) return 4;
  if (/第\s*[0-9０-９一二三四五六七八九十百千零〇○◯ＯｏOo两廿卅]+\s*[节讲课]/u.test(text)) return 2;
  if (/第\s*[0-9０-９一二三四五六七八九十百千零〇○◯ＯｏOo两廿卅]+\s*[篇部卷]/u.test(text)) return 1;
  return 0;
}

function scoreChapters(chapters: ParsedChapter[]): number {
  return chapters.reduce((sum, chapter) => {
    const score = chapterTitleScore(chapter.title);
    if (score >= 4) return sum + 10;
    if (score > 0) return sum + 1;
    return sum;
  }, 0);
}

function sampleTitle(chapters: ParsedChapter[]): string {
  const best = [...chapters].sort((left, right) => chapterTitleScore(right.title) - chapterTitleScore(left.title))[0];
  return best?.title || "";
}

function treeDepth(nodes: TocNode[], current = 0): number {
  let depth = current;
  for (const node of nodes) {
    if (node.children.length > 0) depth = Math.max(depth, treeDepth(node.children, current + 1));
  }
  return depth;
}

function descendantAtDepth(node: TocNode, target: number, current: number): boolean {
  if (current + 1 === target) return node.children.length > 0;
  if (current + 1 > target) return false;
  return node.children.some((child) => descendantAtDepth(child, target, current + 1));
}

interface Cut {
  title: string;
  pos: TextPosition;
  spanStart: TextPosition;
}

function buildLevel(documents: ParsedDocument[], toc: TocNode[], depth: number): { chapters: ParsedChapter[]; cuts: number; resolved: number } | null {
  const nodes: TocNode[] = [];
  collectCutNodes(toc, depth, 0, nodes);
  if (nodes.length === 0) return null;
  const cuts: Cut[] = [];
  collectCuts(toc, depth, 0, documents, cuts);
  return { chapters: chaptersFromCuts(documents, cuts), cuts: nodes.length, resolved: cuts.length };
}

function collectCutNodes(nodes: TocNode[], depth: number, current: number, out: TocNode[]): void {
  for (const node of nodes) {
    const descend = current < depth && descendantAtDepth(node, depth, current);
    if (descend) collectCutNodes(node.children, depth, current + 1, out);
    else out.push(node);
  }
}

function collectCuts(nodes: TocNode[], depth: number, current: number, documents: ParsedDocument[], out: Cut[]): void {
  for (const node of nodes) {
    const descend = current < depth && descendantAtDepth(node, depth, current);
    if (!descend) {
      const pos = locateNode(node, documents);
      if (!pos) continue;
      out.push({ title: normalizeTitle(node.title) || "未命名章节", pos, spanStart: pos });
      continue;
    }
    const parentPos = locateNode(node, documents);
    const before = out.length;
    collectCuts(node.children, depth, current + 1, documents, out);
    if (!parentPos || out.length === before) continue;
    let earliest = before;
    for (let index = before + 1; index < out.length; index++) {
      if (comparePosition(out[index].pos, out[earliest].pos) < 0) earliest = index;
    }
    if (comparePosition(parentPos, out[earliest].pos) < 0) out[earliest].spanStart = parentPos;
  }
}

function chaptersFromCuts(documents: ParsedDocument[], cuts: Cut[]): ParsedChapter[] {
  const ordered = [...cuts].sort((left, right) => comparePosition(left.spanStart, right.spanStart) || comparePosition(left.pos, right.pos));
  const points: Cut[] = [];
  for (const cut of ordered) {
    const previous = points[points.length - 1];
    if (previous && comparePosition(previous.spanStart, cut.spanStart) === 0) {
      if (chapterTitleScore(cut.title) > chapterTitleScore(previous.title)) points[points.length - 1] = cut;
      continue;
    }
    if (previous && comparePosition(cut.spanStart, previous.spanStart) < 0) continue;
    points.push(cut);
  }
  const origin = { doc: 0, offset: 0 };
  if (points.length > 0 && comparePosition(points[0].spanStart, origin) > 0) {
    const lead = normalizeChapterText(sliceDocuments(documents, origin, points[0].spanStart));
    const leadLength = [...lead].length;
    const totalLength = documents.reduce((sum, document) => sum + [...document.text].length, 0);
    if (leadLength >= MIN_CHAPTER_CHARS && totalLength > 0 && leadLength / totalLength >= 0.1) {
      let title = leadingTitle(documents, points[0].spanStart);
      if (title === points[0].title) title = "开头";
      points.unshift({ title, pos: origin, spanStart: origin });
    } else if (leadLength > 0) {
      points[0].spanStart = origin;
    }
  }
  const endOfBook = documents.length
    ? { doc: documents.length - 1, offset: documents[documents.length - 1].text.length }
    : { doc: 0, offset: 0 };
  const chapters: ParsedChapter[] = [];
  for (let index = 0; index < points.length; index++) {
    const start = points[index].spanStart;
    const end = index + 1 < points.length ? points[index + 1].spanStart : endOfBook;
    if (comparePosition(end, start) <= 0) continue;
    const text = normalizeChapterText(sliceDocuments(documents, start, end));
    if ([...text].length < MIN_CHAPTER_CHARS) continue;
    chapters.push({
      title: points[index].title || `第${chapters.length + 1}部分`,
      startDoc: start.doc,
      startOffset: start.offset,
      endDoc: end.doc,
      endOffset: end.offset,
      text,
      skipped: false,
    });
  }
  return finishChapters(chapters);
}

function leadingTitle(documents: ParsedDocument[], end: TextPosition): string {
  for (let doc = 0; doc < documents.length && doc <= end.doc; doc++) {
    for (const heading of documents[doc].headings) {
      if (comparePosition({ doc, offset: heading.offset }, end) >= 0) break;
      const title = normalizeTitle(heading.text);
      if (title && [...title].length <= 40 && !isFrontMatterTitle(title)) return title;
    }
  }
  return "开头";
}

function finishChapters(chapters: ParsedChapter[]): ParsedChapter[] {
  return chapters.map((chapter) => ({ ...chapter, skipped: isFrontMatterTitle(chapter.title) }));
}

export function isFrontMatterTitle(title: string): boolean {
  const text = title.replace(/\s+/g, "");
  if (!text || [...text].length > 16) return false;
  return /^(目录|目次|封面|书名页|扉页|版权页?|版权信息|copyright|cover)$/i.test(text);
}

const TINY_CHAPTER_CHARS = 200;
const CN_DIGITS = "0-9０-９一二三四五六七八九十百千零〇○◯ＯｏOo两廿卅";
const CHAPTER_INDEX_RE = new RegExp(`第\\s*([${CN_DIGITS}]+)\\s*([章节回部篇卷])`, "u");

export function readChapterIndex(title: string): { number: number; unit: string } | null {
  const match = CHAPTER_INDEX_RE.exec(title.trim());
  if (!match) return null;
  const number = parseChineseNumber(match[1]);
  if (number === null || number <= 0 || number > 9999) return null;
  return { number, unit: match[2] };
}

/** 章号有空档时给出提示。空档可以是原书如此，导入仍然成功。 */
export function chapterNumberWarnings(titles: string[]): string[] {
  const groups = new Map<string, number[]>();
  for (const title of titles) {
    const parsed = readChapterIndex(title);
    if (!parsed) continue;
    const numbers = groups.get(parsed.unit) ?? [];
    numbers.push(parsed.number);
    groups.set(parsed.unit, numbers);
  }
  let unit = "";
  let numbers: number[] = [];
  for (const [candidate, values] of groups) {
    if (values.length > numbers.length) {
      unit = candidate;
      numbers = values;
    }
  }
  if (numbers.length < 2) return [];
  const present = new Set(numbers);
  const sorted = [...present].sort((left, right) => left - right);
  const missing: number[] = [];
  for (let value = sorted[0]; value <= sorted[sorted.length - 1]; value++) {
    if (!present.has(value)) missing.push(value);
  }
  if (missing.length === 0) return [];
  const shown = missing.slice(0, 20).map((value) => `第${formatChineseNumber(value)}${unit}`);
  const suffix = missing.length > shown.length ? "等" : "";
  return [`${shown.join("、")}${suffix}可能缺失`];
}

function parseChineseNumber(raw: string): number | null {
  const text = raw.trim().replace(/廿/g, "二十").replace(/卅/g, "三十").replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xff10));
  if (!text) return null;
  if (!/[十百千]/.test(text)) {
    let digits = "";
    for (const char of text) {
      const digit = positionalDigit(char);
      if (digit === null) return null;
      digits += digit;
    }
    if (!digits) return null;
    const value = Number(digits);
    return Number.isSafeInteger(value) ? value : null;
  }
  const digitValue: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const unitValue: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let total = 0;
  let current = 0;
  let seen = false;
  for (const char of text) {
    if (/[0-9]/.test(char)) {
      current = current * 10 + Number(char);
      seen = true;
      continue;
    }
    if (positionalDigit(char) === "0") {
      seen = true;
      continue;
    }
    if (char in digitValue) {
      current = digitValue[char];
      seen = true;
      continue;
    }
    if (char in unitValue) {
      total += (current || 1) * unitValue[char];
      current = 0;
      seen = true;
      continue;
    }
    return null;
  }
  if (!seen) return null;
  return total + current;
}

function positionalDigit(char: string): string | null {
  if (/[0-9]/.test(char)) return char;
  if (/[０零〇○◯ＯｏOo]/.test(char)) return "0";
  const digits: Record<string, string> = { 一: "1", 二: "2", 两: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" };
  return digits[char] ?? null;
}

function formatChineseNumber(value: number): string {
  const digits = "零一二三四五六七八九";
  if (value < 10) return digits[value] || String(value);
  if (value < 20) return `十${value === 10 ? "" : digits[value % 10]}`;
  if (value < 100) return `${digits[Math.floor(value / 10)]}十${value % 10 ? digits[value % 10] : ""}`;
  if (value < 1000) {
    const rest = value % 100;
    const hundreds = `${digits[Math.floor(value / 100)]}百`;
    if (rest === 0) return hundreds;
    if (rest < 10) return `${hundreds}零${digits[rest]}`;
    return `${hundreds}${formatChineseNumber(rest)}`;
  }
  return String(value);
}

function chaptersFromSpine(documents: ParsedDocument[]): ParsedChapter[] {
  const suppressed = new Set<number>();
  const forced: Cut[] = [];
  documents.forEach((document, doc) => {
    const label = isolatedFrontMatterTitle(document);
    if (!label) return;
    suppressed.add(doc);
    forced.push({
      title: normalizeTitle(label),
      pos: { doc, offset: 0 },
      spanStart: { doc, offset: 0 },
    });
  });
  const candidates: Array<{ rank: number; cut: Cut }> = [];
  documents.forEach((document, doc) => {
    if (suppressed.has(doc)) return;
    for (const heading of document.headings) {
      const rank = splitRank(heading);
      if (rank >= 99) continue;
      candidates.push({
        rank,
        cut: {
          title: normalizeTitle(heading.text),
          pos: { doc, offset: heading.offset },
          spanStart: { doc, offset: heading.offset },
        },
      });
    }
  });
  const ranks = [...new Set(candidates.map((item) => item.rank))].sort((left, right) => left - right);
  for (const rank of ranks) {
    const points = [
      ...forced,
      ...candidates.filter((item) => item.rank === rank).map((item) => item.cut),
    ];
    if (points.length < 2) continue;
    const split = chaptersFromCuts(documents, points);
    if (split.length < 2) continue;
    return finishChapters(mergeTinyFragments(split));
  }
  const chapters: ParsedChapter[] = [];
  documents.forEach((document, doc) => {
    const text = normalizeChapterText(document.text);
    if ([...text].length < MIN_CHAPTER_CHARS && !suppressed.has(doc)) return;
    const front = isolatedFrontMatterTitle(document);
    const heading = document.headings.find((item) => isChapterHeading(item.text))
      ?? document.headings.find((item) => item.text.trim().length > 0 && item.text.trim().length <= 40);
    const firstLine = text.split("\n").map((line) => line.trim()).find((line) => line.length >= 2 && line.length <= 40);
    chapters.push({
      title: normalizeTitle(front || heading?.text || firstLine || `第${chapters.length + 1}部分`),
      startDoc: doc,
      startOffset: 0,
      endDoc: doc,
      endOffset: document.text.length,
      text,
      skipped: false,
    });
  });
  if (chapters.length > 0) return finishChapters(mergeTinyFragments(chapters));
  const combined = normalizeChapterText(documents.map((document) => document.text).join("\n"));
  if ([...combined].length < MIN_CHAPTER_CHARS) return [];
  return finishChapters([{
    title: "正文",
    startDoc: 0,
    startOffset: 0,
    endDoc: documents.length - 1,
    endOffset: documents[documents.length - 1]?.text.length ?? 0,
    text: combined,
    skipped: false,
  }]);
}

function isolatedFrontMatterTitle(document: ParsedDocument): string | null {
  const first = document.text.split("\n").map((line) => line.trim()).find(Boolean) || "";
  const compact = first.replace(/\s+/g, "");
  if (isFrontMatterTitle(compact)) return compact;
  if (isTocLikeDocument(document)) return "目录";
  if (isCopyrightDocument(document)) return "版权页";
  return null;
}

function isTocLikeDocument(document: ParsedDocument): boolean {
  const lines = document.text.split("\n").map((line) => line.trim()).filter(Boolean);
  const headingLines = lines.filter((line) => [...line].length <= 40 && isChapterHeading(line));
  if (headingLines.length < 5) return false;
  const headingChars = headingLines.reduce((sum, line) => sum + [...line].length, 0);
  const total = [...document.text].length;
  return total > 0 && (total - headingChars) / total < 0.45;
}

function isCopyrightDocument(document: ParsedDocument): boolean {
  const compact = document.text.replace(/\s+/g, "");
  if ([...compact].length === 0 || [...compact].length > 1500) return false;
  return /图书在版编目|版权所有|版权信息|ISBN/i.test(document.text);
}

function mergeTinyFragments(chapters: ParsedChapter[]): ParsedChapter[] {
  const tiny = chapters.map((chapter) => !isFrontMatterTitle(chapter.title) && [...chapter.text].length < TINY_CHAPTER_CHARS);
  if (!tiny.some(Boolean)) return chapters;
  const consumed = new Set<number>();
  const result: ParsedChapter[] = [];
  chapters.forEach((chapter, index) => {
    if (consumed.has(index) || tiny[index]) return;
    const parts: ParsedChapter[] = [];
    for (let previous = index - 1; previous >= 0 && tiny[previous] && !consumed.has(previous); previous--) {
      parts.unshift(chapters[previous]);
      consumed.add(previous);
    }
    parts.push(chapter);
    result.push(combineChapters(parts, chapter));
  });
  const trailing = chapters.filter((chapter, index) => tiny[index] && !consumed.has(index));
  if (trailing.length === 0) return result;
  if (result.length === 0) return [combineChapters(trailing, trailing[trailing.length - 1])];
  const last = result[result.length - 1];
  result[result.length - 1] = combineChapters([last, ...trailing], last);
  return result;
}

function combineChapters(parts: ParsedChapter[], anchor: ParsedChapter): ParsedChapter {
  const text = normalizeChapterText(parts.map((part) => part.text).join("\n"));
  return {
    ...anchor,
    text,
    startDoc: parts[0].startDoc,
    startOffset: parts[0].startOffset,
    endDoc: parts[parts.length - 1].endDoc,
    endOffset: parts[parts.length - 1].endOffset,
  };
}

function splitRank(heading: TextHeading): number {
  const semantic = semanticRank(heading.text);
  if (semantic >= 0) return semantic;
  const level = heading.level || 9;
  if (level >= 1 && level <= 3) return 10 + level;
  return 99;
}

function semanticRank(title: string): number {
  const text = title.trim();
  if (/第\s*[0-9０-９一二三四五六七八九十百千零〇○◯ＯｏOo两廿卅]+\s*[篇部卷]/u.test(text)) return 0;
  if (/第\s*[0-9０-９一二三四五六七八九十百千零〇○◯ＯｏOo两廿卅]+\s*[章回]/u.test(text) || /^chapter\s+\d+/i.test(text)) return 1;
  if (/第\s*[0-9０-９一二三四五六七八九十百千零〇○◯ＯｏOo两廿卅]+\s*[节讲课]/u.test(text) || /^section\s+\d+/i.test(text)) return 2;
  return -1;
}

function isChapterHeading(title: string): boolean {
  const text = title.trim();
  if (text.length < 2 || text.length > 80) return false;
  if (/[。！？]/u.test(text)) return false;
  return /^第\s*[0-9０-９一二三四五六七八九十百千零〇○◯ＯｏOo两廿卅]+\s*[章节回部篇卷]/u.test(text) || /^chapter\s+\d+\b/i.test(text);
}

/** 一行以「第X章/回」开头，后面如果是正文，标题只取到句读之前。 */
function standaloneChapterTitle(line: string): string | null {
  const text = line.trim();
  if ([...text].length < 2 || [...text].length > 200) return null;
  const match = /^(第\s*[0-9０-９一二三四五六七八九十百千零〇○◯ＯｏOo两廿卅]+\s*[章节回部篇卷]|chapter\s+\d+)/iu.exec(text);
  if (!match) return null;
  const rest = text.slice(match[0].length);
  if (rest && !/^\s/u.test(rest)) return null;
  if (isChapterHeading(text) && !/[。！？，；：、．]/u.test(text)) return text;
  const subtitle = rest.trim();
  const cut = subtitle.search(/[。！？，；：、．]/u);
  const head = [...(cut >= 0 ? subtitle.slice(0, cut) : subtitle).trim()].slice(0, 40).join("").trim();
  return head ? `${match[0]} ${head}` : match[0];
}

function comparePosition(left: TextPosition, right: TextPosition): number {
  if (left.doc !== right.doc) return left.doc - right.doc;
  return left.offset - right.offset;
}

function locateNode(node: TocNode, documents: ParsedDocument[]): TextPosition | null {
  if (node.href) {
    const doc = findDocument(documents, node.href);
    if (doc >= 0) {
      if (node.fragment) {
        const anchor = documents[doc].anchors.find((item) => item.id === node.fragment)
          ?? documents[doc].anchors.find((item) => item.id.toLowerCase() === node.fragment!.toLowerCase());
        if (anchor) return { doc, offset: anchor.offset };
      }
      return { doc, offset: 0 };
    }
  }
  for (const child of node.children) {
    const found = locateNode(child, documents);
    if (found) return found;
  }
  return null;
}

function findDocument(documents: ParsedDocument[], href: string): number {
  const target = href.replace(/\\/g, "/").replace(/^\/+/, "");
  let index = documents.findIndex((document) => document.href === target);
  if (index >= 0) return index;
  const lower = target.toLowerCase();
  index = documents.findIndex((document) => document.href.toLowerCase() === lower);
  if (index >= 0) return index;
  const base = posix.basename(target);
  const matches = documents.map((document, docIndex) => ({ document, docIndex })).filter((item) => posix.basename(item.document.href) === base);
  return matches.length === 1 ? matches[0].docIndex : -1;
}

interface PackageInfo {
  title: string;
  author: string;
  language: string;
  subjects: string;
  description: string;
  spine: string[];
  ncxPath?: string;
  navPath?: string;
}

function parsePackage(opfText: string, baseDir: string): PackageInfo {
  const root = parseXml(opfText);
  if (!root || root.name !== "package") throw corrupt();
  const metadata = firstChild(root, "metadata");
  const manifest = firstChild(root, "manifest");
  const spine = firstChild(root, "spine");
  if (!manifest || !spine) throw corrupt();
  const titles = childrenNamed(metadata, "title").map((node) => deepText(node)).filter(Boolean);
  const creators = childrenNamed(metadata, "creator").map((node) => deepText(node)).filter(Boolean);
  const items = new Map<string, { href: string; mediaType: string; properties: string }>();
  let ncxPath: string | undefined;
  let navPath: string | undefined;
  const tocId = spine.attrs.toc;
  for (const item of childrenNamed(manifest, "item")) {
    const id = item.attrs.id || "";
    const href = resolveHref(baseDir, item.attrs.href || "").path;
    const mediaType = item.attrs["media-type"] || "";
    const properties = item.attrs.properties || "";
    if (id) items.set(id, { href, mediaType, properties });
    if ((tocId && id === tocId) || /ncx/i.test(mediaType) || href.endsWith(".ncx")) ncxPath = ncxPath || href;
    if (/(^|\s)nav(\s|$)/i.test(properties)) navPath = href;
  }
  const spineHrefs = childrenNamed(spine, "itemref").flatMap((item) => {
    const ref = items.get(item.attrs.idref || "");
    if (!ref) return [];
    if (/\.ncx$/i.test(ref.href)) return [];
    if (ref.mediaType && !/html|xhtml|xml/i.test(ref.mediaType)) return [];
    if (/\.(css|jpe?g|png|gif|svg|webp|ttf|otf|woff2?|mp3|mp4)$/i.test(ref.href)) return [];
    return [ref.href];
  });
  return {
    title: titles[0] || "未命名",
    author: creators.join("、"),
    language: deepText(firstChild(metadata, "language")),
    subjects: childrenNamed(metadata, "subject").map((node) => deepText(node)).join(" "),
    description: deepText(firstChild(metadata, "description")),
    spine: spineHrefs,
    ncxPath,
    navPath,
  };
}

function readToc(files: Map<string, Buffer>, opf: PackageInfo): TocNode[] {
  if (opf.navPath) {
    const nav = readText(files, opf.navPath);
    if (nav) {
      const nodes = parseNavDocument(nav, posix.dirname(opf.navPath) === "." ? "" : posix.dirname(opf.navPath));
      if (nodes.length > 0) return nodes;
    }
  }
  if (opf.ncxPath) {
    const ncx = readText(files, opf.ncxPath);
    if (ncx) return parseNcx(ncx, posix.dirname(opf.ncxPath) === "." ? "" : posix.dirname(opf.ncxPath));
  }
  return [];
}

function parseNcx(xml: string, baseDir: string): TocNode[] {
  const root = parseXml(xml);
  const map = firstChild(root, "navmap");
  if (!map) return [];
  return childrenNamed(map, "navpoint").flatMap((node) => {
    const parsed = navPoint(node, baseDir);
    return parsed ? [parsed] : [];
  });
}

function navPoint(node: XmlElement, baseDir: string): TocNode | null {
  const label = deepText(firstChild(firstChild(node, "navlabel"), "text"));
  const src = firstChild(node, "content")?.attrs.src || "";
  const resolved = src ? resolveHref(baseDir, src) : { path: "", fragment: null };
  const children = childrenNamed(node, "navpoint").flatMap((child) => {
    const parsed = navPoint(child, baseDir);
    return parsed ? [parsed] : [];
  });
  if (!label && children.length === 0 && !resolved.path) return null;
  return {
    title: normalizeTitle(label) || "未命名章节",
    href: resolved.path || null,
    fragment: resolved.fragment,
    children,
  };
}

function parseNavDocument(xml: string, baseDir: string): TocNode[] {
  const root = parseXml(xml);
  if (!root) return [];
  const nav = findTocNav(root);
  const list = firstChild(nav, "ol");
  if (!list) return [];
  return childrenNamed(list, "li").flatMap((item) => {
    const node = listItem(item, baseDir);
    return node ? [node] : [];
  });
}

function findTocNav(node: XmlElement): XmlElement | null {
  if (node.name === "nav") {
    const type = node.attrs.type || "";
    if (!type || type.split(/\s+/).includes("toc")) return node;
  }
  for (const child of node.children) {
    const found = findTocNav(child);
    if (found) return found;
  }
  return null;
}

function listItem(node: XmlElement, baseDir: string): TocNode | null {
  const link = firstChild(node, "a") || firstChild(node, "span");
  const resolved = link?.attrs.href ? resolveHref(baseDir, link.attrs.href) : { path: "", fragment: null };
  const children = childrenNamed(firstChild(node, "ol"), "li").flatMap((item) => {
    const child = listItem(item, baseDir);
    return child ? [child] : [];
  });
  const title = normalizeTitle(deepText(link));
  if (!title && children.length === 0) return null;
  return { title: title || "未命名章节", href: resolved.path || null, fragment: resolved.fragment, children };
}

function containerPath(container: string): string {
  const root = parseXml(container);
  const rootfile = findDescendant(root, "rootfile");
  const fullPath = rootfile?.attrs["full-path"];
  if (!fullPath) throw corrupt();
  return fullPath.replace(/\\/g, "/").replace(/^\/+/, "");
}

function assertReadable(files: Map<string, Buffer>): void {
  const encryption = readText(files, "META-INF/encryption.xml");
  if (!encryption || !/EncryptedData/i.test(encryption)) return;
  const uris = [...encryption.matchAll(/URI="([^"]+)"/g)].map((match) => safeDecode(match[1]));
  const contentEncrypted = uris.some((uri) => /\.(xhtml|html|htm|opf|ncx|xml)$/i.test(uri.split("?")[0]));
  const fontOnly = uris.length > 0 && uris.every((uri) => /\.(ttf|otf|woff2?)$/i.test(uri.split("?")[0]));
  if (fontOnly && !contentEncrypted) return;
  throw new ReadingError("这本 epub 有加密保护，目前只能导入未加密的书。");
}

function readText(files: Map<string, Buffer>, name: string): string | undefined {
  const exact = files.get(name);
  if (exact) return decodeBookText(exact);
  const lower = name.toLowerCase();
  for (const [key, value] of files) {
    if (key.toLowerCase() === lower) return decodeBookText(value);
  }
  return undefined;
}

function decodeBookText(content: Buffer): string {
  const head = content.subarray(0, 500).toString("latin1");
  const declared = /encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/i.exec(head)?.[1]
    || /charset\s*=\s*["']([^"']+)["']/i.exec(head)?.[1];
  const encoding = normalizeEncoding(declared);
  if (!encoding || encoding === "utf-8" || encoding === "utf8" || encoding === "ascii" || encoding === "us-ascii") {
    return content.toString("utf8").replace(/^\uFEFF/, "");
  }
  try {
    return new TextDecoder(encoding).decode(content).replace(/^\uFEFF/, "");
  } catch {
    throw new ReadingError(`这本 epub 使用了无法识别的文字编码（${declared}）。`);
  }
}

function normalizeEncoding(declared: string | undefined): string | null {
  if (!declared) return null;
  const encoding = declared.toLowerCase().replace(/_/g, "-");
  if (encoding === "gb2312" || encoding === "gb-2312" || encoding === "x-gbk") return "gbk";
  if (encoding === "gb18030" || encoding === "gbk" || encoding === "big5" || encoding === "shift-jis" || encoding === "euc-jp") return encoding;
  return encoding;
}

function resolveHref(baseDir: string, href: string): { path: string; fragment: string | null } {
  const hash = href.indexOf("#");
  const pathPart = hash >= 0 ? href.slice(0, hash) : href;
  const fragment = hash >= 0 ? safeDecode(href.slice(hash + 1)) : null;
  const decoded = safeDecode(pathPart).replace(/\\/g, "/");
  if (!decoded) return { path: "", fragment };
  const joined = posix.normalize(posix.join(baseDir, decoded)).replace(/^(\.\.\/)+/, "").replace(/^\.\//, "").replace(/^\//, "");
  return { path: joined === "." ? "" : joined, fragment: fragment || null };
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

const BLOCK_TAGS = new Set(["p", "div", "li", "tr", "blockquote", "section", "article", "h1", "h2", "h3", "h4", "h5", "h6", "table", "ul", "ol", "br", "hr"]);
const HEADING_TAGS = new Set(["h1", "h2", "h3"]);

export function extractHtml(html: string): { text: string; anchors: TextAnchor[]; headings: TextHeading[] } {
  const source = html.replace(/^\uFEFF/, "");
  let text = "";
  const anchors: TextAnchor[] = [];
  const headings: TextHeading[] = [];
  const blocks: { tag: string; start: number }[] = [];
  let index = 0;
  let skipping: string | null = null;

  const ensureBreak = () => {
    if (text && !text.endsWith("\n")) text += "\n";
  };

  while (index < source.length) {
    if (source[index] !== "<") {
      const next = source.indexOf("<", index);
      const raw = source.slice(index, next === -1 ? source.length : next);
      index = next === -1 ? source.length : next;
      if (skipping) continue;
      const prepared = decodeEntities(raw).replace(/\u00a0/g, " ").replace(/\u3000/g, " ").replace(/[ \t\r\f]+/g, " ");
      if (!prepared) continue;
      if (!prepared.trim()) {
        if (text && !text.endsWith("\n") && !text.endsWith(" ")) text += " ";
        continue;
      }
      const flat = prepared.replace(/\n+/g, " ");
      const trimmedPrefix = text.endsWith("\n") ? flat.length - flat.trimStart().length : 0;
      const appended = trimmedPrefix > 0 ? flat.slice(trimmedPrefix) : flat;
      const base = text.length;
      text += appended;
      for (const heading of embeddedChapterHeadings(prepared)) {
        const relative = mapPreparedIndex(prepared, heading.index) - trimmedPrefix;
        if (relative < 0 || relative > appended.length) continue;
        headings.push({ offset: base + relative, text: normalizeTitle(heading.text).slice(0, 80), level: 9 });
      }
      continue;
    }
    if (source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      index = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", index)) {
      const end = source.indexOf("]]>", index + 9);
      const raw = source.slice(index + 9, end === -1 ? source.length : end);
      index = end === -1 ? source.length : end + 3;
      if (!skipping && raw) text += raw;
      continue;
    }
    if (source.startsWith("<?", index)) {
      const end = source.indexOf("?>", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    const tagEnd = findTagEnd(source, index + 1);
    if (tagEnd < 0) break;
    const token = source.slice(index + 1, tagEnd).trim();
    index = tagEnd + 1;
    if (!token) continue;
    if (token.startsWith("/")) {
      const name = localName(token.slice(1));
      if (skipping === name) skipping = null;
      if (skipping) continue;
      for (let block = blocks.length - 1; block >= 0; block--) {
        if (blocks[block].tag !== name) continue;
        const start = blocks[block].start;
        blocks.length = block;
        const captured = text.slice(start).trim();
        if (captured && (HEADING_TAGS.has(name) || isChapterHeading(captured))) {
          headings.push({ offset: start, text: normalizeTitle(captured).slice(0, 80), level: headingLevel(name) });
        }
        break;
      }
      continue;
    }
    const selfClosing = /\/$/.test(token);
    const element = parseStartTag(selfClosing ? token.slice(0, -1) : token);
    if (element.name === "head" || element.name === "script" || element.name === "style") {
      if (!selfClosing) skipping = element.name;
      continue;
    }
    if (skipping) continue;
    if (BLOCK_TAGS.has(element.name)) ensureBreak();
    const id = element.attrs.id || element.attrs.name;
    if (id) anchors.push({ id, offset: text.length });
    if (!selfClosing && BLOCK_TAGS.has(element.name)) blocks.push({ tag: element.name, start: text.length });
  }

  const trimmedStart = text.length - text.trimStart().length;
  const trimmed = text.trim();
  const shift = (offset: number) => offset - trimmedStart;
  return {
    text: trimmed,
    anchors: anchors
      .map((anchor) => ({ id: anchor.id, offset: shift(anchor.offset) }))
      .filter((anchor) => anchor.offset >= 0 && anchor.offset <= trimmed.length),
    headings: dedupeHeadings(headings
      .map((heading) => ({ ...heading, offset: shift(heading.offset) }))
      .filter((heading) => heading.offset >= 0 && heading.offset <= trimmed.length)),
  };
}

function headingLevel(tag: string): number {
  if (tag === "h1") return 1;
  if (tag === "h2") return 2;
  if (tag === "h3") return 3;
  return 9;
}

function dedupeHeadings(headings: TextHeading[]): TextHeading[] {
  const seen = new Set<string>();
  const result: TextHeading[] = [];
  for (const heading of headings) {
    const key = `${heading.offset}:${heading.text}`;
    if (seen.has(key)) continue;
    const previous = result[result.length - 1];
    if (previous && previous.text === heading.text && heading.offset >= previous.offset && heading.offset - previous.offset <= 240) continue;
    seen.add(key);
    result.push(heading);
  }
  return result;
}

function embeddedChapterHeadings(prepared: string): Array<{ index: number; text: string }> {
  const found: Array<{ index: number; text: string }> = [];
  let start = 0;
  while (start <= prepared.length) {
    const end = prepared.indexOf("\n", start);
    const lineEnd = end < 0 ? prepared.length : end;
    const rawLine = prepared.slice(start, lineEnd);
    const lead = rawLine.length - rawLine.trimStart().length;
    const title = standaloneChapterTitle(rawLine);
    if (title) found.push({ index: start + lead, text: title });
    if (end < 0) break;
    start = end + 1;
  }
  return found;
}

function mapPreparedIndex(prepared: string, index: number): number {
  let flat = 0;
  let cursor = 0;
  while (cursor < index) {
    if (prepared[cursor] === "\n") {
      while (cursor < index && prepared[cursor] === "\n") cursor += 1;
      flat += 1;
      continue;
    }
    flat += 1;
    cursor += 1;
  }
  return flat;
}

function findTagEnd(source: string, start: number): number {
  let quote: string | null = null;
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === ">") return index;
  }
  return -1;
}

function parseXml(source: string): XmlElement | null {
  const input = source.replace(/^\uFEFF/, "");
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let index = 0;
  while (index < input.length) {
    if (input[index] !== "<") {
      const next = input.indexOf("<", index);
      const raw = input.slice(index, next === -1 ? input.length : next);
      if (stack.length > 0) stack[stack.length - 1].text += decodeEntities(raw);
      index = next === -1 ? input.length : next;
      continue;
    }
    if (input.startsWith("<!--", index)) {
      const end = input.indexOf("-->", index + 4);
      index = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith("<![CDATA[", index)) {
      const end = input.indexOf("]]>", index + 9);
      const raw = input.slice(index + 9, end === -1 ? input.length : end);
      if (stack.length > 0) stack[stack.length - 1].text += raw;
      index = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith("<?", index) || input.startsWith("<!", index)) {
      const end = input.indexOf(input.startsWith("<?", index) ? "?>" : ">", index + 2);
      index = end === -1 ? input.length : end + (input.startsWith("<?", index) ? 2 : 1);
      continue;
    }
    const tagEnd = findTagEnd(input, index + 1);
    if (tagEnd < 0) break;
    const token = input.slice(index + 1, tagEnd).trim();
    index = tagEnd + 1;
    if (token.startsWith("/")) {
      const name = localName(token.slice(1));
      for (let depth = stack.length - 1; depth >= 0; depth--) {
        if (stack[depth].name !== name) continue;
        const element = stack[depth];
        stack.length = depth;
        if (stack.length === 0) root = element;
        else stack[stack.length - 1].children.push(element);
        break;
      }
      continue;
    }
    const selfClosing = /\/$/.test(token);
    const element = parseStartTag(selfClosing ? token.slice(0, -1) : token);
    if (selfClosing) {
      if (stack.length > 0) stack[stack.length - 1].children.push(element);
      else root = element;
    } else stack.push(element);
  }
  return root ?? stack[0] ?? null;
}

function parseStartTag(body: string): XmlElement {
  const trimmed = body.trim();
  const space = trimmed.search(/\s/);
  const name = localName(space < 0 ? trimmed : trimmed.slice(0, space));
  const attrs: Record<string, string> = {};
  const rest = space < 0 ? "" : trimmed.slice(space);
  const attrRe = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(rest))) {
    const rawKey = match[1].toLowerCase();
    const key = rawKey.includes(":") ? rawKey.slice(rawKey.lastIndexOf(":") + 1) : rawKey;
    attrs[key] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return { name, attrs, children: [], text: "" };
}

function localName(token: string): string {
  const name = token.trim().split(/\s/)[0].replace(/\/$/, "");
  const index = name.lastIndexOf(":");
  return (index >= 0 ? name.slice(index + 1) : name).toLowerCase();
}

function childrenNamed(node: XmlElement | null, name: string): XmlElement[] {
  if (!node) return [];
  return node.children.filter((child) => child.name === name);
}

function firstChild(node: XmlElement | null, name: string): XmlElement | null {
  return childrenNamed(node, name)[0] ?? null;
}

function deepText(node: XmlElement | null): string {
  if (!node) return "";
  return `${node.text} ${node.children.map((child) => deepText(child)).join(" ")}`.replace(/\s+/g, " ").trim();
}

function findDescendant(node: XmlElement | null, name: string): XmlElement | null {
  if (!node) return null;
  if (node.name === name) return node;
  for (const child of node.children) {
    const found = findDescendant(child, name);
    if (found) return found;
  }
  return null;
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (all, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return all;
      try { return String.fromCodePoint(code); }
      catch { return all; }
    }
    return NAMED_ENTITIES[entity] ?? all;
  });
}

function unzipEpub(data: Buffer): Map<string, Buffer> {
  if (!Buffer.isBuffer(data) || data.length < 22) throw corrupt();
  const eocd = findEocd(data);
  if (eocd < 0) throw corrupt();
  const count = data.readUInt16LE(eocd + 10);
  const directoryOffset = data.readUInt32LE(eocd + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff) throw corrupt();
  const entries: ZipEntry[] = [];
  let offset = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50) throw corrupt();
    const method = data.readUInt16LE(offset + 10);
    const compressedSize = data.readUInt32LE(offset + 20);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const localOffset = data.readUInt32LE(offset + 42);
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString("utf8").replace(/\\/g, "/").replace(/^\/+/, "");
    offset += 46 + nameLength + extraLength + commentLength;
    if (!name || name.endsWith("/")) continue;
    if (isIgnoredAsset(name)) continue;
    if (name.split("/").includes("..") || compressedSize === 0xffffffff || localOffset === 0xffffffff) throw corrupt();
    entries.push({ name, method, compressedSize, localOffset });
  }
  const files = new Map<string, Buffer>();
  let total = 0;
  for (const entry of entries) {
    if (entry.localOffset + 30 > data.length || data.readUInt32LE(entry.localOffset) !== 0x04034b50) throw corrupt();
    const nameLength = data.readUInt16LE(entry.localOffset + 26);
    const extraLength = data.readUInt16LE(entry.localOffset + 28);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    const end = start + entry.compressedSize;
    if (end > data.length) throw corrupt();
    const compressed = data.subarray(start, end);
    let content: Buffer;
    try {
      if (entry.method === 0) content = Buffer.from(compressed);
      else if (entry.method === 8) content = inflateRawSync(compressed);
      else throw corrupt();
    } catch (error) {
      if (error instanceof ReadingError) throw error;
      throw corrupt();
    }
    if (content.length > MAX_UNCOMPRESSED_FILE) throw new ReadingError("这本 epub 太大，暂时无法导入。");
    total += content.length;
    if (total > MAX_UNCOMPRESSED_TOTAL) throw new ReadingError("这本 epub 太大，暂时无法导入。");
    if (!files.has(entry.name)) files.set(entry.name, content);
  }
  if (!readText(files, "META-INF/container.xml")) throw corrupt();
  return files;
}

function isIgnoredAsset(name: string): boolean {
  return /\.(jpe?g|png|gif|webp|bmp|svg|tiff?|ttf|otf|woff2?|mp3|mp4|m4a|pdf)$/i.test(name);
}

function findEocd(data: Buffer): number {
  const min = Math.max(0, data.length - 22 - 65535);
  for (let offset = data.length - 22; offset >= min; offset--) {
    if (data.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}
