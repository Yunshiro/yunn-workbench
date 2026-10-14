import { createContext, memo, useContext, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowClockwise, ArrowSquareOut, Trash } from "@phosphor-icons/react";
import type { Node, NodeProps } from "@xyflow/react";
import type { BoardCard } from "../lib/types";
import { timeAgo } from "../lib/format";
import { Spinner } from "./ui";

export type BoardCardNodeData = Node<{ card: BoardCard }, "card">;

export interface BoardActions {
  highlightId: string | null;
  onDelete: (id: string) => void;
  onRetry: (id: string) => void;
  onSaveBody: (id: string, body: string) => void;
}

export const BoardActionsContext = createContext<BoardActions | null>(null);

function RemoteImage({ src, alt, className }: { src: string; alt: string; className: string }) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => setHidden(false), [src]);
  if (hidden) return null;
  return <img className={className} src={src} alt={alt} draggable={false} referrerPolicy="no-referrer" onError={() => setHidden(true)} />;
}

function NoteEditor({ card, onSave }: { card: BoardCard; onSave: (id: string, body: string) => void }) {
  const [value, setValue] = useState(card.body);
  const focused = useRef(false);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!focused.current) setValue(card.body);
  }, [card.body]);
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  return (
    <textarea
      className="board-card__note nodrag nopan nowheel"
      value={value}
      placeholder="写点什么…"
      aria-label="便签内容"
      onClick={(event) => event.stopPropagation()}
      onFocus={() => { focused.current = true; }}
      onBlur={() => {
        focused.current = false;
        if (timer.current) window.clearTimeout(timer.current);
        if (value !== card.body) onSave(card.id, value);
      }}
      onChange={(event) => {
        const next = event.target.value;
        setValue(next);
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => onSave(card.id, next), 500);
      }}
    />
  );
}

function ManualPaste({ card, onSave }: { card: BoardCard; onSave: (id: string, body: string) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  if (!open) {
    return (
      <button className="btn btn--sm" type="button" onClick={(event) => { event.stopPropagation(); setOpen(true); }}>
        手动粘贴正文
      </button>
    );
  }
  function save(event: FormEvent) {
    event.preventDefault();
    event.stopPropagation();
    onSave(card.id, value);
  }
  return (
    <form className="board-card__paste nodrag nopan" onSubmit={save} onClick={(event) => event.stopPropagation()}>
      <textarea
        className="board-card__paste-input nodrag nopan nowheel"
        value={value}
        placeholder="把正文粘贴到这里"
        aria-label="手动粘贴正文"
        onChange={(event) => setValue(event.target.value)}
      />
      <button className="btn btn--primary btn--sm" type="submit" disabled={!value.trim()}>保存</button>
    </form>
  );
}

function CardBody({ card }: { card: BoardCard }) {
  if (card.source === "x") {
    return (
      <>
        <header className="board-card__author">
          {card.authorAvatar && <RemoteImage className="board-card__avatar" src={card.authorAvatar} alt="" />}
          <div>
            <strong>{card.authorName || "未知作者"}</strong>
            {card.authorHandle && <span>@{card.authorHandle}</span>}
          </div>
        </header>
        <p className="board-card__text">{card.body}</p>
        {card.imageUrl && <RemoteImage className="board-card__cover" src={card.imageUrl} alt="" />}
        <footer className="board-card__meta">
          <span>点赞 {card.metrics?.likes ?? 0}</span>
          {typeof card.metrics?.reposts === "number" && <span>转发 {card.metrics.reposts}</span>}
          {typeof card.metrics?.replies === "number" && <span>回复 {card.metrics.replies}</span>}
          {card.publishedAt && <span>{timeAgo(card.publishedAt)}</span>}
        </footer>
      </>
    );
  }
  if (card.source === "youtube") {
    return (
      <>
        {card.imageUrl && <RemoteImage className="board-card__cover" src={card.imageUrl} alt="" />}
        <strong className="board-card__title">{card.title || "YouTube"}</strong>
        <p className="board-card__meta">{card.authorName || "未知频道"}</p>
      </>
    );
  }
  return (
    <>
      {card.imageUrl && <RemoteImage className="board-card__cover" src={card.imageUrl} alt="" />}
      <strong className="board-card__title">{card.title || card.url}</strong>
      {(card.summary || card.body) && <p className="board-card__text">{card.summary || card.body}</p>}
      {card.siteName && <p className="board-card__meta">{card.siteName}</p>}
    </>
  );
}

function BoardCardNodeView({ data }: NodeProps<BoardCardNodeData>) {
  const actions = useContext(BoardActionsContext);
  const card = data.card;
  if (!actions) return null;
  const flash = actions.highlightId === card.id;
  if (card.status === "loading") {
    return (
      <article className={`board-card board-card--loading${flash ? " board-card--flash" : ""}`}>
        <Spinner />
        <span>加载中</span>
      </article>
    );
  }
  if (card.status === "failed") {
    return (
      <article className={`board-card board-card--failed${flash ? " board-card--flash" : ""}`}>
        <strong>抓取失败</strong>
        {card.url && <p className="board-card__url">{card.url}</p>}
        <div className="board-card__actions nodrag nopan">
          <button className="btn btn--sm" type="button" onClick={(event) => { event.stopPropagation(); actions.onRetry(card.id); }}>
            <ArrowClockwise size={14} />
            重试
          </button>
          <ManualPaste card={card} onSave={actions.onSaveBody} />
          <button className="btn btn--ghost btn--sm" type="button" aria-label="删除卡片" onClick={(event) => { event.stopPropagation(); actions.onDelete(card.id); }}>
            <Trash size={14} />
          </button>
        </div>
      </article>
    );
  }
  if (card.kind === "note") {
    return (
      <article className={`board-card board-card--note${flash ? " board-card--flash" : ""}`}>
        <div className="board-card__actions nodrag nopan">
          <span className="board-card__kind">便签</span>
          <button className="btn btn--ghost btn--sm" type="button" aria-label="删除卡片" onClick={(event) => { event.stopPropagation(); actions.onDelete(card.id); }}>
            <Trash size={14} />
          </button>
        </div>
        <NoteEditor card={card} onSave={actions.onSaveBody} />
      </article>
    );
  }
  return (
    <article className={`board-card${flash ? " board-card--flash" : ""}`}>
      <CardBody card={card} />
      <div className="board-card__actions nodrag nopan">
        {card.url && (
          <a className="btn btn--ghost btn--sm" href={card.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
            <ArrowSquareOut size={14} />
            原文
          </a>
        )}
        <button className="btn btn--ghost btn--sm" type="button" aria-label="删除卡片" onClick={(event) => { event.stopPropagation(); actions.onDelete(card.id); }}>
          <Trash size={14} />
        </button>
      </div>
    </article>
  );
}

export default memo(BoardCardNodeView);
