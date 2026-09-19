import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CaretDown, CaretUp, CheckCircle, X, XCircle } from "@phosphor-icons/react";
import { onEvent } from "../lib/sse";
import { kindLabel, languageLabel, statusLabel, timeAgo } from "../lib/format";
import type { Task } from "../lib/types";
import { Spinner, StatusDot, Tag } from "./ui";

function ScoreBadge({ score }: { score: number }) {
  const tone = score >= 7 ? "green" : score >= 4 ? "yellow" : "red";
  return (
    <div className="output__score">
      <span className="num">{score}</span>
      <span className="output__label" style={{ margin: 0 }}>/ 10</span>
      <Tag color={tone}>{score >= 7 ? "值得写" : score >= 4 ? "一般" : "价值低"}</Tag>
    </div>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="output__block">
      <div className="output__label">{label}</div>
      {children}
    </div>
  );
}

function StringList({ items }: { items: unknown }) {
  if (!Array.isArray(items) || items.length === 0) return <span style={{ color: "var(--faint)" }}>无</span>;
  return (
    <ul className="output__list">
      {items.map((it, i) => (
        <li key={i}>{String(it)}</li>
      ))}
    </ul>
  );
}

function KvRow({ k, v }: { k: string; v: unknown }) {
  return (
    <div className="kv__row">
      <div className="kv__key">{k}</div>
      <div className="kv__val">{v == null || v === "" ? "—" : String(v)}</div>
    </div>
  );
}

/** 按任务类型渲染结构化输出 */
function OutputRenderer({ kind, parsed }: { kind: string; parsed: any }) {
  if (!parsed || typeof parsed !== "object") return null;

  if (kind === "summarize") {
    return (
      <div className="output">
        <Block label="整体摘要">{parsed.summary ?? "—"}</Block>
        <Block label="核心观点">
          <StringList items={parsed.key_points} />
        </Block>
        <Block label="值得引用的原句">
          <StringList items={parsed.quotes} />
        </Block>
        <Block label="数据与事实">
          <StringList items={parsed.data_points} />
        </Block>
        <Tag color="blue">建议语言 · {languageLabel(parsed.language)}</Tag>
      </div>
    );
  }

  if (kind === "evaluate") {
    return (
      <div className="output">
        <Block label="综合评分">
          <ScoreBadge score={Number(parsed.score) || 0} />
        </Block>
        <div className="output__block">
          <div className="kv">
            <KvRow k="新颖度" v={parsed.novelty} />
            <KvRow k="信息密度" v={parsed.depth} />
            <KvRow k="可信度" v={parsed.credibility} />
            <KvRow k="是否值得写" v={parsed.worth_writing ? "是" : "否"} />
            <KvRow k="理由" v={parsed.reason} />
            <KvRow k="建议角度" v={parsed.suggested_angle} />
          </div>
        </div>
      </div>
    );
  }

  if (kind === "cluster") {
    const clusters = Array.isArray(parsed.clusters) ? parsed.clusters : [];
    return (
      <div className="output">
        {clusters.map((c: any, i: number) => (
          <div className="output__block" key={i}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
              <span style={{ fontWeight: 650, fontSize: 14 }}>{c.theme}</span>
              <Tag color="blue">{languageLabel(c.language)}</Tag>
              {Array.isArray(c.item_indexes) && c.item_indexes.length > 0 && (
                <Tag color="gray">条目 {c.item_indexes.join("、")}</Tag>
              )}
              {c.trend && <Tag color={String(c.trend).includes("上升") || String(c.trend).toLowerCase().includes("up") ? "red" : "green"}>{c.trend}</Tag>}
            </div>
            <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.65 }}>{c.description}</div>
          </div>
        ))}
        <Block label="整体观察">{parsed.overall ?? "—"}</Block>
      </div>
    );
  }

  if (kind === "ideate") {
    const topics = Array.isArray(parsed.topics) ? parsed.topics : [];
    return (
      <div className="output">
        {topics.map((t: any, i: number) => (
          <div className="output__block" key={i}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 650, fontSize: 14.5 }}>{t.title}</span>
              <Tag color="ink">{t.type === "article" ? "长文" : "推文"}</Tag>
              <Tag color="blue">{languageLabel(t.language)}</Tag>
            </div>
            <div className="topic__angle-label">切入角度</div>
            <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.65, marginBottom: 10 }}>{t.angle ?? "—"}</div>
            <div className="topic__angle-label">差异化</div>
            <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.65, marginBottom: 10 }}>{t.differentiation ?? "—"}</div>
            <div className="topic__angle-label">素材依据</div>
            <StringList items={t.materials} />
          </div>
        ))}
        <Block label="选题策略">{parsed.strategy ?? "—"}</Block>
      </div>
    );
  }

  // 兜底：原样展示 JSON
  return (
    <pre style={{ fontFamily: "var(--font-mono)", fontSize: 12, whiteSpace: "pre-wrap" }}>
      {JSON.stringify(parsed, null, 2)}
    </pre>
  );
}

