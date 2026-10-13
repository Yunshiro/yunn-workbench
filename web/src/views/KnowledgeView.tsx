import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowClockwise,
  Books,
  FileText,
  PaperPlaneRight,
  Plus,
  Trash,
  X,
} from "@phosphor-icons/react";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";
import { MarkdownView } from "../lib/markdown";
import { useEvent } from "../lib/sse";
import type { KbAuthType, KbDocument, KbMessage, KbSession, KnowledgeBase } from "../lib/types";
import { EmptyState, ErrorBanner, Spinner, Tag } from "../components/ui";

const STATUS: Record<KnowledgeBase["status"], { label: string; color: string }> = {
  pending: { label: "等待同步", color: "gray" },
  syncing: { label: "同步中", color: "blue" },
  ready: { label: "已索引", color: "green" },
  error: { label: "同步失败", color: "red" },
};

function authLabel(kb: KnowledgeBase): string {
  if (kb.authType === "github_token") return kb.credentialConfigured ? "Token 已保存" : "缺少 Token";
  if (kb.authType === "ssh_key") return kb.credentialConfigured ? "私钥已保存" : "缺少私钥";
  return "公开仓库";
}

function upsertMessage(messages: KbMessage[], message: KbMessage): KbMessage[] {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index < 0) return [...messages, message];
  const next = messages.slice();
  next[index] = message;
  return next;
}

