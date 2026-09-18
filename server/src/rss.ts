import Parser from "rss-parser";
import { createHash } from "node:crypto";
import {
  getFeed,
  insertFeed,
  listFeeds,
  upsertItem,
  updateFeedFetchState,
} from "./db.js";
import { FETCH_TIMEOUT_MS } from "./config.js";

const parser = new Parser({
  timeout: FETCH_TIMEOUT_MS,
  headers: { "User-Agent": "workbench/0.1 (+local rss reader)" },
});

/** 拉取某个 URL 的 feed 元信息与条目 */
export async function probeFeed(url: string): Promise<{ title: string; url: string; items: RawItem[] }> {
  const feed = await parser.parseURL(url);
  const title = feed.title || url;
  const items: RawItem[] = (feed.items || []).map((it) => {
    const guid = it.guid || it.id || it.link || `${url}#${it.title}`;
    const contentHtml = it["content:encoded"] || it.content || it.summary || "";
    return {
      guid: String(guid),
      title: it.title || "(无标题)",
      link: it.link || url,
      author: it.creator || it["dc:creator"] || null,
      contentHtml,
      contentText: stripHtml(contentHtml),
      publishedAt: it.isoDate ? Date.parse(it.isoDate) : it.pubDate ? Date.parse(it.pubDate) : null,
    };
  });
  return { title, url: feed.feedUrl || url, items };
}

export interface RawItem {
  guid: string;
  title: string;
  link: string;
  author: string | null;
  contentHtml: string;
  contentText: string;
  publishedAt: number | null;
}

/** 抓取并入库一个 feed，返回新增条目数 */
export async function fetchFeed(feedId: string): Promise<number> {
  const feed = getFeed(feedId);
  if (!feed) throw new Error(`Feed not found: ${feedId}`);

  let added = 0;
  try {
    const result = await probeFeed(feed.url);
    // 若标题还是默认 URL，尝试更新为 feed 提供的标题
    for (const item of result.items) {
      const isNew = upsertItem({
        feedId: feed.id,
        guid: item.guid,
        title: item.title,
        link: item.link,
        author: item.author,
        contentHtml: item.contentHtml,
        contentText: item.contentText,
        publishedAt: item.publishedAt,
      });
      if (isNew) added++;
    }
    updateFeedFetchState(feed.id, null);
    return added;
  } catch (err) {
    updateFeedFetchState(feed.id, String((err as Error).message || err));
    throw err;
  }
}

/** 抓取全部 feed，返回每个 feed 的结果摘要 */
export async function fetchAllFeeds(): Promise<{ feedId: string; title: string; added: number; error?: string }[]> {
  const feeds = listFeeds();
  const results: { feedId: string; title: string; added: number; error?: string }[] = [];
  for (const feed of feeds) {
    try {
      const added = await fetchFeed(feed.id);
      results.push({ feedId: feed.id, title: feed.title, added });
    } catch (err) {
      results.push({ feedId: feed.id, title: feed.title, added: 0, error: String((err as Error).message || err) });
    }
  }
  return results;
}

/** 探测一个 RSS URL（用于用户添加源时预览） */
export async function probeForAdd(url: string): Promise<{ title: string; url: string; sampleCount: number }> {
  const result = await probeFeed(url);
  return { title: result.title, url: result.url, sampleCount: result.items.length };
}

/** 添加一个源：先探测拿标题，再入库并抓取 */
export async function addFeedByUrl(url: string, note = ""): Promise<{ feedId: string; title: string; added: number }> {
  const probe = await probeForAdd(url);
  const feed = insertFeed(probe.title || url, probe.url || url, note);
  let added = 0;
  try {
    added = await fetchFeed(feed.id);
  } catch {
    // 抓取失败不影响“源已添加”，下次定时再试
  }
  return { feedId: feed.id, title: feed.title, added };
}

/** 简易 HTML 去标签 */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** 生成条目稳定 guid（兜底用） */
export function makeGuid(url: string, title: string): string {
  return createHash("sha1").update(`${url}|${title}`).digest("hex");
}
