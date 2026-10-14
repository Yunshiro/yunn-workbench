import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, NotePencil, Plus, SquaresFour, Trash, X } from "@phosphor-icons/react";
import { api } from "../lib/api";
import { useEvent } from "../lib/sse";
import type { Board, BoardCard } from "../lib/types";
import BoardCanvas from "../components/BoardCanvas";
import BoardChatPanel from "../components/BoardChatPanel";
import { EmptyState, ErrorBanner, Spinner } from "../components/ui";

function upsertCard(cards: BoardCard[], card: BoardCard): BoardCard[] {
  const index = cards.findIndex((item) => item.id === card.id);
  if (index < 0) return [...cards, card];
  // 抓取很快时，SSE 里更新的卡片可能比这次 POST 响应更晚。不要用旧的「加载中」盖掉它。
  if (cards[index].updatedAt > card.updatedAt) return cards;
  const next = cards.slice();
  next[index] = card;
  return next;
}

export default function BoardsView() {
  const [boards, setBoards] = useState<Board[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cards, setCards] = useState<BoardCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; nonce: number } | null>(null);
  const [highlight, setHighlight] = useState<{ id: string; nonce: number } | null>(null);
  const [selectedCardIds, setSelectedCardIds] = useState<string[]>([]);
  const [chatOpen, setChatOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const [detail, setDetail] = useState<BoardCard | null>(null);
  const [noteRequest, setNoteRequest] = useState(0);
  const [nameDraft, setNameDraft] = useState("");
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const selected = boards?.find((item) => item.id === selectedId) ?? null;

  const loadBoards = useCallback(async () => {
    const next = await api.listBoards();
    setBoards(next);
    setSelectedId((current) => current && next.some((item) => item.id === current) ? current : next[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void loadBoards().catch((err) => setError((err as Error).message));
  }, [loadBoards]);

  useEffect(() => {
    if (!selectedId) {
      setCards([]);
      setDetail(null);
      setSelectedCardIds([]);
      return;
    }
    let cancelled = false;
    void api.listBoardCards(selectedId).then((next) => {
      if (!cancelled) setCards(next);
    }).catch((err) => setError((err as Error).message));
    return () => { cancelled = true; };
  }, [selectedId]);

  useEffect(() => {
    setNameDraft(selected?.name || "");
  }, [selected?.id, selected?.name]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!highlight) return;
    const timer = window.setTimeout(() => setHighlight(null), 1800);
    return () => window.clearTimeout(timer);
  }, [highlight]);

  useEvent("board_card", (data) => {
    const card = data?.card as BoardCard | undefined;
    if (!card || card.boardId !== selectedRef.current) return;
    setCards((current) => upsertCard(current, card));
    setDetail((current) => current?.id === card.id ? card : current);
  });
  useEvent("board_card_deleted", (data) => {
    const cardId = data?.cardId as string | undefined;
    if (!cardId || data?.boardId !== selectedRef.current) return;
    setCards((current) => current.filter((item) => item.id !== cardId));
    setDetail((current) => current?.id === cardId ? null : current);
  });
  useEvent("board_deleted", (data) => {
    const boardId = data?.boardId as string | undefined;
    if (!boardId) return;
    setBoards((current) => current?.filter((item) => item.id !== boardId) ?? null);
    setSelectedId((current) => current === boardId ? null : current);
  });

  function focusCard(id: string) {
    setHighlight({ id, nonce: Date.now() });
  }

  async function handleCreateBoard() {
    setError(null);
    try {
      const board = await api.createBoard();
      setBoards((current) => [board, ...(current || []).filter((item) => item.id !== board.id)]);
      setSelectedId(board.id);
      setCards([]);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleRename() {
    if (!selected) return;
    const name = nameDraft.trim();
    if (!name || name === selected.name) {
      setNameDraft(selected.name);
      return;
    }
    setError(null);
    try {
      const next = await api.renameBoard(selected.id, name);
      setBoards((current) => current?.map((item) => item.id === next.id ? next : item) ?? [next]);
    } catch (err) {
      setNameDraft(selected.name);
      setError((err as Error).message);
    }
  }

  async function handleDeleteBoard() {
    if (!selected) return;
    if (!window.confirm(`删除画板「${selected.name}」？画板上的卡片和对话也会一起删除，此操作不能撤销。`)) return;
    setError(null);
    try {
      await api.deleteBoard(selected.id);
      setDetail(null);
      await loadBoards();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleCreateLink(url: string, position?: { x: number; y: number }) {
    if (!selected) return;
    setError(null);
    const result = await api.addBoardLink(selected.id, { url, x: position?.x, y: position?.y });
    setCards((current) => upsertCard(current, result.card));
    if (result.duplicate) {
      setNotice({ text: "已存在", nonce: Date.now() });
      focusCard(result.card.id);
    }
    void loadBoards();
  }

  async function handleCreateNote(position?: { x: number; y: number }) {
    if (!selected) return;
    setError(null);
    try {
      const card = await api.addBoardNote(selected.id, position ?? {});
      setCards((current) => upsertCard(current, card));
      void loadBoards();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleMove(id: string, x: number, y: number) {
    if (!selected) return;
    setCards((current) => current.map((card) => card.id === id ? { ...card, x, y } : card));
    try {
      const card = await api.updateBoardCard(selected.id, id, { x, y });
      setCards((current) => upsertCard(current, card));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDeleteCard(id: string) {
    if (!selected) return;
    setCards((current) => current.filter((card) => card.id !== id));
    setDetail((current) => current?.id === id ? null : current);
    try {
      await api.deleteBoardCard(selected.id, id);
      void loadBoards();
    } catch (err) {
      setError((err as Error).message);
      const next = await api.listBoardCards(selected.id);
      setCards(next);
    }
  }

  async function handleRetry(id: string) {
    if (!selected) return;
    setError(null);
    try {
      const card = await api.retryBoardCard(selected.id, id);
      setCards((current) => upsertCard(current, card));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const saveBody = useCallback(async (id: string, body: string) => {
    if (!selectedRef.current) return;
    try {
      const card = await api.updateBoardCard(selectedRef.current, id, { body });
      setCards((current) => upsertCard(current, card));
      setDetail((current) => current?.id === card.id ? card : current);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  return (
    <div className={`board${chatOpen ? "" : " board--chat-closed"}`}>
      <aside className="board__list">
        <div className="board__list-head">
          <span>画板</span>
          <button className="btn btn--primary btn--sm" type="button" onClick={() => void handleCreateBoard()}>
            <Plus size={14} weight="bold" />
            新建
          </button>
        </div>
        {boards === null ? <Spinner /> : boards.length === 0 ? (
          <EmptyState icon={SquaresFour} title="还没有画板" desc="新建一面墙，把链接和便签放在一起。" />
        ) : (
          <div className="board__list-items">
            {boards.map((board) => (
              <button
                key={board.id}
                type="button"
                className={`board-list__item${board.id === selectedId ? " board-list__item--active" : ""}`}
                onClick={() => { setSelectedId(board.id); setDetail(null); setSelectedCardIds([]); }}
              >
                <span className="board-list__name">{board.name}</span>
                <span className="board-list__count">{board.cardCount} 张</span>
              </button>
            ))}
          </div>
        )}
      </aside>

      <section className="board__stage">
        {!selected ? (
          <EmptyState icon={SquaresFour} title="选择或新建画板" desc="粘贴 X、网页或 YouTube 链接，内容会变成卡片。" />
        ) : (
          <>
            <div className="board__toolbar">
              <input
                className="input board__name"
                value={nameDraft}
                aria-label="画板名称"
                onChange={(event) => setNameDraft(event.target.value)}
                onBlur={() => void handleRename()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                }}
              />
              <button className="btn btn--ghost btn--sm" type="button" onClick={() => setAdding(true)}>
                <Link size={14} />
                添加链接
              </button>
              <button className="btn btn--ghost btn--sm" type="button" onClick={() => setNoteRequest((current) => current + 1)}>
                <NotePencil size={14} />
                新建便签
              </button>
              <button className="btn btn--danger btn--sm" type="button" onClick={() => void handleDeleteBoard()}>
                <Trash size={14} />
                删除
              </button>
              <span className="board__hint">粘贴链接生成卡片。双击空白处写便签。滚轮缩放，拖动画布平移。按住 Shift 点选卡片，可让 AI 只看选中的几张。</span>
            </div>
            {error && <ErrorBanner message={error} />}
            {notice && <div className="board-toast" role="status">{notice.text}</div>}
            <BoardCanvas
              key={selected.id}
              cards={cards}
              highlightId={highlight?.id ?? null}
              focusNonce={highlight?.nonce ?? 0}
              focusCardId={highlight?.id ?? null}
              onCreateLink={(url, position) => {
                void handleCreateLink(url, position).catch((err) => {
                  if ((err as Error).message !== "请输入链接") setError((err as Error).message);
                });
              }}
              onCreateNote={(position) => void handleCreateNote(position)}
              onMove={(id, x, y) => void handleMove(id, x, y)}
              onDelete={(id) => void handleDeleteCard(id)}
              onRetry={(id) => void handleRetry(id)}
              onSaveBody={(id, body) => void saveBody(id, body)}
              onOpen={setDetail}
              noteRequest={noteRequest}
              onSelectionChange={(ids) => {
                setSelectedCardIds((current) => current.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids);
              }}
            />
          </>
        )}
      </section>

      {selected && (
        <BoardChatPanel
          boardId={selected.id}
          cards={cards}
          selectedIds={selectedCardIds}
          collapsed={!chatOpen}
          onToggle={() => setChatOpen((open) => !open)}
          onFocusCard={focusCard}
        />
      )}

      {adding && selected && (
        <AddLinkDialog
          onClose={() => setAdding(false)}
          onSubmit={async (url) => {
            await handleCreateLink(url);
            setAdding(false);
          }}
        />
      )}
      {detail && <CardDetail card={detail} onClose={() => setDetail(null)} onSave={(body) => void saveBody(detail.id, body)} />}
    </div>
  );
}

function AddLinkDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (url: string) => Promise<void> }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSubmit(url.trim());
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal board-dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void handleSubmit(event)}>
        <div className="modal__head">
          <div className="modal__title">添加链接</div>
          <button className="btn btn--ghost" type="button" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="modal__body board-dialog__body">
          {error && <ErrorBanner message={error} />}
          <label>
            链接
            <input className="input" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://x.com/… 或文章、YouTube 链接" required />
          </label>
          <p className="board-dialog__note">支持 X（x.com / twitter.com）、普通网页和 YouTube。抓取由本机服务完成。</p>
          <div className="board-dialog__actions">
            <button className="btn btn--ghost" type="button" onClick={onClose}>取消</button>
            <button className="btn btn--primary" type="submit" disabled={saving || !url.trim()}>
              {saving ? <Spinner /> : <Plus size={16} weight="bold" />}
              添加
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function CardDetail({ card, onClose, onSave }: { card: BoardCard; onClose: () => void; onSave: (body: string) => void }) {
  const [body, setBody] = useState(card.body);
  useEffect(() => setBody(card.body), [card.id, card.body]);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal board-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal__head">
          <div className="modal__title">{card.kind === "note" ? "便签" : card.title || "卡片"}</div>
          <button className="btn btn--ghost" type="button" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="modal__body board-dialog__body">
          {card.authorName && <p className="board-detail__meta">{card.authorName}{card.authorHandle ? ` @${card.authorHandle}` : ""}</p>}
          {card.source === "x" && <p className="board-detail__meta">点赞 {card.metrics?.likes ?? 0}</p>}
          <div className="board-detail__body">{card.body || card.summary || "还没有正文"}</div>
          {card.url && (
            <a className="btn btn--ghost" href={card.url} target="_blank" rel="noopener noreferrer">在新标签页打开原文</a>
          )}
          <label>
            编辑正文
            <textarea className="board-dialog__text" value={body} onChange={(event) => setBody(event.target.value)} aria-label="编辑正文" />
          </label>
          <div className="board-dialog__actions">
            <button className="btn btn--ghost" type="button" onClick={onClose}>关闭</button>
            <button className="btn btn--primary" type="button" onClick={() => onSave(body)}>保存</button>
          </div>
        </div>
      </div>
    </div>
  );
}
