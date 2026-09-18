import { useCallback, useEffect, useState } from "react";
import { Lightbulb, Trash } from "@phosphor-icons/react";
import { api } from "../lib/api";
import { useEvent } from "../lib/sse";
import { languageLabel, statusLabel, timeAgo } from "../lib/format";
import type { Topic, TopicStatus } from "../lib/types";
import { EmptyState, ErrorBanner, SkeletonList, Tag } from "../components/ui";

type Filter = "all" | TopicStatus;

const STATUS_OPTIONS: TopicStatus[] = ["new", "writing", "done", "discarded"];

export default function TopicsView() {
  const [topics, setTopics] = useState<Topic[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setTopics(await api.listTopics());
    } catch (err) {
      setError((err as Error).message);
      setTopics([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 找选题任务完成后，选题会自动入库 → 刷新看板
  useEvent("topics_created", () => {
    void load();
  });

  async function changeStatus(topic: Topic, status: TopicStatus) {
    setTopics((prev) => prev?.map((t) => (t.id === topic.id ? { ...t, status } : t)) ?? null);
    try {
      await api.setTopicStatus(topic.id, status);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(topic: Topic) {
    if (!window.confirm(`删除选题「${topic.title}」？`)) return;
    try {
      await api.deleteTopic(topic.id);
      setTopics((prev) => prev?.filter((t) => t.id !== topic.id) ?? null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const visible = topics?.filter((t) => filter === "all" || t.status === filter) ?? null;

  return (
    <div className="fade-in">
      <div className="toolbar">
        <div className="seg">
          {(
            [
              ["all", "全部"],
              ["new", "新选题"],
              ["writing", "写作中"],
              ["done", "已完成"],
              ["discarded", "已丢弃"],
            ] as [Filter, string][]
          ).map(([f, label]) => (
            <button
              key={f}
              className={`seg__btn${filter === f ? " seg__btn--active" : ""}`}
              onClick={() => setFilter(f)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="toolbar__spacer" />
        <span className="topbar__hint">
          {visible ? `${visible.length} 个选题` : ""}
        </span>
      </div>

      {error && <ErrorBanner message={error} />}

      {topics === null ? (
        <SkeletonList count={3} />
      ) : visible && visible.length === 0 ? (
        <EmptyState
          icon={Lightbulb}
          title={filter === "all" ? "还没有选题" : "该状态下没有选题"}
          desc="在「信息流」里勾选几条素材，点击「找选题」，AI 会生成可写的选题并自动写入这里。"
        />
      ) : (
        <div className="topics">
          {visible?.map((topic) => (
            <div className="topic" key={topic.id}>
              <div className="topic__head">
                <div className="topic__title">{topic.title}</div>
                <button className="btn btn--icon btn--danger" title="删除" onClick={() => remove(topic)}>
                  <Trash size={15} />
                </button>
              </div>

              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <Tag color="ink">{topic.type === "article" ? "长文" : "推文"}</Tag>
                {topic.language && <Tag color="blue">{languageLabel(topic.language)}</Tag>}
                <Tag color="gray">{timeAgo(topic.createdAt)}</Tag>
              </div>

              {topic.angle && (
                <div>
                  <div className="topic__angle-label">切入角度</div>
                  <div className="topic__angle">{topic.angle}</div>
                </div>
              )}

              {topic.differentiation && (
                <div>
                  <div className="topic__angle-label">差异化</div>
                  <div className="topic__angle">{topic.differentiation}</div>
                </div>
              )}

              {topic.materials.length > 0 && (
                <div className="topic__mats">
                  <div className="topic__mats-label">素材依据</div>
                  <ul>
                    {topic.materials.map((m, i) => (
                      <li key={i}>{m}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="topic__foot">
                <span className="topbar__hint">状态</span>
                <select
                  className="select topic__status"
                  value={topic.status}
                  onChange={(e) => changeStatus(topic, e.target.value as TopicStatus)}
                >
                  {STATUS_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {statusLabel(s)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
