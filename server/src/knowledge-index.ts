import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", "vendor", "dist", ".obsidian", ".trash", "coverage"]);
const MAX_CHUNK_CHARS = 1400;
const MAX_TERMS = 16;

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

export function buildFtsQuery(question: string): string | null {
  const cleaned = question.replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
  if (!cleaned) return null;
  const terms = new Set<string>();
  for (const part of cleaned.split(/\s+/)) {
    if (part.length < 2) continue;
    const cjk = /[\u3400-\u9fff]/.test(part);
    if (!cjk) {
      if (part.length >= 3 && part.length <= 48) terms.add(part);
      continue;
    }
    if (part.length >= 3 && part.length <= 8) terms.add(part);
    for (const size of [6, 4]) {
      if (part.length < size) continue;
      for (let i = 0; i + size <= part.length; i += 2) {
        terms.add(part.slice(i, i + size));
        if (terms.size >= 40) break;
      }
    }
  }
  const ranked = [...terms].sort((a, b) => b.length - a.length).slice(0, MAX_TERMS);
  if (ranked.length === 0) return null;
  return ranked.map((term) => `"${term.replace(/"/g, "\"\"")}"`).join(" OR ");
}

export function likeNeedle(question: string): string | null {
  const parts = question.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter((part) => part.length >= 2);
  if (parts.length === 0) return null;
  return parts.sort((a, b) => b.length - a.length)[0].slice(0, 32);
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