export default function TaskLiveModal({
  task: initial,
  onClose,
  onFinished,
}: {
  task: Task;
  onClose: () => void;
  onFinished?: (kind: string) => void;
}) {
  const [task, setTask] = useState<Task>(initial);
  const [stream, setStream] = useState(initial.output?.raw ?? "");
  const [thinking, setThinking] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const finishedRef = useRef(initial.status === "done" || initial.status === "error");
  const onFinishedRef = useRef(onFinished);
  const onCloseRef = useRef(onClose);
  const dialogRef = useRef<HTMLDivElement>(null);
  onFinishedRef.current = onFinished;
  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    document.body.classList.add("modal-open");
    dialogRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.classList.remove("modal-open");
      previouslyFocused?.focus();
    };
  }, []);

  useEffect(() => {
    if (finishedRef.current) return;

    const finish = (kind: string) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      setThinking(false);
      onFinishedRef.current?.(kind);
    };

    const offs = [
      onEvent("task_status", (d) => {
        if (d?.taskId !== initial.id) return;
        setTask((t) => ({ ...t, status: d.status }));
        if (d.status === "running") setThinking(true);
      }),
      onEvent("task_delta", (d) => {
        if (d?.taskId === initial.id) setStream((s) => s + (d.delta ?? ""));
      }),
      onEvent("task_thinking", (d) => {
        if (d?.taskId === initial.id) setThinking(true);
      }),
      onEvent("task_done", (d) => {
        if (d?.taskId !== initial.id) return;
        setTask((t) => ({ ...t, status: "done", output: d.output ?? t.output, finishedAt: Date.now() }));
        finish(d.kind);
      }),
      onEvent("task_error", (d) => {
        if (d?.taskId !== initial.id) return;
        setTask((t) => ({ ...t, status: "error", error: d.error ?? t.error, finishedAt: Date.now() }));
        finish(d.kind);
      }),
    ];

    return () => offs.forEach((off) => off());
  }, [initial.id]);

  const parsed = task.output?.parsed ?? null;
  const status = task.status;

  return createPortal(
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`task-modal-title-${task.id}`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <Tag color={status === "done" ? "green" : status === "error" ? "red" : "ink"}>
            {kindLabel(task.kind)}
          </Tag>
          <span className="modal__title" id={`task-modal-title-${task.id}`}>AI 任务</span>
          {status === "running" || status === "queued" ? (
            <StatusDot state="run" />
          ) : status === "done" ? (
            <StatusDot state="ok" />
          ) : status === "error" ? (
            <StatusDot state="err" />
          ) : null}
          <button className="btn btn--icon" onClick={onClose} title="关闭" aria-label="关闭任务窗口">
            <X size={16} />
          </button>
        </div>

        <div className="modal__body">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16, alignItems: "center" }}>
            <Tag color="gray">状态 · {statusLabel(status)}</Tag>
            <span className="topbar__hint">创建于 {timeAgo(task.createdAt)}</span>
            {status === "running" && <Spinner size={14} />}
          </div>

          {(status === "queued" || status === "running") && (
            <div style={{ marginBottom: 16 }}>
              <div className="output__label" style={{ marginBottom: 8 }}>
                {thinking ? "模型思考中…" : "生成中…"}
              </div>
              {stream ? (
                <div className="stream">{stream}</div>
              ) : (
                <div className="stream" style={{ color: "var(--faint)" }}>
                  等待模型输出…
                </div>
              )}
            </div>
          )}

          {status === "error" && (
            <div className="error-banner">
              <XCircle size={18} style={{ flex: "0 0 auto", marginTop: 1 }} />
              <div>{task.error ?? "任务失败"}</div>
            </div>
          )}

          {status === "done" && (
            <div>
              {parsed ? (
                <OutputRenderer kind={task.kind} parsed={parsed} />
              ) : (
                <div className="error-banner" style={{ background: "var(--yellow-bg)", color: "var(--yellow-ink)" }}>
                  模型未返回可解析的 JSON，下面是原始输出。
                </div>
              )}
              {stream && (
                <div style={{ marginTop: 16 }}>
                  <button className="btn btn--ghost btn--sm" onClick={() => setShowRaw((v) => !v)}>
                    {showRaw ? <CaretUp size={14} /> : <CaretDown size={14} />}
                    原始输出
                  </button>
                  {showRaw && <div className="stream" style={{ marginTop: 8 }}>{stream}</div>}
                </div>
              )}
            </div>
          )}

          {task.kind === "ideate" && status === "done" && (
            <div
              style={{
                marginTop: 16,
                padding: "12px 14px",
                borderRadius: "var(--r-md)",
                background: "var(--accent-soft)",
                color: "var(--accent-strong)",
                fontSize: 13,
                display: "flex",
                gap: 8,
                alignItems: "center",
              }}
            >
              <CheckCircle size={16} />
              选题已自动写入「选题」看板，可前往查看并管理状态。
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
