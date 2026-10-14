/** 从剪贴板文本里取出第一条 http(s) 链接。普通文字返回 null，调用方不应报错。 */
export function findBoardLink(input: string): string | null {
  const match = input.trim().match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return null;
  const raw = match[0].replace(/[),.;，。；、]+$/u, "");
  if (raw.length > 2000) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return raw;
  } catch {
    return null;
  }
}
