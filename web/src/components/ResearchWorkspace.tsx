import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowClockwise,
  CheckCircle,
  CircleNotch,
  MagnifyingGlass,
  PaperPlaneRight,
  FlagCheckered,
  Stop,
  X,
} from "@phosphor-icons/react";
import { api } from "../lib/api";
import { onEvent } from "../lib/sse";
import type { Item, ResearchMessage, ResearchRevision, ResearchRole, Task, TaskTrace } from "../lib/types";
import { Checkbox, ErrorBanner, Spinner, Tag } from "./ui";

const ROLES: Array<{ id: ResearchRole; name: string; description: string }> = [
  { id: "editor", name: "内容编辑", description: "重视准确、结构与可写性" },
  { id: "growth", name: "增长策划", description: "重视传播钩子与读者需求" },
  { id: "researcher", name: "深度研究员", description: "重视证据、关联与新发现" },
];

function actionInput(trace: TaskTrace): string | null {
  const query = trace.input.query;
  if (typeof query === "string" && query) return `“${query}”`;
  const ids = trace.input.item_ids;
  if (Array.isArray(ids)) return `${ids.length} 条素材`;
  return null;
}

export default function ResearchWorkspace({
  itemIds: initialItemIds,
  seedItems = [],
  initialTask,
  onClose,
  onTopicsCreated,
}: {
  itemIds?: string[];
  seedItems?: Item[];
  initialTask?: Task;
  onClose: () => void;
  onTopicsCreated?: () => void;
}) {
  const [task, setTask] = useState<Task | null>(initialTask ?? null);
  const [role, setRole] = useState<ResearchRole>(initialTask?.input?.role ?? "editor");
  const [goal, setGoal] = useState(initialTask?.input?.goal ?? "");
  const [starting, setStarting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [messages, setMessages] = useState<ResearchMessage[]>([]);
  const [revisions, setRevisions] = useState<ResearchRevision[]>([]);
  const [revisionNumber, setRevisionNumber] = useState<number | null>(initialTask?.output?.revision ?? null);
  const [messageDraft, setMessageDraft] = useState("");
  const [messageMode, setMessageMode] = useState<"steer" | "follow_up">("follow_up");
  const [sending, setSending] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const itemIds = task?.input?.itemIds ?? initialItemIds ?? [];
  const displayedOutput = useMemo(() => {
    const revision = revisions.find((item) => item.revision === revisionNumber);
    return revision?.output ?? task?.output ?? null;
  }, [revisions, revisionNumber, task?.output]);
  const candidates = useMemo(() => {
    const topics = displayedOutput?.parsed?.topics;
    return Array.isArray(topics) ? topics : [];
  }, [displayedOutput]);
  const displayedRevision = revisionNumber ?? task?.output?.revision ?? 0;
  const confirmed = new Set(task?.output?.confirmedByRevision?.[String(displayedRevision)] ?? (displayedRevision === task?.output?.revision ? task?.output?.confirmedIndexes ?? [] : []));
  const trace = task?.trace ?? [];
  const active = task?.status === "queued" || task?.status === "running";

  useEffect(() => {
    if (!task || !["done", "awaiting_feedback", "completed"].includes(task.status) || !Array.isArray(task.output?.parsed?.topics)) return;
    const currentRevision = task.output.revision ?? 0;
    const alreadyConfirmed = new Set(task.output.confirmedByRevision?.[String(currentRevision)] ?? task.output.confirmedIndexes ?? []);
    setRevisionNumber(task.output.revision ?? null);
    setSelected(new Set(
      task.output.parsed.topics
        .map((_: unknown, index: number) => index)
        .filter((index: number) => !alreadyConfirmed.has(index)),
    ));
  }, [task?.id]);

  useEffect(() => {
    if (!task) return;
    void Promise.all([api.researchMessages(task.id), api.researchRevisions(task.id)]).then(([nextMessages, nextRevisions]) => {
      setMessages(nextMessages);
      setRevisions(nextRevisions);
      if (revisionNumber === null && nextRevisions[0]) setRevisionNumber(nextRevisions[0].revision);
    }).catch(() => {});
  }, [task?.id]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.classList.add("modal-open");
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("modal-open");
      previous?.focus();
    };
  }, []);

  useEffect(() => {
    if (!task) return;
    const id = task.id;
    const offs = [
      onEvent("task_status", (data) => {
        if (data?.taskId === id) setTask((current) => current ? { ...current, status: data.status } : current);
      }),
      onEvent("task_trace", (data) => {
        if (data?.taskId === id) setTask((current) => current ? { ...current, trace: data.trace ?? [] } : current);
      }),
      onEvent("task_done", (data) => {
        if (data?.taskId !== id) return;
        setTask((current) => current ? { ...current, status: data.status ?? "done", output: data.output } : current);
        setRevisionNumber(data.output?.revision ?? null);
        const topics = data.output?.parsed?.topics;
        if (Array.isArray(topics)) setSelected(new Set(topics.map((_: unknown, index: number) => index)));
      }),
      onEvent("research_message", (data) => {
        if (data?.taskId !== id || !data.message) return;
        setMessages((current) => {
          const exists = current.some((message) => message.id === data.message.id);
          return exists ? current.map((message) => message.id === data.message.id ? data.message : message) : [...current, data.message];
        });
      }),
      onEvent("research_revision", (data) => {
        if (data?.taskId !== id || !data.revision) return;
        setRevisions((current) => [data.revision, ...current.filter((item) => item.revision !== data.revision.revision)]);
        setRevisionNumber(data.revision.revision);
      }),
      onEvent("task_error", (data) => {
        if (data?.taskId === id) {
          setTask((current) => current ? { ...current, status: "error", error: data.error } : current);
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [task?.id]);

  useEffect(() => {
    if (!task || !active) return;
    const timer = window.setInterval(() => {
      void api.getTask(task.id).then((fresh) => {
        setTask(fresh);
        if (["done", "awaiting_feedback", "completed"].includes(fresh.status) && Array.isArray(fresh.output?.parsed?.topics)) {
          setSelected((current) => current.size > 0
            ? current
            : new Set(fresh.output!.parsed.topics.map((_: unknown, index: number) => index)));
        }
      }).catch(() => {});
    }, 1500);
    return () => window.clearInterval(timer);
  }, [task?.id, active]);

  async function startResearch() {
    if (itemIds.length === 0) return;
    setStarting(true);
    setError(null);
    try {
      const created = await api.createTask("ideate", itemIds, undefined, {
        role,
        goal: goal.trim() || undefined,
      });
      setTask(created);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function stopResearch() {
    if (!task) return;
    try {
      setTask(await api.cancelTask(task.id));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function confirmTopics() {
    if (!task || selected.size === 0) return;
    setConfirming(true);
    setError(null);
    try {
      await api.confirmTopics(task.id, [...selected], displayedRevision || undefined);
      const fresh = await api.getTask(task.id);
      setTask(fresh);
      setSelected(new Set());
      onTopicsCreated?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setConfirming(false);
    }
  }

  async function sendMessage() {
    if (!task || !messageDraft.trim()) return;
    setSending(true); setError(null);
    try {
      const message = await api.sendResearchMessage(task.id, messageDraft.trim(), active ? messageMode : "follow_up");
      setMessages((current) => [...current.filter((item) => item.id !== message.id), message]);
      setMessageDraft("");
      setTask((current) => current && !active ? { ...current, status: "queued" } : current);
    } catch (err) { setError((err as Error).message); }
    finally { setSending(false); }
  }

  async function finishResearch() {
    if (!task || !window.confirm("结束后将不能继续在这个研究上下文中追问，确定结束？")) return;
    try { setTask(await api.finishResearch(task.id)); }
    catch (err) { setError((err as Error).message); }
  }

  function restart() {
    setGoal(task?.input?.goal ?? goal);
    setRole(task?.input?.role ?? role);
    setTask(null);
    setSelected(new Set());
    setError(null);
  }

  function toggleCandidate(index: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  return createPortal(
    <div className="research-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="research-workbench"
        role="dialog"
        aria-modal="true"
        aria-labelledby="research-title"
        tabIndex={-1}
      >
        <header className="research-head">
          <div>
            <div className="research-head__eyebrow"><MagnifyingGlass size={13} /> PI AGENT RESEARCH</div>
            <h2 id="research-title">选题研究工作台</h2>
          </div>
          <div className="research-head__state">
            {active && <><Spinner size={14} /> Agent 正在自主研究</>}
            {task?.status === "awaiting_feedback" && <><CheckCircle size={15} weight="fill" /> 本轮完成，可继续追问</>}
            {task?.status === "completed" && <><FlagCheckered size={15} weight="fill" /> 研究已结束</>}
            {task?.status === "cancelled" && <>研究已停止</>}
          </div>
          <button className="btn btn--icon" onClick={onClose} aria-label="关闭研究工作台"><X size={17} /></button>
        </header>

        <div className="research-grid">
          <aside className="research-pane research-brief">
            <div className="research-pane__head"><span>01</span>研究任务</div>
            <label className="field">
              <span className="field__label">研究目标</span>
              <textarea
                className="input research-goal"
                placeholder="例如：寻找适合中文技术创作者、能引发讨论的 AI Agent 选题"
                value={goal}
                disabled={!!task}
                onChange={(event) => setGoal(event.target.value)}
              />
            </label>
            <div className="field">
              <span className="field__label">Agent 角色</span>
              <div className="research-roles">
                {ROLES.map((option) => (
                  <button
                    type="button"
                    key={option.id}
                    className={`research-role${role === option.id ? " research-role--active" : ""}`}
                    disabled={!!task}
                    onClick={() => setRole(option.id)}
                  >
                    <strong>{option.name}</strong>
                    <span>{option.description}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="research-seeds">
              <div className="field__label">种子素材 · {itemIds.length} 条</div>
              {seedItems.length > 0 ? seedItems.slice(0, 5).map((item) => (
                <div className="research-seed" key={item.id}>{item.title}</div>
              )) : <div className="research-seed">任务中保存的素材集合</div>}
              {seedItems.length > 5 && <span>另有 {seedItems.length - 5} 条</span>}
            </div>
          </aside>

          <main className="research-pane research-trace">
            <div className="research-pane__head"><span>02</span>Agent 行动轨迹</div>
            {!task && <div className="research-placeholder">设置目标并开始后，这里会实时展示 Agent 使用工具检索、精读和去重的过程。</div>}
            {task && trace.length === 0 && active && <div className="research-placeholder"><Spinner size={16} /> Agent 正在理解目标并规划研究步骤…</div>}
            <div className="research-timeline">
              {trace.map((action, index) => (
                <div className="research-action" key={action.id}>
                  <div className={`research-action__dot research-action__dot--${action.status}`}>
                    {action.status === "running" ? <CircleNotch size={13} className="spinner" /> : index + 1}
                  </div>
                  <div>
                    <div className="research-action__title">
                      {action.label}
                      {actionInput(action) && <Tag color="gray">{actionInput(action)}</Tag>}
                    </div>
                    <p>{action.summary ?? "执行中…"}</p>
                  </div>
                </div>
              ))}
            </div>
            {messages.length > 0 && <div className="research-conversation">
              <div className="field__label">对话记录</div>
              {messages.map((message) => <div className={`research-message research-message--${message.role}`} key={message.id}>
                <div>{message.content}</div>
                <small>{message.role === "user" ? (message.mode === "steer" ? "立即纠偏" : "继续研究") : "Agent"} · {message.status === "queued" ? "排队中" : message.status === "failed" ? "发送失败" : "已送达"}</small>
              </div>)}
            </div>}
            {task?.status === "error" && <ErrorBanner message={task.error || "研究任务失败"} />}
          </main>

          <aside className="research-pane research-results">
            <div className="research-pane__head research-results__head"><span>03</span>候选选题
              {revisions.length > 0 && <select className="select" value={displayedRevision} onChange={(e) => { setRevisionNumber(Number(e.target.value)); setSelected(new Set()); }} aria-label="候选版本">
                {revisions.map((revision) => <option value={revision.revision} key={revision.id}>第 {revision.revision} 版</option>)}
              </select>}
            </div>
            {candidates.length === 0 && (
              <div className="research-placeholder">Agent 完成检索、比较和历史去重后，候选选题会出现在这里。</div>
            )}
            <div className="research-candidates">
              {candidates.map((candidate: any, index: number) => {
                const isConfirmed = confirmed.has(index);
                return (
                  <article className={`research-candidate${selected.has(index) ? " research-candidate--selected" : ""}`} key={index}>
                    <div className="research-candidate__head">
                      <Checkbox
                        checked={selected.has(index) || isConfirmed}
                        disabled={isConfirmed}
                        onChange={() => toggleCandidate(index)}
                        label={`选择候选选题：${candidate.title}`}
                      />
                      <h3>{candidate.title}</h3>
                    </div>
                    <div className="research-candidate__tags">
                      <Tag color="ink">{candidate.type === "article" ? "长文" : "推文"}</Tag>
                      {isConfirmed && <Tag color="green">已写入</Tag>}
                    </div>
                    <p>{candidate.angle}</p>
                    {candidate.differentiation && <small>差异化：{candidate.differentiation}</small>}
                  </article>
                );
              })}
            </div>
          </aside>
        </div>

        {error && <div className="research-error"><ErrorBanner message={error} /></div>}
        {task && !["completed", "cancelled", "error"].includes(task.status) && <div className="research-compose">
          <textarea className="input" value={messageDraft} onChange={(e) => setMessageDraft(e.target.value)} placeholder={active ? "告诉 Agent 需要立刻调整什么，或补充下一步要求…" : "继续追问、深化某个角度，或要求 Agent 改写候选…"} />
          {active && <select className="select" value={messageMode} onChange={(e) => setMessageMode(e.target.value as "steer" | "follow_up")} aria-label="消息发送方式"><option value="steer">立即纠偏</option><option value="follow_up">本轮后继续</option></select>}
          <button className="btn btn--primary" onClick={sendMessage} disabled={sending || !messageDraft.trim()}>{sending ? <Spinner size={14} /> : <PaperPlaneRight size={15} />}发送</button>
        </div>}
        <footer className="research-foot">
          <span>{task ? `任务 ${task.id.slice(0, 8)} · 本地 RSS 研究` : "Agent 只会读取本地素材，不会自动写入选题库"}</span>
          <div>
            {!task && <button className="btn btn--primary" disabled={starting || itemIds.length === 0} onClick={startResearch}>{starting && <Spinner size={14} />}开始研究</button>}
            {active && <button className="btn btn--danger" onClick={stopResearch}><Stop size={14} weight="fill" />停止</button>}
            {task && ["cancelled", "error", "completed"].includes(task.status) && <button className="btn" onClick={restart}><ArrowClockwise size={14} />新建研究</button>}
            {task?.status === "awaiting_feedback" && <button className="btn" onClick={finishResearch}><FlagCheckered size={14} />结束研究</button>}
            {task && ["done", "awaiting_feedback", "completed"].includes(task.status) && candidates.some((_: unknown, index: number) => !confirmed.has(index)) && (
              <button className="btn btn--primary" disabled={confirming || selected.size === 0} onClick={confirmTopics}>
                {confirming && <Spinner size={14} />}确认写入 {selected.size > 0 ? `${selected.size} 个` : ""}选题
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
