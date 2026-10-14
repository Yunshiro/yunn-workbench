/** 把来源正文收成一行短摘录，供引用卡片展示。 */
export function excerpt(content: string, max = 280): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * 回答里出现 [n] 时只保留被点名的来源。
 * 没有编号时保留全部来源，避免一次提问的依据被悄悄丢掉。
 */
export function selectCitations<T extends { index: number }>(answer: string, sources: T[]): T[] {
  const used = sources.filter((source) => new RegExp(`\\[${source.index}\\](?!\\d)`).test(answer));
  return used.length > 0 ? used : sources;
}
