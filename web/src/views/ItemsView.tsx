import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowSquareOut,
  CaretDown,
  CaretRight,
  CheckSquareOffset,
  Gauge,
  MagnifyingGlass,
  NotePencil,
  Rss,
  Sparkle,
  Stack,
  Star,
} from "@phosphor-icons/react";
import { api } from "../lib/api";
import { timeAgo, truncate } from "../lib/format";
import type { Feed, Item, Task, TaskKind } from "../lib/types";
import { Checkbox, EmptyState, ErrorBanner, SkeletonList } from "../components/ui";
import TaskLiveModal from "../components/TaskLiveModal";

type Mode = "all" | "unread" | "starred";

const TASK_ACTIONS: { kind: TaskKind; label: string; icon: typeof NotePencil }[] = [
  { kind: "summarize", label: "摘要", icon: NotePencil },
  { kind: "evaluate", label: "评估", icon: Gauge },
  { kind: "cluster", label: "聚类", icon: Stack },
  { kind: "ideate", label: "找选题", icon: Sparkle },
];

export default function ItemsView({ onUnreadChange }: { onUnreadChange?: (n: number) => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>("all");
  const [feedId, setFeedId] = useState("");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [running, setRunning] = useState(false);

  const loadFeeds = useCallback(async () => {
    try {
      setFeeds(await api.listFeeds());
    } catch {
      /* 非关键 */
    }
  }, []);

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await api.listItems({
        feedId: feedId || undefined,
        unread: mode === "unread",
        starred: mode === "starred",
        query: debouncedQuery || undefined,
        limit: 300,
      });
      setItems(res.items);
      onUnreadChange?.(res.unread);
    } catch (err) {
      setError((err as Error).message);
      setItems([]);
    }
  }, [feedId, mode, debouncedQuery, onUnreadChange]);

  useEffect(() => {
    void loadFeeds();
  }, [loadFeeds]);

  useEffect(() => {
    void load();
  }, [load]);

  // 搜索防抖
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 350);
    return () => clearTimeout(t);
  }, [query]);

  async function toggleStar(item: Item) {
    const next = !item.isStarred;
    setItems((prev) => prev?.map((it) => (it.id === item.id ? { ...it, isStarred: next } : it)) ?? null);
    try {
      await api.setStar(item.id, next);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function toggleRead(item: Item) {
    const next = !item.isRead;
    setItems((prev) => prev?.map((it) => (it.id === item.id ? { ...it, isRead: next } : it)) ?? null);
    try {
      const res = await api.setRead(item.id, next);
      onUnreadChange?.(res.unread);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function markAllRead() {
    try {
      const res = await api.markAllRead(feedId || undefined);
      onUnreadChange?.(res.unread);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allVisibleSelected = useMemo(() => {
    if (!items || items.length === 0) return false;
    return items.every((it) => selected.has(it.id));
  }, [items, selected]);

  function toggleSelectAll() {
    if (!items) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        items.forEach((it) => next.delete(it.id));
      } else {
        items.forEach((it) => next.add(it.id));
      }
      return next;
    });
  }

  async function runTask(kind: TaskKind) {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setRunning(true);
    setError(null);
    try {
      const task = await api.createTask(kind, ids);
      setActiveTask(task);
      setSelected(new Set());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }

  const selectedCount = selected.size;
  const feedName = useMemo(
    () => (feedId ? feeds.find((f) => f.id === feedId)?.title ?? "" : ""),
    [feedId, feeds],
  );

  return (
    <div className="fade-in">
      {/* 工具条 */}
      <div className="toolbar">
        <div className="seg">
          {(
            [
              ["all", "全部"],
              ["unread", "未读"],
              ["starred", "星标"],
            ] as [Mode, string][]
          ).map(([m, label]) => (
            <button
              key={m}
              className={`seg__btn${mode === m ? " seg__btn--active" : ""}`}
              onClick={() => setMode(m)}
            >
              {label}
            </button>
          ))}
        </div>

        <select className="select" value={feedId} onChange={(e) => setFeedId(e.target.value)}>
          <option value="">全部来源</option>
          {feeds.map((f) => (
            <option key={f.id} value={f.id}>
              {f.title}
            </option>
          ))}
        </select>

        <div className="search">
          <MagnifyingGlass size={15} />
          <input
            className="input"
            placeholder="搜索标题 / 正文…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="toolbar__spacer" />
        <button className="btn btn--ghost btn--sm" onClick={markAllRead}>
          <CheckSquareOffset size={15} />
          {feedName ? `标记「${feedName}」已读` : "全部已读"}
        </button>
      </div>

      {error && <ErrorBanner message={error} />}

      {items === null ? (
        <SkeletonList count={6} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Rss}
          title={mode === "all" && !feedId && !debouncedQuery ? "还没有信息条目" : "没有匹配的条目"}
          desc={
            mode === "all" && !feedId && !debouncedQuery
              ? "先在「订阅源」里添加 RSS 源，抓取完成后信息会出现在这里。"
              : "试试切换筛选条件，或清空搜索关键词。"
          }
        />
      ) : (
        <div className="items">
          {/* 全选 */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 4px 2px" }}>
            <Checkbox checked={allVisibleSelected} onChange={toggleSelectAll} />
            <span className="topbar__hint">全选当前列表</span>
          </div>

          {items.map((item) => {
            const isExpanded = expanded.has(item.id);
            const isSel = selected.has(item.id);
            return (
              <div
                key={item.id}
                className={`item${item.isRead ? " item--read" : " item--unread"}`}
              >
                <div className="item__head">
                  <div className="item__check">
                    <Checkbox checked={isSel} onChange={() => toggleSelect(item.id)} />
                  </div>

                  <div className="item__main">
                    <button
                      className="item__title"
                      style={{
                        background: "none",
                        border: "none",
                        padding: 0,
                        textAlign: "left",
                        width: "100%",
                        cursor: "pointer",
                      }}
                      onClick={() => toggleExpand(item.id)}
                    >
                      {item.title}
                    </button>
                    <div className="item__meta">
                      {item.feedTitle && <span className="item__feed">{item.feedTitle}</span>}
                      {item.author && <span>{item.author}</span>}
                      <span className="mono">{timeAgo(item.publishedAt ?? item.fetchedAt)}</span>
                    </div>
                  </div>

                  <div className="item__actions">
                    <button
                      className="btn btn--icon"
                      title={item.isStarred ? "取消星标" : "星标"}
                      onClick={() => toggleStar(item)}
                    >
                      <Star size={17} weight={item.isStarred ? "fill" : "regular"} />
                    </button>
                    <button
                      className="btn btn--icon"
                      title={item.isRead ? "标记未读" : "标记已读"}
                      onClick={() => toggleRead(item)}
                    >
                      {item.isRead ? (
                        <span style={{ fontSize: 11, color: "var(--faint)", width: 17, textAlign: "center" }}>已读</span>
                      ) : (
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", display: "inline-block" }} />
                      )}
                    </button>
                    <a
                      className="btn btn--icon"
                      href={item.link}
                      target="_blank"
                      rel="noreferrer"
                      title="打开原文"
                    >
                      <ArrowSquareOut size={16} />
                    </a>
                    <button
                      className="btn btn--icon"
                      title="展开 / 收起"
                      onClick={() => toggleExpand(item.id)}
                    >
                      {isExpanded ? <CaretDown size={15} /> : <CaretRight size={15} />}
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="item__body">
                    {item.contentText ? truncate(item.contentText, 3000) : "（无正文，点击标题右侧图标查看原文）"}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 选择工具条 */}
      {selectedCount > 0 && (
        <div className="selectbar">
          <span className="selectbar__label">已选 {selectedCount} 条</span>
          {TASK_ACTIONS.map((a) => {
            const Icon = a.icon;
            return (
              <button
                key={a.kind}
                className="btn"
                disabled={running}
                onClick={() => runTask(a.kind)}
              >
                <Icon size={15} weight="bold" />
                {a.label}
              </button>
            );
          })}
          <button className="btn" onClick={() => setSelected(new Set())}>
            取消选择
          </button>
        </div>
      )}

      {activeTask && (
        <TaskLiveModal
          task={activeTask}
          onClose={() => setActiveTask(null)}
          onFinished={() => {
            /* 完成后刷新列表（如摘要等不影响条目，可留空） */
          }}
        />
      )}
    </div>
  );
}
