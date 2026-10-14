import { boardEvents } from "./board-events.js";
import { BoardError } from "./board-error.js";
import { classifyBoardLink, fetchBoardLink, type FetchedLink } from "./board-link.js";
import {
  countBoardCards,
  deleteBoard,
  deleteBoardCard,
  findCardByDedupe,
  getBoard,
  getBoardCard,
  insertBoard,
  insertBoardCard,
  listBoardCards,
  listBoards,
  updateBoard,
  updateBoardCard,
  type Board,
  type BoardCard,
} from "./boards-db.js";

export class BoardDuplicateError extends BoardError {
  card: BoardCard;

  constructor(card: BoardCard) {
    super("已存在", 409);
    this.name = "BoardDuplicateError";
    this.card = card;
  }
}

const BODY_LIMIT = 20_000;

export function createBoard(name?: unknown): Board {
  return insertBoard(normalizeName(name, "未命名画板"));
}

export function renameBoard(id: string, name: unknown): Board {
  const board = requireBoard(id);
  return updateBoard(board.id, normalizeName(name))!;
}

export function removeBoard(id: string): void {
  if (!deleteBoard(id)) throw new BoardError("画板不存在", 404);
  boardEvents.emit("board_deleted", { boardId: id });
}

export function getBoards(): Board[] {
  return listBoards();
}

export function getCards(boardId: string): BoardCard[] {
  requireBoard(boardId);
  return listBoardCards(boardId);
}

export function addLinkCard(boardId: string, url: unknown, position?: { x?: unknown; y?: unknown }): BoardCard {
  requireBoard(boardId);
  if (typeof url !== "string") throw new BoardError("请输入链接");
  const classified = classifyBoardLink(url);
  if (!classified) throw new BoardError("请输入链接");
  const existing = findCardByDedupe(boardId, classified.dedupeKey);
  if (existing) throw new BoardDuplicateError(existing);
  const point = resolvePosition(boardId, position?.x, position?.y);
  let card: BoardCard;
  try {
    card = insertBoardCard({
      boardId,
      kind: "link",
      source: classified.source,
      status: "loading",
      url: classified.canonicalUrl,
      dedupeKey: classified.dedupeKey,
      x: point.x,
      y: point.y,
    });
  } catch (error) {
    const raced = findCardByDedupe(boardId, classified.dedupeKey);
    if (raced) throw new BoardDuplicateError(raced);
    throw error;
  }
  boardEvents.emit("board_card", { boardId, card });
  void settleCard(card.id);
  return card;
}

export function addNoteCard(boardId: string, input: { x?: unknown; y?: unknown; body?: unknown } = {}): BoardCard {
  requireBoard(boardId);
  const point = resolvePosition(boardId, input.x, input.y);
  const body = input.body === undefined ? "" : normalizeBody(input.body);
  const card = insertBoardCard({
    boardId,
    kind: "note",
    source: "note",
    status: "ready",
    url: null,
    dedupeKey: "",
    body,
    manual: true,
    x: point.x,
    y: point.y,
  });
  boardEvents.emit("board_card", { boardId, card });
  return card;
}

export function editCard(boardId: string, cardId: string, patch: { body?: unknown; x?: unknown; y?: unknown }): BoardCard {
  const card = requireCard(boardId, cardId);
  const next: Partial<BoardCard> = {};
  if (patch.x !== undefined || patch.y !== undefined) {
    if (patch.x !== undefined) next.x = requireCoord(patch.x);
    if (patch.y !== undefined) next.y = requireCoord(patch.y);
  }
  if (patch.body !== undefined) {
    next.body = normalizeBody(patch.body);
    next.manual = true;
    next.status = "ready";
    next.error = null;
  }
  const saved = updateBoardCard(card.id, next);
  if (!saved) throw new BoardError("卡片不存在", 404);
  boardEvents.emit("board_card", { boardId, card: saved });
  return saved;
}

export function retryCard(boardId: string, cardId: string): BoardCard {
  const card = requireCard(boardId, cardId);
  if (card.kind !== "link" || !card.url) throw new BoardError("这张卡片不是链接");
  if (card.status === "loading") return card;
  const saved = updateBoardCard(card.id, { status: "loading", error: null, manual: false })!;
  boardEvents.emit("board_card", { boardId, card: saved });
  void settleCard(card.id);
  return saved;
}

