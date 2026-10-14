/** 与 `.board-card` 的宽度一致。高度在渲染前未知，先按实测上限留位。 */
export const CARD_WIDTH = 280;
export const CARD_MAX_HEIGHT = 360;
export const NOTE_HEIGHT = 168;
export const CARD_GAP = 24;

export interface CardBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacedCard extends CardBox {
  id: string;
  createdAt: number;
}

export interface ViewportTransform {
  x: number;
  y: number;
  zoom: number;
}

export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 两张卡片的外接矩形是否相交。gap 是它们之间至少要留出的空隙。 */
export function boxesOverlap(a: CardBox, b: CardBox, gap = 0): boolean {
  return a.x < b.x + b.width + gap
    && b.x < a.x + a.width + gap
    && a.y < b.y + b.height + gap
    && b.y < a.y + a.height + gap;
}

/**
 * 从锚点由近到远找一个空位。已有卡片用各自的宽高，新卡片用传入的尺寸
 * （渲染前用保守高度）。limit 是当前可见区域时，先留在这个区域里，避免高缩放时被甩到画布外。
 */
export function findOpenPosition(
  anchor: { x: number; y: number },
  existing: CardBox[],
  size: { width: number; height: number },
  gap = CARD_GAP,
  limit?: { x: number; y: number; width: number; height: number },
): { x: number; y: number } {
  const step = 48;
  const reachX = Math.max(8, Math.ceil(((size.width + gap) * 4) / step));
  const reachY = Math.max(8, Math.ceil(((size.height + gap) * 4) / step));
  const candidates: { x: number; y: number; dist: number }[] = [];
  for (let row = -reachY; row <= reachY; row += 1) {
    for (let column = -reachX; column <= reachX; column += 1) {
      candidates.push({
        x: anchor.x + column * step,
        y: anchor.y + row * step,
        dist: column * column + row * row,
      });
    }
  }
  candidates.sort((a, b) => a.dist - b.dist || a.y - b.y || a.x - b.x);
  const overlaps = (point: { x: number; y: number }) => {
    const box = { ...point, width: size.width, height: size.height };
    return existing.some((item) => boxesOverlap(box, item, gap));
  };
  const inside = (point: { x: number; y: number }) => {
    if (!limit) return true;
    return point.x >= limit.x - 1
      && point.y >= limit.y - 1
      && point.x + size.width <= limit.x + limit.width + 1
      && point.y + size.height <= limit.y + limit.height + 1;
  };
  return candidates.find((point) => !overlaps(point) && inside(point))
    ?? candidates.find((point) => !overlaps(point))
    ?? anchor;
}

/** 按创建顺序保住先放的卡片，把后放且相交的卡片挪到空位。 */
export function separateOverlaps(cards: PlacedCard[], gap = CARD_GAP): Array<{ id: string; x: number; y: number }> {
  const ordered = [...cards].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const placed: CardBox[] = [];
  const moves: Array<{ id: string; x: number; y: number }> = [];
  for (const card of ordered) {
    const current = { x: card.x, y: card.y, width: card.width, height: card.height };
    if (!placed.some((item) => boxesOverlap(current, item, gap))) {
      placed.push(current);
      continue;
    }
    const next = findOpenPosition(current, placed, { width: card.width, height: card.height }, gap);
    placed.push({ ...current, x: next.x, y: next.y });
    if (next.x !== card.x || next.y !== card.y) moves.push({ id: card.id, x: next.x, y: next.y });
  }
  return moves;
}

/** 与 React Flow `screenToFlowPosition` 相同：屏幕坐标减去容器，再按平移和缩放还原。 */
export function screenToFlow(
  screen: { x: number; y: number },
  container: ScreenRect,
  transform: ViewportTransform,
): { x: number; y: number } {
  return {
    x: (screen.x - container.left - transform.x) / transform.zoom,
    y: (screen.y - container.top - transform.y) / transform.zoom,
  };
}

export function flowToScreen(
  flow: { x: number; y: number },
  container: ScreenRect,
  transform: ViewportTransform,
): { x: number; y: number } {
  return {
    x: flow.x * transform.zoom + transform.x + container.left,
    y: flow.y * transform.zoom + transform.y + container.top,
  };
}

/** 让卡片中心落在容器中心。容器应是画布本身，不要把右侧对话栏算进去。 */
export function centeredCardOrigin(
  container: ScreenRect,
  transform: ViewportTransform,
  size: { width: number; height: number },
): { x: number; y: number } {
  const center = screenToFlow(
    { x: container.left + container.width / 2, y: container.top + container.height / 2 },
    container,
    transform,
  );
  return {
    x: center.x - size.width / 2,
    y: center.y - size.height / 2,
  };
}

export function visibleFlowBounds(
  container: ScreenRect,
  transform: ViewportTransform,
): { x: number; y: number; width: number; height: number } {
  const origin = screenToFlow({ x: container.left, y: container.top }, container, transform);
  return {
    x: origin.x,
    y: origin.y,
    width: container.width / transform.zoom,
    height: container.height / transform.zoom,
  };
}
