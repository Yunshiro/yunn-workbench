import { useEffect, useRef, useState } from "react";
import { CaretRight, PaperPlaneRight, Plus } from "@phosphor-icons/react";
import { api } from "../lib/api";
import { useEvent } from "../lib/sse";
import type { BoardCard, BoardMessage, BoardSession } from "../lib/types";
import { ErrorBanner, Spinner } from "./ui";

function upsertMessage(messages: BoardMessage[], message: BoardMessage): BoardMessage[] {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index < 0) return [...messages, message];
  const next = messages.slice();
  next[index] = message;
  return next;
}

interface BoardChatPanelProps {
  boardId: string;
  cards: BoardCard[];
  selectedIds: string[];
  collapsed: boolean;
  onToggle: () => void;
  onFocusCard: (cardId: string) => void;
}

export default function BoardChatPanel({ boardId, cards, selectedIds, collapsed, onToggle, onFocusCard }: BoardChatPanelProps) {
  const [sessions, setSessions] = useState<BoardSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<BoardMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;

  const usable = cards.filter((card) => card.status !== "loading" && `${card.body}${card.summary}${card.title}`.trim()).length;

  useEffect(() => {
    let cancelled = false;
    void api.agentStatus().then((status) => {
      if (!cancelled) setConfigured(status.configured);
    }).catch(() => { if (!cancelled) setConfigured(null); });
    return () => { cancelled = true; };
  }, [boardId]);

  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setSessionId(null);
    void api.listBoardSessions(boardId).then((next) => {
      if (cancelled) return;
      setSessions(next);
      setSessionId(next[0]?.id ?? null);
    }).catch((err) => setError((err as Error).message));
    return () => { cancelled = true; };
  }, [boardId]);

  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    void api.listBoardMessages(boardId, sessionId).then((next) => {
      if (!cancelled) setMessages(next);
    }).catch((err) => setError((err as Error).message));
    return () => { cancelled = true; };
  }, [boardId, sessionId]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [messages]);

  useEvent("board_message", (data) => {
    const message = data?.message as BoardMessage | undefined;
    if (!message || message.sessionId !== sessionIdRef.current) return;
    setMessages((items) => upsertMessage(items, message));
    if (message.role === "assistant" && message.status !== "running") setSending(false);
  });
  useEvent("board_message_delta", (data) => {
    const delta = data?.delta as string | undefined;
    const messageId = data?.messageId as string | undefined;
    if (!delta || !messageId || data?.sessionId !== sessionIdRef.current) return;
    setMessages((items) => items.map((item) => item.id === messageId ? { ...item, content: item.content + delta } : item));
  });

  async function handleNewSession() {
    setError(null);
    try {
      const session = await api.createBoardSession(boardId);
      setSessions((current) => [session, ...current]);
      setSessionId(session.id);
      setMessages([]);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleSend() {
    if (!draft.trim() || sending || configured === false) return;
    setError(null);
    setSending(true);
    const content = draft.trim();
    setDraft("");
    try {
      let active = sessionId;
      if (!active) {
        const session = await api.createBoardSession(boardId);
        setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
        sessionIdRef.current = session.id;
        setSessionId(session.id);
        active = session.id;
      }
      const cardIds = selectedIds.length > 0 ? selectedIds : undefined;
      const result = await api.sendBoardMessage(boardId, active, content, cardIds);
      setSessions((current) => current.map((item) => item.id === active && item.title === "新的对话" ? { ...item, title: content.slice(0, 40) } : item));
      setMessages((current) => upsertMessage(upsertMessage(current, result.user), result.assistant));
    } catch (err) {
      setSending(false);
      setDraft(content);
      setError((err as Error).message);
    }
  }

  if (collapsed) {
    return (
      <aside className="board__chat board__chat--collapsed">
        <button className="btn btn--ghost board__chat-toggle" type="button" onClick={onToggle} aria-label="展开对话">
          <CaretRight size={16} />
          对话
        </button>
      </aside>
    );
  }

  const scope = selectedIds.length > 0
    ? `当前只把选中的 ${selectedIds.length} 张卡片交给 AI`
    : usable > 0
      ? `当前把画板上 ${usable} 张有内容的卡片交给 AI`
      : "先添加卡片或便签，再来提问";
  const canAsk = configured !== false && !sending && (selectedIds.length > 0 || usable > 0);

  return (
    <aside className="board__chat">
      <div className="board__chat-head">
        <strong>对话</strong>
        <select className="select" value={sessionId || ""} onChange={(event) => setSessionId(event.target.value || null)} aria-label="对话">
          <option value="">新的对话</option>
          {sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}
        </select>
        <button className="btn btn--ghost btn--sm" type="button" onClick={() => void handleNewSession()} aria-label="新对话">
          <Plus size={14} />
        </button>
        <button className="btn btn--ghost btn--sm" type="button" onClick={onToggle}>收起</button>
      </div>
      {error && <ErrorBanner message={error} />}
      <div className="board__chat-scope">
        {configured === false && <span className="board__chat-scope-line">请先在 Agent 设置中启用一个可用的模型</span>}
        <span className="board__chat-scope-line">{scope}</span>
      </div>
      <div className="kb__messages board__messages" ref={threadRef}>
        {messages.length === 0 && (
          <p className="board__chat-empty">对着这面墙上的卡片提问。回答会标出用到的卡片，点击即可定位。</p>
        )}
        {messages.map((message) => (
          <article key={message.id} className={`kb-msg kb-msg--${message.role}`}>
            <div className="kb-msg__role">{message.role === "user" ? "你" : "画板"}</div>
            {message.status === "running" && !message.content ? (
              <div className="kb-msg__pending"><Spinner /> 正在根据卡片回答…</div>
            ) : (
              <div className="kb-msg__content">{message.content}</div>
            )}
            {message.error && <div className="kb-msg__error">{message.error}</div>}
            {message.role === "assistant" && message.citations.length > 0 && (
              <div className="kb-sources">
                <div className="kb-sources__label">引用的卡片</div>
                {message.citations.map((citation) => (
                  <button key={`${citation.index}-${citation.cardId}`} type="button" className="kb-source" onClick={() => onFocusCard(citation.cardId)}>
                    <span>
                      <span className="kb-source__title">[{citation.index}] {citation.title}</span>
                      {citation.excerpt && <span className="kb-source__path">{citation.excerpt}</span>}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
      <form className="kb__composer board__composer" onSubmit={(event) => { event.preventDefault(); void handleSend(); }}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={configured === false ? "请先在 Agent 设置中启用一个可用的模型" : "基于画板上的卡片提问，Enter 发送"}
          disabled={configured === false}
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
    </aside>
  );
}