export function removeCard(boardId: string, cardId: string): void {
  const card = requireCard(boardId, cardId);
  deleteBoardCard(card.id);
  boardEvents.emit("board_card_deleted", { boardId, cardId: card.id });
}

async function settleCard(cardId: string): Promise<void> {
  const card = getBoardCard(cardId);
  if (!card || card.kind !== "link" || !card.url || card.status !== "loading") return;
  try {
    const fetched = await fetchBoardLink(card.url);
    const current = getBoardCard(cardId);
    if (!current || current.manual || current.status !== "loading") {
      if (current) boardEvents.emit("board_card", { boardId: current.boardId, card: current });
      return;
    }
    const saved = applyFetch(current.id, fetched);
    if (saved) boardEvents.emit("board_card", { boardId: saved.boardId, card: saved });
  } catch (error) {
    const current = getBoardCard(cardId);
    if (!current || current.manual || current.status !== "loading") return;
    const saved = updateBoardCard(current.id, { status: "failed", error: "抓取失败" });
    if (saved) boardEvents.emit("board_card", { boardId: saved.boardId, card: saved });
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[board] 抓取失败 ${current.source} ${current.id}：${message.slice(0, 120)}`);
  }
}

function applyFetch(cardId: string, fetched: FetchedLink): BoardCard | undefined {
  return updateBoardCard(cardId, {
    source: fetched.source,
    status: "ready",
    url: fetched.canonicalUrl,
    title: fetched.title,
    authorName: fetched.authorName,
    authorHandle: fetched.authorHandle,
    authorAvatar: fetched.authorAvatar,
    body: fetched.body,
    summary: fetched.summary,
    imageUrl: fetched.imageUrl,
    siteName: fetched.siteName,
    metrics: fetched.metrics,
    publishedAt: fetched.publishedAt,
    manual: false,
    error: null,
  });
}

function requireBoard(id: string): Board {
  const board = getBoard(id);
  if (!board) throw new BoardError("画板不存在", 404);
  return board;
}

function requireCard(boardId: string, cardId: string): BoardCard {
  const card = getBoardCard(cardId);
  if (!card || card.boardId !== boardId) throw new BoardError("卡片不存在", 404);
  return card;
}

function normalizeName(value: unknown, fallback?: string): string {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!name) {
    if (fallback) return fallback;
    throw new BoardError("请填写画板名称");
  }
  if (name.length > 80) throw new BoardError("画板名称不能超过 80 字");
  return name;
}

function normalizeBody(value: unknown): string {
  if (typeof value !== "string") throw new BoardError("正文格式不正确");
  const text = value.replace(/\r\n/g, "\n");
  if (text.length > BODY_LIMIT) throw new BoardError("正文不能超过 20000 字");
  return text;
}

function requireCoord(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) throw new BoardError("卡片位置不正确");
  return Math.max(-20000, Math.min(20000, number));
}

const CARD_SPAN_X = 300;
const CARD_SPAN_Y = 200;

function spotTaken(cards: BoardCard[], x: number, y: number): boolean {
  return cards.some((card) => Math.abs(card.x - x) < CARD_SPAN_X && Math.abs(card.y - y) < CARD_SPAN_Y);
}

/** 从锚点往右、再往下找一个不和现有卡片叠在一起的位置。 */
function placeNear(boardId: string, anchor: { x: number; y: number }): { x: number; y: number } {
  const cards = listBoardCards(boardId);
  for (let index = 0; index < 48; index += 1) {
    const column = index % 3;
    const row = Math.floor(index / 3);
    const x = anchor.x + column * CARD_SPAN_X;
    const y = anchor.y + row * CARD_SPAN_Y;
    if (!spotTaken(cards, x, y)) return { x, y };
  }
  return anchor;
}

function resolvePosition(boardId: string, x: unknown, y: unknown): { x: number; y: number } {
  if (x !== undefined || y !== undefined) {
    return placeNear(boardId, {
      x: x === undefined ? 80 : requireCoord(x),
      y: y === undefined ? 80 : requireCoord(y),
    });
  }
  const count = countBoardCards(boardId);
  const column = count % 3;
  const row = Math.floor(count / 3);
  return placeNear(boardId, { x: 48 + column * 340, y: 48 + row * 360 });
}
