import { useCallback, useEffect, useState } from "react";
import {
  ArrowClockwise,
  Plus,
  Rss,
  Trash,
} from "@phosphor-icons/react";
import { api } from "../lib/api";
import { fullDate, timeAgo } from "../lib/format";
import type { Feed } from "../lib/types";
import { EmptyState, ErrorBanner, Spinner, Tag } from "../components/ui";

export default function FeedsView({ onFeedsChanged }: { onFeedsChanged?: () => void }) {
  const [feeds, setFeeds] = useState<Feed[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [adding, setAdding] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setFeeds(await api.listFeeds());
    } catch (err) {
      setError((err as Error).message);
      setFeeds([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setAdding(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.addFeed(url.trim(), note.trim());
      setNotice(`已添加「${result.title}」，首次抓取新增 ${result.added} 条`);
      setUrl("");
      setNote("");
      await load();
      onFeedsChanged?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(feed: Feed) {
    if (!window.confirm(`删除订阅「${feed.title}」及其全部条目？`)) return;
    try {
      await api.deleteFeed(feed.id);
      await load();
      onFeedsChanged?.();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleFetchAll() {
    setFetching(true);
    setNotice(null);
    setError(null);
    try {
      const results = await api.fetchAllFeeds();
      const total = results.reduce((n, r) => n + r.added, 0);
      const failed = results.filter((r) => r.error);
      setNotice(
        failed.length
          ? `抓取完成：新增 ${total} 条，${failed.length} 个源失败`
          : `抓取完成：新增 ${total} 条`,
      );
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setFetching(false);
    }
  }

  return (
    <div className="fade-in">
      <form className="add-feed" onSubmit={handleAdd}>
        <input
          className="input"
          type="url"
          placeholder="粘贴 RSS / Atom 订阅地址，例如 https://example.com/feed.xml"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
        />
        <input
          className="input"
          style={{ flex: "0 0 200px" }}
          type="text"
          placeholder="备注（可选）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button className="btn btn--primary" type="submit" disabled={adding}>
          {adding ? <Spinner /> : <Plus size={16} weight="bold" />}
          添加
        </button>
      </form>

      <div className="toolbar">
        <span className="topbar__hint">共 {feeds?.length ?? 0} 个订阅源</span>
        <div className="toolbar__spacer" />
        <button className="btn btn--ghost" onClick={handleFetchAll} disabled={fetching}>
          {fetching ? <Spinner /> : <ArrowClockwise size={16} />}
          立即抓取全部
        </button>
      </div>

      {error && <ErrorBanner message={error} />}
      {notice && (
        <div className="error-banner" style={{ background: "var(--green-bg)", color: "var(--green-ink)" }}>
          {notice}
        </div>
      )}

      {feeds === null ? (
        <div>
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton" style={{ height: 72, borderRadius: 10, marginBottom: 8 }} />
          ))}
        </div>
      ) : feeds.length === 0 ? (
        <EmptyState
          icon={Rss}
          title="还没有订阅源"
          desc="把常看的信息源（博客、Newsletter、媒体 RSS）添加进来，工作台会定时抓取，为选题发现积累素材。"
        />
      ) : (
        <div className="feeds">
          {feeds.map((feed) => (
            <div className="feed" key={feed.id}>
              <div className="feed__main">
                <div className="feed__title">{feed.title}</div>
                <div className="feed__url">{feed.url}</div>
                <div className="feed__meta">
                  {feed.lastFetchedAt
                    ? `上次抓取 ${timeAgo(feed.lastFetchedAt)} · ${fullDate(feed.lastFetchedAt)}`
                    : "尚未抓取"}
                  {feed.note && <span> · {feed.note}</span>}
                </div>
              </div>
              {feed.lastError && (
                <Tag color="red" >抓取失败</Tag>
              )}
              <div className="feed__actions">
                <button
                  className="btn btn--icon btn--danger"
                  title="删除订阅"
                  onClick={() => handleDelete(feed)}
                >
                  <Trash size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