export default function KnowledgeView() {
  const [bases, setBases] = useState<KnowledgeBase[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<KbSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<KbMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [sending, setSending] = useState(false);
  const [document, setDocument] = useState<KbDocument | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;

  const selected = bases?.find((item) => item.id === selectedId) ?? null;

  const loadBases = useCallback(async () => {
    const next = await api.listKnowledgeBases();
    setBases(next);
    setSelectedId((current) => current && next.some((item) => item.id === current) ? current : next[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void loadBases().catch((err) => setError((err as Error).message));
  }, [loadBases]);

  useEffect(() => {
    if (!selectedId) {
      setSessions([]);
      setSessionId(null);
      setMessages([]);
      return;
    }
    let cancelled = false;
    void api.listKnowledgeSessions(selectedId).then((next) => {
      if (cancelled) return;
      setSessions(next);
      setSessionId((current) => current && next.some((item) => item.id === current) ? current : next[0]?.id ?? null);
    }).catch((err) => setError((err as Error).message));
    return () => { cancelled = true; };
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId || !sessionId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    void api.listKnowledgeMessages(selectedId, sessionId).then((next) => {
      if (!cancelled) setMessages(next);
    }).catch((err) => setError((err as Error).message));
    return () => { cancelled = true; };
  }, [selectedId, sessionId]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [messages]);

  useEvent("kb_status", (data) => {
    const knowledgeBase = data?.knowledgeBase as KnowledgeBase | undefined;
    if (!knowledgeBase) return;
    setBases((current) => current?.map((item) => item.id === knowledgeBase.id ? knowledgeBase : item) ?? [knowledgeBase]);
  });
  useEvent("kb_deleted", (data) => {
    const kbId = data?.kbId as string | undefined;
    if (!kbId) return;
    setBases((current) => current?.filter((item) => item.id !== kbId) ?? null);
    setSelectedId((current) => current === kbId ? null : current);
  });
  useEvent("kb_message", (data) => {
    const message = data?.message as KbMessage | undefined;
    if (!message || message.sessionId !== sessionIdRef.current) return;
    setMessages((items) => upsertMessage(items, message));
    if (message.role === "assistant" && message.status !== "running") setSending(false);
  });
  useEvent("kb_message_delta", (data) => {
    const delta = data?.delta as string | undefined;
    const messageId = data?.messageId as string | undefined;
    if (!delta || !messageId || data?.sessionId !== sessionIdRef.current) return;
    setMessages((items) => items.map((item) => item.id === messageId ? { ...item, content: item.content + delta } : item));
  });

  async function handleCreated(kb: KnowledgeBase) {
    setBases((current) => [kb, ...(current || []).filter((item) => item.id !== kb.id)]);
    setSelectedId(kb.id);
    setAdding(false);
    setDocument(null);
  }

  async function handleSync(kb: KnowledgeBase) {
    setError(null);
    try {
      const next = await api.syncKnowledgeBase(kb.id);
      setBases((current) => current?.map((item) => item.id === next.id ? next : item) ?? [next]);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDelete(kb: KnowledgeBase) {
    if (!window.confirm(`删除知识库「${kb.name}」？本地克隆和索引会被移除，远程仓库不会被修改。`)) return;
    setError(null);
    try {
      await api.deleteKnowledgeBase(kb.id);
      setDocument(null);
      await loadBases();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleNewSession() {
    if (!selected) return;
    setError(null);
    try {
      const session = await api.createKnowledgeSession(selected.id);
      setSessions((current) => [session, ...current]);
      setSessionId(session.id);
      setMessages([]);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleSend() {
    if (!selected || !draft.trim() || sending) return;
    setError(null);
    setSending(true);
    const content = draft.trim();
    setDraft("");
    try {
      let active = sessionId;
      if (!active) {
        const session = await api.createKnowledgeSession(selected.id);
        setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
        sessionIdRef.current = session.id;
        setSessionId(session.id);
        active = session.id;
      }
      const result = await api.sendKnowledgeMessage(selected.id, active, content);
      setSessions((current) => current.map((item) => item.id === active && item.title === "新的对话" ? { ...item, title: content.slice(0, 40) } : item));
      setMessages((current) => upsertMessage(upsertMessage(current, result.user), result.assistant));
    } catch (err) {
      setSending(false);
      setDraft(content);
      setError((err as Error).message);
    }
  }

  async function openDocument(path: string) {
    if (!selected) return;
    setError(null);
    try {
      setDocument(await api.getKnowledgeDocument(selected.id, path));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const busy = selected?.status === "syncing" || selected?.status === "pending";
  const canAsk = !!selected && selected.chunkCount > 0 && !sending;

  return (
    <div className={`kb${document ? " kb--with-doc" : ""}`}>
      <aside className="kb__side">
        <div className="kb__side-head">
          <span>知识库</span>
          <button className="btn btn--primary" type="button" onClick={() => setAdding(true)}>
            <Plus size={14} weight="bold" />
            添加
          </button>
        </div>
        {error && <ErrorBanner message={error} />}
        {bases === null ? <Spinner /> : bases.length === 0 ? (
          <EmptyState icon={Books} title="还没有知识库" desc="添加一个 Git 仓库，索引其中的 Markdown，再直接提问。" />
        ) : (
          <div className="kb__list">
            {bases.map((kb) => (
              <button
                key={kb.id}
                type="button"
                className={`kb-card${kb.id === selectedId ? " kb-card--active" : ""}`}
                onClick={() => { setSelectedId(kb.id); setDocument(null); }}
              >
                <span className="kb-card__name">{kb.name}</span>
                <span className="kb-card__url">{kb.repoUrl}</span>
                <span className="kb-card__meta">
                  <Tag color={STATUS[kb.status].color}>{STATUS[kb.status].label}</Tag>
                  <span>{kb.fileCount} 篇</span>
                  <span>{authLabel(kb)}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </aside>

      <section className="kb__main">
        {!selected ? (
          <EmptyState icon={Books} title="选择或添加知识库" desc="仓库只会克隆到本机数据目录，同步不会提交或推送。" />
        ) : (
          <>
            <div className="kb__toolbar">
              <div className="kb__title">
                <strong>{selected.name}</strong>
                <span>{selected.branch ? `${selected.branch} · ` : ""}{selected.commitSha ? selected.commitSha.slice(0, 7) : "尚未同步"} · {timeAgo(selected.lastSyncedAt)}</span>
              </div>
              <select
                className="select"
                value={sessionId || ""}
                onChange={(event) => setSessionId(event.target.value || null)}
                aria-label="对话"
              >
                <option value="">新的对话</option>
                {sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}
              </select>
              <button className="btn btn--ghost" type="button" onClick={() => void handleNewSession()}>新对话</button>
              <button className="btn btn--ghost" type="button" onClick={() => void handleSync(selected)} disabled={busy}>
                {busy ? <Spinner /> : <ArrowClockwise size={16} />}
                同步
              </button>
              <button className="btn btn--danger" type="button" onClick={() => void handleDelete(selected)} aria-label="删除知识库">
                <Trash size={16} />
              </button>
            </div>
            {selected.lastError && <ErrorBanner message={selected.lastError} />}
            <div className="kb__messages" ref={threadRef}>
              {messages.length === 0 && (
                <EmptyState
                  icon={Books}
                  title="向知识库提问"
                  desc="会先在本地检索相关 Markdown，再用当前模型回答，并列出引用的原文。"
                />
              )}
              {messages.map((message) => (
                <article key={message.id} className={`kb-msg kb-msg--${message.role}`}>
                  <div className="kb-msg__role">{message.role === "user" ? "你" : "知识库"}</div>
                  {message.status === "running" && !message.content ? (
                    <div className="kb-msg__pending"><Spinner /> 正在检索并回答…</div>
                  ) : (
                    <div className="kb-msg__content">{message.content}</div>
                  )}
                  {message.error && <div className="kb-msg__error">{message.error}</div>}
                  {message.role === "assistant" && message.citations.length > 0 && (
                    <div className="kb-sources">
                      <div className="kb-sources__label">引用来源</div>
                      {message.citations.map((citation) => (
                        <button key={`${citation.index}-${citation.path}`} type="button" className="kb-source" onClick={() => void openDocument(citation.path)}>
                          <FileText size={16} />
                          <span>
                            <span className="kb-source__title">[{citation.index}] {citation.title}</span>
                            <span className="kb-source__path">{citation.path}{citation.heading ? ` · ${citation.heading}` : ""}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
            <form className="kb__composer" onSubmit={(event) => { event.preventDefault(); void handleSend(); }}>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={canAsk ? "基于这个知识库提问，Enter 发送" : busy ? "正在同步并建立索引…" : "同步完成、索引到 Markdown 后即可提问"}
                disabled={!canAsk}
                rows={3}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void handleSend();
                  }
                }}
              />
              <button className="btn btn--primary" type="submit" disabled={!canAsk || !draft.trim()}>
                {sending ? <Spinner /> : <PaperPlaneRight size={16} weight="fill" />}
                发送
              </button>
            </form>
          </>
        )}
      </section>

      {document && (
        <aside className="kb__doc">
          <div className="kb__doc-head">
            <div>
              <div className="kb__doc-title">{document.title}</div>
              <div className="kb__doc-path">{document.path}</div>
            </div>
            <button className="btn btn--ghost" type="button" onClick={() => setDocument(null)} aria-label="关闭原文">
              <X size={16} />
            </button>
          </div>
          <div className="kb__doc-body">
            <MarkdownView source={document.content} />
          </div>
        </aside>
      )}
      {adding && (
        <AddKnowledgeDialog
          onClose={() => setAdding(false)}
          onCreated={(kb) => void handleCreated(kb)}
        />
      )}
    </div>
  );
}

function AddKnowledgeDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (kb: KnowledgeBase) => void }) {
  const [repoUrl, setRepoUrl] = useState("");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [authType, setAuthType] = useState<KbAuthType>("none");
  const [token, setToken] = useState("");
  const [sshKey, setSshKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const kb = await api.addKnowledgeBase({
        repoUrl: repoUrl.trim(),
        name: name.trim() || undefined,
        branch: branch.trim() || undefined,
        authType,
        token: authType === "github_token" ? token : undefined,
        sshKey: authType === "ssh_key" ? sshKey : undefined,
      });
      setToken("");
      setSshKey("");
      onCreated(kb);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal kb-dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={handleSubmit}>
        <div className="modal__head">
          <div className="modal__title">添加知识库</div>
          <button className="btn btn--ghost" type="button" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="modal__body kb-dialog__body">
          {error && <ErrorBanner message={error} />}
          <label>
            仓库地址
            <input className="input" value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} placeholder="https://github.com/owner/repo.git" required />
          </label>
          <div className="kb-dialog__row">
            <label>
              名称（可选）
              <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="默认使用仓库名" />
            </label>
            <label>
              分支（可选）
              <input className="input" value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="默认分支" />
            </label>
          </div>
          <label>
            访问方式
            <select className="select" value={authType} onChange={(event) => setAuthType(event.target.value as KbAuthType)}>
              <option value="none">公开仓库</option>
              <option value="github_token">GitHub Token（HTTPS）</option>
              <option value="ssh_key">SSH 私钥</option>
            </select>
          </label>
          {authType === "github_token" && (
            <label>
              GitHub Token
              <input className="input" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="只保存在本机数据目录" required />
            </label>
          )}
          {authType === "ssh_key" && (
            <label>
              SSH 私钥
              <textarea className="kb-key" value={sshKey} onChange={(event) => setSshKey(event.target.value)} placeholder="粘贴未加密的私钥。不要把私钥写进仓库地址。" required />
            </label>
          )}
          <p className="kb-dialog__note">凭证只写入本机数据目录，不会返回到页面，也不会写进日志。同步只会拉取和重建索引，不会提交或推送。</p>
          <div className="kb-dialog__actions">
            <button className="btn btn--ghost" type="button" onClick={onClose}>取消</button>
            <button className="btn btn--primary" type="submit" disabled={saving}>
              {saving ? <Spinner /> : <Plus size={16} weight="bold" />}
              添加并同步
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
