import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", "vendor", "dist", ".obsidian", ".trash", "coverage"]);
const MAX_CHUNK_CHARS = 1400;
const MAX_TERMS = 16;
const TERM_SCAN_LIMIT = 40;
const CJK_CHAR = /[\u3400-\u9fff]/;
// 长词在前，从左到右贪心匹配，避免「怎么样」留下「怎么」。
const CJK_STOP_PHRASES = [
  "如何才能",
  "怎样才能",
  "怎么才能",
  "可不可以",
  "什么样",
  "怎么样",
  "为什么",
  "什么是",
  "是什么",
  "怎么能",
  "能不能",
  "是不是",
  "有没有",
  "哪些",
  "哪个",
  "哪里",
  "哪儿",
  "是否",
  "能否",
  "可以",
  "怎样",
  "怎么",
  "如何",
  "什么",
  "为何",
  "为啥",
  "多少",
  "请问",
  "一下",
  "一些",
  "做好",
  "今天",
  "现在",
  "最近",
].sort((a, b) => b.length - a.length || a.localeCompare(b, "zh"));
const CJK_STOP_PHRASE_SET = new Set(CJK_STOP_PHRASES);
const EDGE_PARTICLES = new Set(["吗", "呢", "吧", "啊", "呀", "的", "了", "着", "过", "嘛"]);
const INFIX_PARTICLES = new Set(["的", "了", "着", "过"]);

export const MAX_MARKDOWN_FILES = 5000;
export const MAX_MARKDOWN_FILE_BYTES = 512 * 1024;
export const MAX_MARKDOWN_TOTAL_BYTES = 32 * 1024 * 1024;

export interface ParsedFrontmatter {
  title: string | null;
  description: string | null;
  tags: string[];
  aliases: string[];
  data: Record<string, string | string[]>;
  body: string;
}

export interface MarkdownChunk {
  heading: string;
  content: string;
  startLine: number;
  endLine: number;
}

export interface ChunkedMarkdown {
  title: string;
  tags: string[];
  aliases: string[];
  description: string | null;
  frontmatter: Record<string, string | string[]>;
  chunks: MarkdownChunk[];
}

export interface MarkdownSource {
  path: string;
  markdown: string;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function asStrings(data: Record<string, string | string[]>, key: string): string[] {
  const value = data[key];
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function asString(data: Record<string, string | string[]>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseFrontmatter(markdown: string): ParsedFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!match) {
    return { title: null, description: null, tags: [], aliases: [], data: {}, body: markdown };
  }
  const data: Record<string, string | string[]> = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const key = pair[1];
    const rawValue = pair[2].trim();
    if (!rawValue) {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) {
        i += 1;
        items.push(unquote(lines[i].replace(/^\s+-\s+/, "")));
      }
      if (items.length > 0) data[key] = items.filter(Boolean);
      continue;
    }
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      data[key] = rawValue.slice(1, -1).split(",").map(unquote).map((item) => item.trim()).filter(Boolean);
    } else {
      data[key] = unquote(rawValue);
    }
  }
  return {
    title: asString(data, "title"),
    description: asString(data, "description") || asString(data, "summary"),
    tags: asStrings(data, "tags"),
    aliases: [...asStrings(data, "aliases"), ...asStrings(data, "alias")],
    data,
    body: markdown.slice(match[0].length),
  };
}

function frontmatterLineCount(markdown: string): number {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!match) return 0;
  const parts = match[0].split(/\r?\n/);
  return match[0].endsWith("\n") ? parts.length - 1 : parts.length;
}

interface Section {
  heading: string;
  lines: string[];
  startLine: number;
  endLine: number;
}

function splitSections(lines: string[], startIndex: number, fallbackHeading: string): Section[] {
  const sections: Section[] = [];
  let stack: Array<{ level: number; text: string }> = [];
  let current: Section | null = null;
  const flush = () => {
    if (!current) return;
    if (current.lines.join("\n").trim()) sections.push(current);
    current = null;
  };
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      const text = heading[2].trim();
      stack = stack.filter((item) => item.level < level);
      stack.push({ level, text });
      current = {
        heading: stack.map((item) => item.text).join(" / "),
        lines: [line],
        startLine: i + 1,
        endLine: i + 1,
      };
      continue;
    }
    if (!current) {
      current = { heading: fallbackHeading, lines: [], startLine: i + 1, endLine: i + 1 };
    }
    current.lines.push(line);
    current.endLine = i + 1;
  }
  flush();
  return sections;
}

