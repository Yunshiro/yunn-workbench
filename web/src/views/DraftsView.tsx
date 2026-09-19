import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, MagnifyingGlass, Plus, Trash } from "@phosphor-icons/react";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";
import type { Draft, DraftStatus, Topic } from "../lib/types";
import { EmptyState, ErrorBanner, Spinner, Tag } from "../components/ui";

type Filter = "all" | DraftStatus;
type SaveState = "saved" | "dirty" | "saving";

export default function DraftsView({ createForTopicId }: { createForTopicId?: string | null }) {
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [active, setActive] = useState<Draft | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [topicFilter, setTopicFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialDraftCreated = useRef(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [nextDrafts, nextTopics] = await Promise.all([api.listDrafts(), api.listTopics()]);
      setDrafts(nextDrafts);
      setTopics(nextTopics);
      setActive((current) => current ? nextDrafts.find((draft) => draft.id === current.id) ?? null : nextDrafts[0] ?? null);
    } catch (err) {
      setError((err as Error).message);
      setDrafts([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const createDraft = useCallback(async (topicId?: string | null) => {
    try {
      setCreating(true);
      setError(null);
      const draft = await api.createDraft({ topicId: topicId || null });
      setDrafts((current) => [draft, ...(current ?? [])]);
      setActive(draft);
      setSaveState("saved");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }, []);

  useEffect(() => {
    if (drafts === null || !createForTopicId || initialDraftCreated.current) return;
    initialDraftCreated.current = true;
    void createDraft(createForTopicId);
  }, [createForTopicId, createDraft, drafts]);

  useEffect(() => {
    if (!active || saveState !== "dirty") return;
    const snapshot = active;
    const timer = window.setTimeout(async () => {
      setSaveState("saving");
      try {
        const saved = await api.updateDraft(snapshot.id, {
          title: snapshot.title,
          content: snapshot.content,
          topicId: snapshot.topicId,
          status: snapshot.status,
        });
        setDrafts((current) => current?.map((draft) => draft.id === saved.id ? saved : draft) ?? null);
        setActive((current) => current?.id === saved.id ? { ...saved, title: current.title, content: current.content, topicId: current.topicId, status: current.status } : current);
        setSaveState((current) => current === "saving" ? "saved" : current);
      } catch (err) {
        setError((err as Error).message);
        setSaveState("dirty");
      }
    }, 700);
    return () => window.clearTimeout(timer);
  }, [active, saveState]);

  function edit(patch: Partial<Pick<Draft, "title" | "content" | "topicId" | "status">>) {
    setActive((current) => current ? { ...current, ...patch } : current);
    setDrafts((current) => current?.map((draft) => draft.id === active?.id ? { ...draft, ...patch } : draft) ?? null);
    setSaveState("dirty");
  }

  async function remove(draft: Draft) {
    if (!window.confirm(`删除草稿「${draft.title}」？此操作无法撤销。`)) return;
    try {
      await api.deleteDraft(draft.id);
      const remaining = drafts?.filter((item) => item.id !== draft.id) ?? [];
      setDrafts(remaining);
      if (active?.id === draft.id) setActive(remaining[0] ?? null);
      setSaveState("saved");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function selectDraft(draft: Draft) {
    if (active && saveState === "dirty") {
      try {
        const saved = await api.updateDraft(active.id, {
          title: active.title,
          content: active.content,
          topicId: active.topicId,
          status: active.status,
        });
        setDrafts((current) => current?.map((item) => item.id === saved.id ? saved : item) ?? null);
      } catch (err) {
        setError((err as Error).message);
        return;
      }
    }
    setActive(draft);
    setSaveState("saved");
  }

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return drafts?.filter((draft) => {
      if (filter !== "all" && draft.status !== filter) return false;
      if (topicFilter === "independent" && draft.topicId !== null) return false;
      if (topicFilter !== "all" && topicFilter !== "independent" && draft.topicId !== topicFilter) return false;
      return !needle || draft.title.toLowerCase().includes(needle) || draft.content.toLowerCase().includes(needle);
    }) ?? [];
  }, [drafts, filter, topicFilter, query]);

  const charCount = Array.from(active?.content ?? "").length;

  return (
    <div className="drafts-page fade-in">
      <div className="toolbar drafts-toolbar">
        <div className="seg">
          {([["all", "全部"], ["draft", "草稿"], ["published", "已发布"]] as [Filter, string][]).map(([value, label]) => (
            <button key={value} className={`seg__btn${filter === value ? " seg__btn--active" : ""}`} onClick={() => setFilter(value)}>{label}</button>
          ))}
        </div>
        <select className="select" value={topicFilter} onChange={(event) => setTopicFilter(event.target.value)} aria-label="按选题筛选">
          <option value="all">全部选题</option>
          <option value="independent">独立草稿</option>
          {topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.title}</option>)}
        </select>
        <label className="draft-search">
          <MagnifyingGlass size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索草稿" />
        </label>
        <div className="toolbar__spacer" />
        <button className="btn btn--primary" onClick={() => void createDraft(null)} disabled={creating}>
          {creating ? <Spinner size={14} /> : <Plus size={15} weight="bold" />} 新建草稿
        </button>
      </div>

      {error && <ErrorBanner message={error} />}

      <div className="drafts-layout">
        <aside className="draft-list">
          <div className="draft-list__meta">{drafts === null ? "正在载入…" : `${visible.length} 篇推文草稿`}</div>
          {drafts !== null && visible.length === 0 ? (
            <div className="draft-list__empty">没有符合条件的草稿</div>
          ) : visible.map((draft) => (
            <button key={draft.id} className={`draft-card${active?.id === draft.id ? " draft-card--active" : ""}`} onClick={() => void selectDraft(draft)}>
              <span className="draft-card__title">{draft.title || "未命名草稿"}</span>
              <span className="draft-card__preview">{draft.content || "还没有正文内容"}</span>
              <span className="draft-card__meta">
                <Tag color={draft.status === "published" ? "green" : "gray"}>{draft.status === "published" ? "已发布" : "草稿"}</Tag>
                <span>{draft.topicTitle || "独立草稿"}</span>
                <span>{timeAgo(draft.updatedAt)}</span>
              </span>
            </button>
          ))}
        </aside>

        <section className="draft-editor">
          {!active ? (
            <EmptyState icon={FileText} title="选择或新建一篇草稿" desc="独立记录灵感，或从选题看板创建关联草稿。" action={<button className="btn btn--primary" onClick={() => void createDraft(null)}><Plus size={15} /> 新建草稿</button>} />
          ) : (
            <>
              <div className="draft-editor__head">
                <div>
                  <div className="draft-editor__eyebrow">推文草稿</div>
                  <div className={`draft-save-state draft-save-state--${saveState}`}>{saveState === "saving" ? "正在保存…" : saveState === "dirty" ? "等待保存" : "已自动保存"}</div>
                </div>
                <button className="btn btn--icon btn--danger" title="删除草稿" onClick={() => void remove(active)}><Trash size={16} /></button>
              </div>

              <input className="draft-editor__title" value={active.title} onChange={(event) => edit({ title: event.target.value })} placeholder="草稿标题（仅用于管理）" />

              <div className="draft-editor__fields">
                <label>
                  <span>关联选题</span>
                  <select className="select" value={active.topicId ?? ""} onChange={(event) => edit({ topicId: event.target.value || null })}>
                    <option value="">不关联选题</option>
                    {topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.title}</option>)}
                  </select>
                </label>
                <label>
                  <span>状态</span>
                  <select className="select" value={active.status} onChange={(event) => edit({ status: event.target.value as DraftStatus })}>
                    <option value="draft">草稿</option>
                    <option value="published">已发布</option>
                  </select>
                </label>
              </div>

              <div className="draft-editor__body">
                <textarea value={active.content} onChange={(event) => edit({ content: event.target.value })} placeholder="写下你的推文……" autoFocus />
                <div className={`draft-editor__count${charCount > 280 ? " draft-editor__count--over" : ""}`}>
                  {charCount} / 280
                </div>
              </div>
              {charCount > 280 && <div className="draft-editor__warning">内容已超过 280 个字符，请精简后再发布。</div>}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
