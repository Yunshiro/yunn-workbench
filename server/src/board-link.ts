import { BoardError } from "./board-error.js";

/** 抓取超时。画板其他功能不依赖这次请求能否成功。 */
export const BOARD_FETCH_TIMEOUT_MS = 15_000;

const MAX_RESPONSE_BYTES = 1_500_000;
const WEB_TEXT_LIMIT = 8000;
const SUMMARY_LIMIT = 500;
const USER_AGENT = "Mozilla/5.0 (compatible; YunnWorkbench/0.1; +https://github.com/Yunshiro/yunn-workbench)";

export type LinkSource = "x" | "web" | "youtube";

export interface ClassifiedLink {
  source: LinkSource;
  canonicalUrl: string;
  dedupeKey: string;
  fetchUrl: string;
}

export interface CardMetrics {
  likes?: number;
  reposts?: number;
  replies?: number;
}

export interface FetchedLink {
  source: LinkSource;
  canonicalUrl: string;
  dedupeKey: string;
  title: string;
  authorName: string;
  authorHandle: string;
  authorAvatar: string | null;
  body: string;
  summary: string;
  imageUrl: string | null;
  siteName: string;
  metrics: CardMetrics | null;
  publishedAt: number | null;
}

let timeoutOverride: number | null = null;

/** 测试里把超时收短，避免真的等 15 秒。生产路径不调用。 */
export function setBoardFetchTimeoutForTests(ms: number | null): void {
  timeoutOverride = ms;
}

export function classifyBoardLink(input: string): ClassifiedLink | null {
  const match = input.trim().match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return null;
  const raw = match[0].replace(/[),.;，。；、]+$/u, "");
  if (raw.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;

  const xPost = parseX(url);
  if (xPost) {
    const canonicalUrl = xPost.user
      ? `https://x.com/${xPost.user}/status/${xPost.id}`
      : `https://x.com/i/status/${xPost.id}`;
    const fetchUrl = xPost.user
      ? `https://api.fxtwitter.com/${encodeURIComponent(xPost.user)}/status/${xPost.id}`
      : `https://api.fxtwitter.com/status/${xPost.id}`;
    return { source: "x", canonicalUrl, dedupeKey: `x:${xPost.id}`, fetchUrl };
  }

  const videoId = parseYouTube(url);
  if (videoId) {
    const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
    return {
      source: "youtube",
      canonicalUrl,
      dedupeKey: `youtube:${videoId}`,
      fetchUrl: `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(canonicalUrl)}`,
    };
  }

  const canonicalUrl = canonicalWebUrl(url);
  return { source: "web", canonicalUrl, dedupeKey: `web:${canonicalUrl}`, fetchUrl: canonicalUrl };
}

export async function fetchBoardLink(input: string): Promise<FetchedLink> {
  const classified = classifyBoardLink(input);
  if (!classified) throw new BoardError("请输入链接");
  const deadline = Date.now() + (timeoutOverride ?? BOARD_FETCH_TIMEOUT_MS);
  if (classified.source === "x") return finish(classified, await fetchX(classified, deadline));
  if (classified.source === "youtube") return finish(classified, await fetchYouTube(classified, deadline));
  return finish(classified, await fetchWeb(classified.fetchUrl, deadline));
}

function remaining(deadline: number): number {
  const left = deadline - Date.now();
  if (left <= 0) throw new BoardError("抓取失败");
  return left;
}

function finish(classified: ClassifiedLink, fetched: Omit<FetchedLink, "dedupeKey" | "canonicalUrl" | "source">): FetchedLink {
  return {
    ...fetched,
    source: classified.source,
    canonicalUrl: classified.canonicalUrl,
    dedupeKey: classified.dedupeKey,
  };
}