function splitLong(section: Section): MarkdownChunk[] {
  const text = section.lines.join("\n").trim();
  if (!text) return [];
  if (text.length <= MAX_CHUNK_CHARS) {
    return [{ heading: section.heading, content: text, startLine: section.startLine, endLine: section.endLine }];
  }
  const paragraphs = text.split(/\n{2,}/);
  const chunks: MarkdownChunk[] = [];
  let buffer: string[] = [];
  let size = 0;
  const push = () => {
    const content = buffer.join("\n\n").trim();
    if (!content) return;
    chunks.push({ heading: section.heading, content, startLine: section.startLine, endLine: section.endLine });
  };
  for (const paragraph of paragraphs) {
    if (size + paragraph.length > MAX_CHUNK_CHARS && buffer.length > 0) {
      push();
      const tail = buffer[buffer.length - 1];
      buffer = tail && tail.length <= 240 ? [tail] : [];
      size = buffer.join("\n\n").length;
    }
    buffer.push(paragraph);
    size += paragraph.length + 2;
  }
  push();
  return chunks.length > 0
    ? chunks
    : [{ heading: section.heading, content: text.slice(0, MAX_CHUNK_CHARS), startLine: section.startLine, endLine: section.endLine }];
}

export function chunkMarkdown(relativePath: string, markdown: string): ChunkedMarkdown {
  const parsed = parseFrontmatter(markdown);
  const fileName = relativePath.split("/").pop()?.replace(/\.md$/i, "") || relativePath;
  const headingTitle = /^#\s+(.+)$/m.exec(parsed.body)?.[1]?.trim() || null;
  const title = parsed.title || headingTitle || fileName;
  const sections = splitSections(markdown.split(/\r?\n/), frontmatterLineCount(markdown), title);
  const chunks = sections.flatMap(splitLong);
  return {
    title,
    tags: parsed.tags,
    aliases: parsed.aliases,
    description: parsed.description,
    frontmatter: parsed.data,
    chunks: chunks.length > 0
      ? chunks
      : [{ heading: title, content: title, startLine: 1, endLine: 1 }],
  };
}

export function searchableText(input: {
  title: string;
  tags: string[];
  aliases: string[];
  description?: string | null;
  heading: string;
  content: string;
}): string {
  return [input.title, input.aliases.join(" "), input.tags.join(" "), input.description || "", input.heading, input.content]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
}

export interface KnowledgeQueryTerms {
  ftsTerms: string[];
  likeTerms: string[];
}

function splitScripts(part: string): Array<{ cjk: boolean; text: string }> {
  const runs: Array<{ cjk: boolean; text: string }> = [];
  for (const char of part) {
    const cjk = CJK_CHAR.test(char);
    const last = runs[runs.length - 1];
    if (!last || last.cjk !== cjk) runs.push({ cjk, text: char });
    else last.text += char;
  }
  return runs;
}

function stripStopPhrases(text: string): string {
  const chars = Array.from(text);
  let out = "";
  for (let i = 0; i < chars.length;) {
    const phrase = CJK_STOP_PHRASES.find((item) => (
      item.length <= chars.length - i && chars.slice(i, i + item.length).join("") === item
    ));
    if (phrase) {
      out += "\0";
      i += phrase.length;
      continue;
    }
    out += chars[i];
    i += 1;
  }
  return out;
}

function blockedTerm(term: string, source: string): boolean {
  if (CJK_STOP_PHRASE_SET.has(term) || isOnlyParticles(term)) return true;
  for (const phrase of CJK_STOP_PHRASES) {
    if (phrase.length >= 2 && term.includes(phrase)) return true;
    if (phrase.length <= term.length || !source.includes(phrase) || !phrase.includes(term)) continue;
    return true;
  }
  return false;
}

function splitInfixParticles(text: string): string[] {
  const chars = Array.from(text);
  const parts: string[] = [];
  let buf = "";
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    if (INFIX_PARTICLES.has(char) && buf.length >= 2) {
      const rest = chars.slice(i + 1).join("").replace(/^[的了着过吗呢吧啊呀嘛]+/u, "");
      if (rest.length >= 2) {
        parts.push(buf);
        buf = "";
        continue;
      }
    }
    buf += char;
  }
  if (buf) parts.push(buf);
  return parts;
}

function trimEdgeParticles(text: string): string {
  let result = text;
  while (result.length > 2 && EDGE_PARTICLES.has(result[0])) result = result.slice(1);
  while (result.length > 2 && EDGE_PARTICLES.has(result[result.length - 1])) result = result.slice(0, -1);
  return result;
}

