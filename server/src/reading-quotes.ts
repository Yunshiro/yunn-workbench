const QUOTE_MARKS = new Set(["“", "”", "「", "」", "『", "』", "\"", "'", "‘", "’", "《", "》"]);

const PUNCTUATION: Record<string, string> = {
  ",": "，",
  "，": "，",
  ".": "。",
  "。": "。",
  "．": "。",
  "!": "！",
  "！": "！",
  "?": "？",
  "？": "？",
  ";": "；",
  "；": "；",
  ":": "：",
  "：": "：",
  "、": "、",
  "—": "—",
  "–": "—",
  "…": "…",
};

export interface CompactText {
  compact: string;
  offsets: number[];
}

/** 去掉空白和引号，并把标点收成同一种写法，同时记住每个保留字符在原文中的位置。 */
export function compactText(input: string): CompactText {
  let compact = "";
  const offsets: number[] = [];
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (/\s/u.test(character) || QUOTE_MARKS.has(character)) continue;
    const mapped = PUNCTUATION[character];
    compact += mapped ?? character.toLowerCase();
    offsets.push(index);
  }
  return { compact, offsets };
}

function sliceOriginal(chapterText: string, map: CompactText, start: number, length: number): string {
  const from = map.offsets[start];
  const to = map.offsets[start + length - 1] + 1;
  return chapterText.slice(from, to).trim();
}

/**
 * 原句必须能在章节原文里找到。核对成功时返回原文中的那一段，而不是模型改写后的文本。
 * 带省略号的句子无法确定中间缺了什么，一律不保留。
 */
export function locateQuote(quote: string, chapterText: string): string | null {
  const trimmed = quote.trim();
  if (!trimmed || /…|\.{3,}|。{3,}/u.test(trimmed)) return null;
  return locateExact(trimmed, chapterText);
}

function locateExact(quote: string, chapterText: string): string | null {
  const needle = compactText(quote);
  if (needle.compact.length < 8) return null;
  const haystack = compactText(chapterText);
  const at = haystack.compact.indexOf(needle.compact);
  if (at < 0) return null;
  return sliceOriginal(chapterText, haystack, at, needle.compact.length);
}

export function verifyQuotes(candidates: string[], chapterText: string, limit = 5): { quotes: string[]; dropped: number } {
  const quotes: string[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const candidate of candidates) {
    const located = locateQuote(candidate, chapterText);
    if (!located) {
      if (candidate.trim()) dropped += 1;
      continue;
    }
    const key = compactText(located).compact;
    if (seen.has(key)) continue;
    seen.add(key);
    quotes.push(located);
    if (quotes.length >= limit) break;
  }
  return { quotes, dropped };
}

const VERDICT = /值不值得读|值得一读|不值得读|值得细读|不值得细读|值得推荐|不值得推荐|推荐阅读|不推荐阅读|是否值得/;

/** 去掉模型擅自加上的“值不值得读”结论，保留其余句子。 */
export function stripVerdicts(text: string): string {
  return text
    .split(/(?<=[。！？\n])/u)
    .filter((part) => part.trim() && !VERDICT.test(part))
    .join("")
    .trim();
}