function parseX(url: URL): { user: string | null; id: string } | null {
  const host = bareHost(url.hostname);
  if (host !== "x.com" && host !== "twitter.com" && host !== "mobile.twitter.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const index = parts.findIndex((part) => part === "status" || part === "statuses");
  if (index < 0) return null;
  const id = parts[index + 1]?.match(/^(\d+)/)?.[1];
  if (!id) return null;
  let user = index > 0 ? parts[index - 1] : null;
  if (user && ["i", "intent", "share"].includes(user.toLowerCase())) user = null;
  return { user, id };
}

function parseYouTube(url: URL): string | null {
  const host = bareHost(url.hostname);
  const idPattern = /^[\w-]{6,}$/;
  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0]?.split("?")[0] || "";
    return idPattern.test(id) ? id : null;
  }
  if (host !== "youtube.com" && host !== "m.youtube.com" && host !== "music.youtube.com" && host !== "youtube-nocookie.com") {
    return null;
  }
  const fromQuery = url.searchParams.get("v") || "";
  if (url.pathname === "/watch" && idPattern.test(fromQuery)) return fromQuery;
  const parts = url.pathname.split("/").filter(Boolean);
  if (["shorts", "embed", "live", "v"].includes(parts[0] || "") && parts[1] && idPattern.test(parts[1])) return parts[1];
  return null;
}

function bareHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function canonicalWebUrl(url: URL): string {
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
  return url.toString();
}

async function fetchX(classified: ClassifiedLink, deadline: number): Promise<Omit<FetchedLink, "dedupeKey" | "canonicalUrl" | "source">> {
  const response = await request(classified.fetchUrl, deadline, "application/json");
  if (!response.ok) throw new BoardError("抓取失败");
  let data: any;
  try {
    data = JSON.parse(await readLimited(response, MAX_RESPONSE_BYTES));
  } catch {
    throw new BoardError("抓取失败");
  }
  const tweet = data?.tweet;
  const text = String(tweet?.text || tweet?.raw_text?.text || "").trim();
  if (!tweet || !text) throw new BoardError("抓取失败");
  const author = tweet.author || {};
  const image = tweetCover(tweet);
  return {
    title: author.name ? `${String(author.name)} 的帖子` : "X 帖子",
    authorName: String(author.name || "").trim(),
    authorHandle: String(author.screen_name || "").replace(/^@/, "").trim(),
    authorAvatar: httpUrl(author.avatar_url || author.avatar),
    body: text,
    summary: text.slice(0, SUMMARY_LIMIT),
    imageUrl: httpUrl(image),
    siteName: "X",
    metrics: {
      likes: count(tweet.likes ?? tweet.like_count),
      reposts: count(tweet.retweets ?? tweet.retweet_count ?? tweet.reposts),
      replies: count(tweet.replies ?? tweet.reply_count),
    },
    publishedAt: timestampMs(tweet.created_timestamp) ?? timestampMs(Date.parse(String(tweet.created_at || ""))),
  };
}

async function fetchYouTube(classified: ClassifiedLink, deadline: number): Promise<Omit<FetchedLink, "dedupeKey" | "canonicalUrl" | "source">> {
  try {
    const response = await request(classified.fetchUrl, deadline, "application/json");
    if (!response.ok) throw new BoardError("抓取失败");
    const data = JSON.parse(await readLimited(response, MAX_RESPONSE_BYTES));
    const title = String(data?.title || "").trim();
    if (!title) throw new BoardError("抓取失败");
    const authorName = String(data?.author_name || "").trim();
    return {
      title,
      authorName,
      authorHandle: "",
      authorAvatar: null,
      body: authorName ? `${title}\n${authorName}` : title,
      summary: title,
      imageUrl: httpUrl(data?.thumbnail_url),
      siteName: "YouTube",
      metrics: null,
      publishedAt: null,
    };
  } catch {
    if (Date.now() >= deadline) throw new BoardError("抓取失败");
    return fetchWeb(classified.canonicalUrl, deadline);
  }
}