function isOnlyParticles(text: string): boolean {
  if (!text) return true;
  for (const char of text) {
    if (!EDGE_PARTICLES.has(char)) return false;
  }
  return true;
}

function cjkSegments(text: string): string[] {
  const segments: string[] = [];
  for (const piece of stripStopPhrases(text).split("\0")) {
    if (!piece) continue;
    for (const part of splitInfixParticles(piece)) {
      const trimmed = trimEdgeParticles(part);
      if (trimmed.length >= 2) segments.push(trimmed);
    }
  }
  return segments;
}

function collectCjkTerms(
  segment: string,
  source: string,
  fts: Set<string>,
  exactLike: Set<string>,
  gramLike: Set<string>,
): void {
  if (segment.length < 2 || blockedTerm(segment, source)) return;
  if (segment.length === 2) {
    exactLike.add(segment);
    return;
  }
  if (segment.length <= 8) fts.add(segment);
  for (const size of [6, 4]) {
    if (segment.length < size) continue;
    for (let i = 0; i + size <= segment.length; i += 2) {
      const window = segment.slice(i, i + size);
      if (!blockedTerm(window, source)) fts.add(window);
      if (fts.size >= TERM_SCAN_LIMIT) break;
    }
  }
  const chars = Array.from(segment);
  for (let i = 0; i + 1 < chars.length; i += 1) {
    const gram = chars[i] + chars[i + 1];
    if (blockedTerm(gram, source)) continue;
    gramLike.add(gram);
    if (gramLike.size >= TERM_SCAN_LIMIT) break;
  }
}

export function extractKnowledgeTerms(question: string): KnowledgeQueryTerms {
  const cleaned = question.replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
  const fts = new Set<string>();
  const exactLike = new Set<string>();
  const gramLike = new Set<string>();
  if (!cleaned) return { ftsTerms: [], likeTerms: [] };

  for (const part of cleaned.split(/\s+/)) {
    if (part.length < 2) continue;
    for (const run of splitScripts(part)) {
      if (!run.cjk) {
        if (run.text.length >= 3 && run.text.length <= 48) fts.add(run.text);
        else if (run.text.length === 2) exactLike.add(run.text);
        continue;
      }
      for (const segment of cjkSegments(run.text)) {
        collectCjkTerms(segment, run.text, fts, exactLike, gramLike);
      }
    }
  }

  const ftsTerms = [...fts].sort((a, b) => b.length - a.length).slice(0, MAX_TERMS);
  const likeTerms: string[] = [];
  const seen = new Set<string>();
  for (const term of [...exactLike, ...gramLike]) {
    if (seen.has(term)) continue;
    seen.add(term);
    likeTerms.push(term);
    if (likeTerms.length >= MAX_TERMS) break;
  }
  return { ftsTerms, likeTerms };
}

export function buildFtsQuery(question: string): string | null {
  const { ftsTerms } = extractKnowledgeTerms(question);
  if (ftsTerms.length === 0) return null;
  return ftsTerms.map((term) => `"${term.replace(/"/g, "\"\"")}"`).join(" OR ");
}

export function excerpt(content: string, max = 280): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function selectCitations<T extends { index: number }>(answer: string, sources: T[]): T[] {
  const used = sources.filter((source) => new RegExp(`\\[${source.index}\\](?!\\d)`).test(answer));
  return used.length > 0 ? used : sources;
}

export function listMarkdownFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      files.push(relative(root, join(dir, entry.name)).split(sep).join("/"));
    }
  };
  walk(root);
  files.sort();
  return files;
}

export function readMarkdownTree(root: string): MarkdownSource[] {
  const paths = listMarkdownFiles(root);
  if (paths.length > MAX_MARKDOWN_FILES) {
    throw new Error(`Markdown 文件超过 ${MAX_MARKDOWN_FILES} 个，请缩小仓库范围`);
  }
  const docs: MarkdownSource[] = [];
  let total = 0;
  for (const path of paths) {
    const absolute = join(root, path);
    const info = lstatSync(absolute);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_MARKDOWN_FILE_BYTES) continue;
    const markdown = readFileSync(absolute, "utf8");
    if (markdown.includes("\u0000")) continue;
    total += Buffer.byteLength(markdown);
    if (total > MAX_MARKDOWN_TOTAL_BYTES) throw new Error("知识库 Markdown 总体积过大，已停止索引");
    docs.push({ path, markdown });
  }
  return docs;
}
