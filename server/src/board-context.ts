import { BoardError } from "./board-error.js";
import { excerpt } from "./knowledge-index.js";
import {
  getBoard,
  listBoardCards,
  type BoardCard,
  type BoardCitation,
} from "./boards-db.js";

/** 留给系统提示、问题、多轮历史和回答的余量，最多占上下文的四分之一。 */
export function contextBudget(contextWindow: number): number {
  const reserve = Math.min(8000, Math.floor(contextWindow * 0.25));
  return Math.max(1, contextWindow - reserve);
}

/** 中文按 1 字 1 token 估算，英文按 4 字 1 token。只用于判断是否放得下，不会据此截断。 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    const code = char.codePointAt(0) || 0;
    tokens += code > 0xff ? 1 : 0.25;
  }
  return Math.ceil(tokens);
}

export function assessBoardContext(blocks: string[], contextWindow: number): { ok: boolean; tokens: number; budget: number } {
  const budget = contextBudget(contextWindow);
  const tokens = blocks.reduce((sum, block) => sum + estimateTokens(block), 0);
  return { ok: tokens <= budget, tokens, budget };
}

export interface BoardContext {
  cards: BoardCard[];
  citations: BoardCitation[];
  blocks: string[];
  prompt: string;
}

const SOURCE_LABEL: Record<BoardCard["source"], string> = {
  x: "X 帖子",
  web: "网页",
  youtube: "YouTube",
  note: "便签",
};

export function cardTitle(card: BoardCard): string {
  if (card.title.trim()) return card.title.trim();
  if (card.authorName.trim()) return card.authorName.trim();
  const line = (card.body || card.summary).trim().split("\n")[0] || "";
  return line.slice(0, 40) || "便签";
}

export function cardBlock(card: BoardCard, index: number): string {
  const lines = [`[${index}] 类型：${SOURCE_LABEL[card.source]}`];
  if (card.title.trim()) lines.push(`标题：${card.title.trim()}`);
  if (card.authorName.trim() || card.authorHandle.trim()) {
    const handle = card.authorHandle.trim() ? ` (@${card.authorHandle.trim()})` : "";
    lines.push(`作者：${card.authorName.trim()}${handle}`);
  }
  if (card.siteName.trim()) lines.push(`来源：${card.siteName.trim()}`);
  if (card.url) lines.push(`链接：${card.url}`);
  if (card.metrics) {
    const bits = [
      typeof card.metrics.likes === "number" ? `点赞：${card.metrics.likes}` : "",
      typeof card.metrics.reposts === "number" ? `转发：${card.metrics.reposts}` : "",
      typeof card.metrics.replies === "number" ? `回复：${card.metrics.replies}` : "",
    ].filter(Boolean);
    if (bits.length) lines.push(bits.join(" "));
  }
  lines.push("---");
  lines.push((card.body || card.summary).trim() || "（无正文）");
  return lines.join("\n");
}

function readable(card: BoardCard): boolean {
  if (card.status === "loading") return false;
  return `${card.body}${card.summary}${card.title}`.trim().length > 0;
}

/**
 * 组装本次提问要用的卡片。卡片正文会整段放进提示词。
 * 放不进模型上下文时直接拒绝，不截断、不悄悄丢掉后面的卡片。
 */
export function collectBoardContext(boardId: string, cardIds: string[] | undefined, contextWindow: number): BoardContext {
  if (!getBoard(boardId)) throw new BoardError("画板不存在", 404);
  if (!Number.isFinite(contextWindow) || contextWindow < 1) throw new BoardError("当前模型没有可用的上下文长度");
  let cards = listBoardCards(boardId);
  const selected = Array.isArray(cardIds) && cardIds.length > 0;
  if (selected) {
    const wanted = new Set(cardIds);
    const missing = cardIds.filter((id) => !cards.some((card) => card.id === id));
    if (missing.length) throw new BoardError("选中的卡片不在当前画板");
    cards = cards.filter((card) => wanted.has(card.id));
  }
  const usable = cards.filter(readable);
  if (usable.length === 0) {
    throw new BoardError(selected ? "选中的卡片还没有可引用的正文" : "画板上还没有可引用的内容，请先添加卡片或便签");
  }
  const blocks = usable.map((card, index) => cardBlock(card, index + 1));
  const assessment = assessBoardContext(blocks, contextWindow);
  if (!assessment.ok) throw new BoardError("卡片内容超出模型上下文，请选中部分卡片后再提问");
  const citations = usable.map((card, index) => ({
    index: index + 1,
    cardId: card.id,
    title: cardTitle(card),
    excerpt: excerpt(card.body || card.summary || card.title),
    source: card.source,
  }));
  return {
    cards: usable,
    citations,
    blocks,
    prompt: `以下是画板上的卡片。回答时用方括号编号引用。\n\n${blocks.join("\n\n")}`,
  };
}