async function fetchWeb(pageUrl: string, deadline: number): Promise<Omit<FetchedLink, "dedupeKey" | "canonicalUrl" | "source">> {
  const response = await request(pageUrl, deadline, "text/html,application/xhtml+xml");
  if (!response.ok) throw new BoardError("抓取失败");
  const type = response.headers.get("content-type") || "";
  if (type.includes("image/") || type.includes("audio/") || type.includes("video/")) throw new BoardError("抓取失败");
  const html = await readLimited(response, MAX_RESPONSE_BYTES);
  const description = metaContent(html, "og:description") || metaContent(html, "description") || "";
  const title = metaContent(html, "og:title") || htmlTitle(html) || "";
  const text = visibleText(html);
  const summarySource = description || text;
  const bodySource = text.length > description.length ? text : description || text;
  if (!title.trim() && !summarySource.trim()) throw new BoardError("抓取失败");
  let hostname = pageUrl;
  try { hostname = new URL(pageUrl).hostname; } catch { /* 保留原文本 */ }
  return {
    title: title.trim() || hostname,
    authorName: "",
    authorHandle: "",
    authorAvatar: null,
    body: (bodySource || title).trim().slice(0, WEB_TEXT_LIMIT),
    summary: summarySource.trim().slice(0, SUMMARY_LIMIT) || title.trim(),
    imageUrl: httpUrl(metaContent(html, "og:image"), pageUrl),
    siteName: metaContent(html, "og:site_name") || hostname,
    metrics: null,
    publishedAt: null,
  };
}

async function request(url: string, deadline: number, accept: string): Promise<Response> {
  const signal = AbortSignal.timeout(remaining(deadline));
  let response: Response;
  try {
    response = await fetch(url, {
      signal,
      redirect: "follow",
      headers: { Accept: accept, "User-Agent": USER_AGENT },
    });
  } catch {
    throw new BoardError("抓取失败");
  }
  const finalUrl = response.url || url;
  let parsed: URL;
  try { parsed = new URL(finalUrl); }
  catch { throw new BoardError("抓取失败"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new BoardError("抓取失败");
  return response;
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return (await response.text()).slice(0, maxBytes);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const size = Math.min(total, maxBytes);
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    const slice = chunk.subarray(0, size - offset);
    buffer.set(slice, offset);
    offset += slice.byteLength;
    if (offset >= size) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
}

function metaContent(html: string, key: string): string | null {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  const needle = key.toLowerCase();
  for (const tag of tags) {
    const property = (attr(tag, "property") || attr(tag, "name") || "").toLowerCase();
    if (property !== needle) continue;
    const content = attr(tag, "content");
    if (content) return content;
  }
  return null;
}

function attr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
  return match ? decodeEntities(match[2]).trim() : null;
}

function htmlTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return "";
  return decodeEntities(match[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function visibleText(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(stripped).replace(/\s+/g, " ").trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, digits: string) => {
      const code = Number(digits);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    });
}

function firstHttp(items: unknown[], key: "url" | "thumbnail_url"): string | undefined {
  if (!Array.isArray(items)) return undefined;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const value = (item as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/** 图片优先用照片；纯视频帖用 FxTwitter 的 thumbnail_url 当封面。 */
function tweetCover(tweet: { media?: { photos?: unknown; videos?: unknown; video?: unknown; all?: unknown } }): string | undefined {
  const media = tweet.media || {};
  const photos = Array.isArray(media.photos) ? media.photos : [];
  const photo = firstHttp(photos, "url");
  if (photo) return photo;
  const videos = Array.isArray(media.videos) ? media.videos : media.video ? [media.video] : [];
  const thumbnail = firstHttp(videos, "thumbnail_url");
  if (thumbnail) return thumbnail;
  const all = Array.isArray(media.all) ? media.all : [];
  return firstHttp(all, "thumbnail_url") || firstHttp(all, "url") || firstHttp(photos, "thumbnail_url");
}

function httpUrl(value: unknown, base?: string): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim(), base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function count(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) return undefined;
  return Math.round(number);
}

function timestampMs(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number < 1e12 ? Math.round(number * 1000) : Math.round(number);
}
