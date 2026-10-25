export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1440;
export const STORAGE_KEY = "xhs-text-card-state-v7";

const LEGACY_KEYS = [
  "xhs-text-card-state-v6",
  "xhs-text-card-state-v5",
  "xhs-text-card-state-v3",
];

const SERIF = '"Songti SC", "Noto Serif CJK SC", "STSong", serif';
const LATIN = 'Georgia, "Times New Roman", serif';

export const PALETTE_ORDER = ["peach", "blue", "sage", "lilac", "honey"] as const;
export type PaletteKey = (typeof PALETTE_ORDER)[number];

export interface Palette {
  name: string;
  base: string;
  wash: [string, string, string];
  ink: string;
  softInk: string;
  line: string;
  rim: string;
}

export const PALETTES: Record<PaletteKey, Palette> = {
  peach: { name: "柔桃", base: "#FAF7F3", wash: ["#F3B79D", "#F2C8BA", "#EEC5AD"], ink: "#343331", softInk: "#595450", line: "#D9B3A5", rim: "#D5C8C1" },
  blue: { name: "雾蓝", base: "#F6F8F8", wash: ["#AAC4D2", "#CADAE2", "#B6C7D6"], ink: "#303B40", softInk: "#52616A", line: "#A6BBC6", rim: "#C7D1D4" },
  sage: { name: "鼠尾草", base: "#F8F8F3", wash: ["#BDCFB7", "#D6DDC8", "#B9CEBE"], ink: "#343B35", softInk: "#556257", line: "#B7C8AF", rim: "#D2D9CE" },
  lilac: { name: "淡紫", base: "#FAF8FA", wash: ["#D3BFDB", "#E5D7E8", "#C9C2DC"], ink: "#3D3743", softInk: "#665D6D", line: "#CBB9D0", rim: "#D9D0DC" },
  honey: { name: "蜜杏", base: "#FCF9F2", wash: ["#F0D09D", "#F5DFC0", "#EAC8A9"], ink: "#40392F", softInk: "#665B4C", line: "#DFC49E", rim: "#DDD2BC" },
};

export interface DeletedBodyPage {
  index: number;
  text: string;
}

export interface TextCardState {
  source: string;
  title: string;
  subtitle: string;
  quote: string;
  quoteSource: string;
  content: string;
  column: string;
  palette: PaletteKey;
  manualPages: string[] | null;
  showQuotePage: boolean;
  lastDeletedBody: DeletedBodyPage | null;
}

export interface CardLayout {
  contentPages: string[][];
  bodyTexts: string[];
}

const SAMPLE: TextCardState = {
  source: "一些很温暖、不内耗的句子。山有顶峰，湖有彼岸。在人生漫漫长途中，万物皆有回转。当我们觉得余味苦涩，请相信，一切终有回甘。\n\n不必在每一个日子里都表现得很有力量。允许自己偶尔停下来，去看一朵云，去听一场雨，去认真吃一顿饭。\n\n你已经走过了很多难走的路。那些缓慢的时刻，也在悄悄为你积攒力量。愿你带着温柔继续向前，也记得把温柔留给自己。",
  title: "一些很温暖\n不内耗的句子",
  subtitle: "SOME COMFORTING WORDS",
  quote: "山有顶峰，湖有彼岸。\n在漫漫长途中，\n一切终有回甘。",
  quoteSource: "写给认真生活的你",
  content: "不必在每一个日子里都表现得很有力量。允许自己偶尔停下来，去看一朵云，去听一场雨，去认真吃一顿饭。\n\n你已经走过了很多难走的路。那些缓慢的时刻，也在悄悄为你积攒力量。愿你带着温柔继续向前，也记得把温柔留给自己。",
  column: "暖心文案分享",
  palette: "peach",
  manualPages: null,
  showQuotePage: true,
  lastDeletedBody: null,
};

export function createSampleState(): TextCardState {
  return {
    ...SAMPLE,
    manualPages: null,
    lastDeletedBody: null,
  };
}

export function isPaletteKey(value: unknown): value is PaletteKey {
  return typeof value === "string" && PALETTE_ORDER.includes(value as PaletteKey);
}

function textOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export function normalizeTextCardState(value: unknown): TextCardState {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const deleted = record.lastDeletedBody;
  let lastDeletedBody: DeletedBodyPage | null = null;
  if (deleted && typeof deleted === "object") {
    const item = deleted as { index?: unknown; text?: unknown };
    if (Number.isInteger(item.index)) {
      lastDeletedBody = { index: item.index as number, text: String(item.text || "") };
    }
  }
  return {
    source: textOr(record.source, SAMPLE.source),
    title: textOr(record.title, textOr(record.coverTitle, SAMPLE.title)),
    subtitle: textOr(record.subtitle, SAMPLE.subtitle),
    quote: textOr(record.quote, textOr(record.quotePage, SAMPLE.quote)),
    quoteSource: textOr(record.quoteSource, SAMPLE.quoteSource),
    content: textOr(record.content, textOr(record.body, SAMPLE.content)),
    column: textOr(record.column, SAMPLE.column),
    palette: isPaletteKey(record.palette) ? record.palette : "peach",
    manualPages: Array.isArray(record.manualPages)
      ? record.manualPages.map((text) => String(text).slice(0, 300))
      : null,
    showQuotePage: record.showQuotePage !== false,
    lastDeletedBody,
  };
}

export function loadTextCardState(): TextCardState {
  if (typeof localStorage === "undefined") return createSampleState();
  try {
    const raw = [STORAGE_KEY, ...LEGACY_KEYS]
      .map((key) => localStorage.getItem(key))
      .find((item) => item);
    if (!raw) return createSampleState();
    return normalizeTextCardState(JSON.parse(raw));
  } catch {
    return createSampleState();
  }
}

export function persistTextCardState(state: TextCardState): void {
  const payload = {
    source: state.source,
    title: state.title,
    subtitle: state.subtitle,
    quote: state.quote,
    quoteSource: state.quoteSource,
    content: state.content,
    column: state.column,
    palette: state.palette,
    manualPages: state.manualPages,
    showQuotePage: state.showQuotePage,
    lastDeletedBody: state.lastDeletedBody,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

export function clean(value: string): string {
  return String(value || "").replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function splitSource(raw: string): { title: string; quote: string; content: string } {
  const text = clean(raw);
  if (!text) return { title: "", quote: "", content: "" };
  const paragraphs = text.split(/\n+/).map((part) => part.trim()).filter(Boolean);
  const first = paragraphs[0] ?? "";
  const explicitTitle = paragraphs.length > 1 && first.length <= 24 && !/[。！？!?]$/.test(first);
  const firstSentence = (text.match(/[^。！？!?\n]+[。！？!?]?/) || [text])[0]?.trim() ?? text;
  const title = explicitTitle ? first : firstSentence.replace(/[。！？!?]$/, "").slice(0, 22);
  const sentences = text.match(/[^。！？!?\n]+[。！？!?]?/g)?.map((part) => part.trim()).filter(Boolean) || [];
  const quote = sentences.find((part) => part.length >= 10 && part.length <= 50 && part !== firstSentence) || firstSentence;
  return {
    title,
    quote: quote.slice(0, 60),
    content: explicitTitle ? paragraphs.slice(1).join("\n\n") : text,
  };
}

export function bodyStart(showQuotePage: boolean): number {
  return showQuotePage ? 2 : 1;
}

export function pageCount(bodyPages: number, showQuotePage: boolean): number {
  return bodyPages + bodyStart(showQuotePage);
}

export function isQuotePage(index: number, showQuotePage: boolean): boolean {
  return showQuotePage && index === 1;
}

export function isBodyPage(index: number, showQuotePage: boolean): boolean {
  return index >= bodyStart(showQuotePage);
}

export function previewTitle(index: number, showQuotePage: boolean): string {
  if (index === 0) return "封面预览";
  if (isQuotePage(index, showQuotePage)) return "语录页预览";
  return `正文第 ${index - bodyStart(showQuotePage) + 1} 页`;
}

export function layoutStatus(bodyPages: number, showQuotePage: boolean): string {
  return `已生成封面${showQuotePage ? "、语录页" : ""}和 ${bodyPages} 张正文卡片`;
}

export function pageChipLabel(index: number, showQuotePage: boolean): string {
  if (index === 0) return "封面";
  if (isQuotePage(index, showQuotePage)) return "语录";
  return `正文 ${index - bodyStart(showQuotePage) + 1}`;
}

export function exportFileLabel(index: number, showQuotePage: boolean): string {
  if (index === 0) return "封面";
  if (isQuotePage(index, showQuotePage)) return "语录";
  return `正文-${index - bodyStart(showQuotePage) + 1}`;
}

function rgba(hex: string, alpha: number): string {
  const value = hex.slice(1);
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function paintPaper(draw: CanvasRenderingContext2D, variant: "cover" | "quote" | "content", palette: Palette): void {
  draw.clearRect(0, 0, 1080, 1440);
  draw.fillStyle = palette.base;
  draw.fillRect(0, 0, 1080, 1440);

  const spots: Array<[number, number, number, string, number]> = variant === "cover"
    ? [[130, 100, 520, palette.wash[0], 0.68], [960, 650, 510, palette.wash[2], 0.52], [100, 1290, 550, palette.wash[1], 0.61]]
    : variant === "quote"
      ? [[910, 180, 520, palette.wash[1], 0.57], [90, 840, 540, palette.wash[0], 0.45], [950, 1360, 480, palette.wash[2], 0.5]]
      : [[90, 160, 440, palette.wash[0], 0.43], [990, 760, 500, palette.wash[2], 0.36], [150, 1360, 440, palette.wash[1], 0.42]];
  spots.forEach(([x, y, radius, color, opacity]) => {
    const wash = draw.createRadialGradient(x, y, 0, x, y, radius);
    wash.addColorStop(0, rgba(color, opacity));
    wash.addColorStop(1, rgba(color, 0));
    draw.fillStyle = wash;
    draw.fillRect(0, 0, 1080, 1440);
  });
  draw.strokeStyle = palette.rim;
  draw.lineWidth = 2;
  draw.strokeRect(1, 1, 1078, 1438);
}

function drawCloud(draw: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  draw.save();
  draw.translate(x, y);
  draw.strokeStyle = color;
  draw.lineWidth = 3;
  draw.lineCap = "round";
  draw.lineJoin = "round";
  draw.beginPath();
  draw.moveTo(-25, 13);
  draw.bezierCurveTo(-35, 11, -34, -5, -22, -7);
  draw.bezierCurveTo(-18, -24, 4, -26, 12, -9);
  draw.bezierCurveTo(28, -10, 34, 11, 20, 15);
  draw.bezierCurveTo(9, 18, -15, 18, -25, 13);
  draw.stroke();
  draw.restore();
}

function drawWind(draw: CanvasRenderingContext2D, x: number, y: number, scale: number, color: string): void {
  draw.save();
  draw.translate(x, y);
  draw.scale(scale, scale);
  draw.strokeStyle = color;
  draw.lineWidth = 2.2;
  draw.lineCap = "round";
  ([[-108, -32, 95, -48], [-132, 12, 82, 2], [-88, 57, 108, 38]] as const).forEach(([startX, startY, endX, endY]) => {
    draw.beginPath();
    draw.moveTo(startX, startY);
    draw.bezierCurveTo(startX + 72, startY - 38, endX - 78, endY + 40, endX, endY);
    draw.stroke();
  });
  draw.restore();
}

export function wrapText(draw: CanvasRenderingContext2D, text: string, maxWidth: number, font: string): string[] {
  draw.font = font;
  const lines: string[] = [];
  const paragraphs = clean(text).split("\n");
  paragraphs.forEach((paragraph, paragraphIndex) => {
    if (!paragraph) {
      lines.push("");
      return;
    }
    let current = "";
    for (const char of paragraph) {
      if (current && draw.measureText(current + char).width > maxWidth) {
        if (/[，。！？；：、,.!?;:）】》”」]/.test(char) && current.length > 1) {
          const last = current.slice(-1);
          lines.push(current.slice(0, -1));
          current = last + char;
        } else {
          lines.push(current);
          current = char;
        }
      } else current += char;
    }
    if (current) lines.push(current);
    if (paragraphIndex < paragraphs.length - 1 && paragraphs[paragraphIndex + 1]) lines.push("");
  });
  return lines;
}

function paginate(draw: CanvasRenderingContext2D, content: string): string[][] {
  const text = clean(content);
  if (!text) return [[]];
  const pages: string[][] = [];
  let current: string[] = [];
  const finishPage = () => {
    while (current.at(-1) === "") current.pop();
    if (current.length) pages.push(current);
    current = [];
  };
  const lineCount = () => current.filter(Boolean).length;
  const paragraphs = text.split(/\n\s*\n|\n/).map((part) => part.trim()).filter(Boolean);
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const paragraphLength = wrapText(draw, paragraph, 760, `400 50px ${SERIF}`).filter(Boolean).length;
    if (current.length && paragraphLength <= 6 && lineCount() + paragraphLength > 6) finishPage();
    const sentences = paragraph.match(/[^。！？!?；;]+[。！？!?；;]*|[。！？!?；;]+/g) || [paragraph];
    sentences.forEach((sentence, sentenceIndex) => {
      const lines = wrapText(draw, sentence.trim(), 760, `400 50px ${SERIF}`).filter(Boolean);
      if (!lines.length) return;
      const needsGap = paragraphIndex > 0 && sentenceIndex === 0 && current.length > 0;
      if (lineCount() && lineCount() + lines.length > 6) finishPage();
      else if (needsGap && lineCount() + lines.length <= 6) current.push("");
      for (const line of lines) {
        if (lineCount() === 6) finishPage();
        current.push(line);
      }
    });
  });
  finishPage();
  return pages.length ? pages : [[]];
}

export function pageTextFromLines(lines: string[]): string {
  return lines.reduce((text, line) => line ? text + line : text + "\n\n", "").trim();
}

export interface ManualLayout {
  lines: string[];
  size: number;
  lineHeight: number;
  height: number;
}

export function layoutManualPage(draw: CanvasRenderingContext2D, text: string): ManualLayout {
  for (let size = 50; size >= 24; size -= 2) {
    const lines = wrapText(draw, text, 760, `400 ${size}px ${SERIF}`);
    const lineHeight = size * 1.8;
    const height = lines.reduce((sum, line) => sum + (line ? lineHeight : size * 0.8), 0);
    if (height <= 790) return { lines, size, lineHeight, height };
  }
  const size = 24;
  const lines = wrapText(draw, text, 760, `400 ${size}px ${SERIF}`);
  const lineHeight = size * 1.8;
  const height = lines.reduce((sum, line) => sum + (line ? lineHeight : size * 0.8), 0);
  return { lines, size, lineHeight, height };
}

let measureCanvas: HTMLCanvasElement | null = null;

export function measureContext(): CanvasRenderingContext2D | null {
  if (measureCanvas) return measureCanvas.getContext("2d");
  if (typeof document === "undefined") return null;
  measureCanvas = document.createElement("canvas");
  measureCanvas.width = 1080;
  measureCanvas.height = 1440;
  return measureCanvas.getContext("2d");
}

export function layoutCards(state: Pick<TextCardState, "content" | "manualPages">, draw: CanvasRenderingContext2D): CardLayout {
  if (state.manualPages) {
    return {
      contentPages: state.manualPages.map((text) => layoutManualPage(draw, text).lines),
      bodyTexts: state.manualPages.slice(),
    };
  }
  const contentPages = paginate(draw, state.content);
  return {
    contentPages,
    bodyTexts: contentPages.map(pageTextFromLines),
  };
}

function drawHeader(draw: CanvasRenderingContext2D, palette: Palette, column: string, label = ""): void {
  drawCloud(draw, 105, 112, palette.ink);
  draw.font = `400 29px ${SERIF}`;
  draw.fillStyle = palette.ink;
  draw.textAlign = "right";
  draw.fillText(clean(column) || "文字卡片", 966, 125, 340);
  draw.textAlign = "left";
  if (label) {
    draw.font = `600 25px ${LATIN}`;
    draw.fillStyle = palette.softInk;
    draw.fillText(label, 126, 221);
  }
}

function drawPageNumber(draw: CanvasRenderingContext2D, palette: Palette, index: number, total: number): void {
  draw.font = `400 25px ${SERIF}`;
  draw.fillStyle = palette.softInk;
  draw.textAlign = "right";
  draw.fillText(`${index + 1}/${total}`, 968, 1345);
  draw.textAlign = "left";
}

function titleLayout(draw: CanvasRenderingContext2D, title: string): { font: string; size: number; lines: string[] } {
  let size = 118;
  let lines: string[] = [];
  while (size >= 64) {
    const font = `700 ${size}px ${SERIF}`;
    lines = wrapText(draw, title, 810, font).filter(Boolean);
    if (lines.length <= 3 && lines.every((line) => draw.measureText(line).width <= 810)) return { font, size, lines };
    size -= 2;
  }
  return { font: `700 64px ${SERIF}`, size: 64, lines: wrapText(draw, title, 810, `700 64px ${SERIF}`).filter(Boolean) };
}

function drawCover(draw: CanvasRenderingContext2D, state: TextCardState, total: number): void {
  const palette = PALETTES[state.palette];
  paintPaper(draw, "cover", palette);
  drawHeader(draw, palette, state.column);
  const title = clean(state.title) || "在这里写下封面标题";
  const titleBlock = titleLayout(draw, title);
  draw.font = titleBlock.font;
  draw.fillStyle = palette.ink;
  draw.textBaseline = "alphabetic";
  let y = 315;
  titleBlock.lines.forEach((line) => {
    draw.fillText(line, 140, y, 820);
    y += titleBlock.size * 1.08;
  });

  const subtitle = clean(state.subtitle);
  if (subtitle) {
    const latin = /^[\x00-\x7F\s]+$/.test(subtitle);
    draw.font = latin ? `700 29px ${LATIN}` : `500 34px ${SERIF}`;
    draw.fillStyle = palette.ink;
    draw.fillText(subtitle, 144, Math.max(595, y + 12), 780);
  }

  const quote = clean(state.quote) || "在这里写下想被记住的一句话。";
  let quoteSize = 47;
  let quoteLines: string[] = [];
  while (quoteSize >= 33) {
    quoteLines = wrapText(draw, quote, 545, `400 ${quoteSize}px ${SERIF}`);
    if (quoteLines.filter(Boolean).length <= 6) break;
    quoteSize -= 2;
  }
  const quoteFont = `400 ${quoteSize}px ${SERIF}`;
  draw.font = `400 70px ${SERIF}`;
  draw.fillStyle = palette.ink;
  draw.fillText("“", 104, 805);
  draw.font = quoteFont;
  draw.fillStyle = palette.softInk;
  let quoteY = 798;
  quoteLines.forEach((line) => {
    if (line) {
      draw.fillText(line, 156, quoteY, 555);
      quoteY += quoteSize * 1.34;
    } else quoteY += quoteSize * 0.48;
  });
  const source = clean(state.quoteSource);
  if (source) {
    draw.font = `400 32px ${SERIF}`;
    draw.fillStyle = palette.ink;
    draw.fillText(`—  ${source}`, 145, 1217, 610);
  }
  drawWind(draw, 830, 1030, 1.1, palette.softInk);
  drawPageNumber(draw, palette, 0, total);
}

function drawQuotePage(draw: CanvasRenderingContext2D, state: TextCardState, total: number): void {
  const palette = PALETTES[state.palette];
  paintPaper(draw, "quote", palette);
  drawHeader(draw, palette, state.column, "A FEW WORDS TO KEEP");
  draw.font = `400 88px ${SERIF}`;
  draw.fillStyle = palette.ink;
  draw.fillText("“", 130, 505);
  const quote = clean(state.quote) || "在这里写下想被记住的一句话。";
  let size = 61;
  let lines: string[] = [];
  while (size >= 34) {
    lines = wrapText(draw, quote, 770, `400 ${size}px ${SERIF}`);
    if (lines.filter(Boolean).length <= 5) break;
    size -= 2;
  }
  draw.font = `400 ${size}px ${SERIF}`;
  draw.fillStyle = palette.ink;
  let y = 560;
  lines.forEach((line) => {
    if (line) {
      draw.fillText(line, 164, y, 790);
      y += size * 1.72;
    } else y += size * 0.6;
  });
  const source = clean(state.quoteSource);
  if (source) {
    draw.font = `400 31px ${SERIF}`;
    draw.fillStyle = palette.softInk;
    draw.fillText(`—  ${source}`, 166, 1120, 760);
  }
  drawWind(draw, 850, 1100, 0.62, palette.softInk);
  drawPageNumber(draw, palette, 1, total);
}

function drawContentPage(
  draw: CanvasRenderingContext2D,
  state: TextCardState,
  index: number,
  contentPages: string[][],
): void {
  const palette = PALETTES[state.palette];
  paintPaper(draw, "content", palette);
  drawHeader(draw, palette, state.column, "SLOW READING");
  draw.strokeStyle = palette.line;
  draw.lineWidth = 2;
  draw.beginPath();
  draw.moveTo(130, 295);
  draw.lineTo(225, 295);
  draw.stroke();
  const bodyIndex = index - bodyStart(state.showQuotePage);
  const layout = state.manualPages
    ? layoutManualPage(draw, state.manualPages[bodyIndex] || "")
    : { lines: contentPages[bodyIndex] || [], size: 50, lineHeight: 90 };
  const { lines, size, lineHeight } = layout;
  draw.font = `400 ${size}px ${SERIF}`;
  draw.fillStyle = palette.ink;
  const height = lines.reduce((sum, line) => sum + (line ? lineHeight : size * 0.8), 0);
  let y = Math.max(430, 775 - height / 2);
  lines.forEach((line) => {
    if (line) {
      draw.fillText(line, 158, y, 770);
      y += lineHeight;
    } else y += size * 0.8;
  });
  drawWind(draw, 850, 1110, 0.55, palette.softInk);
  drawPageNumber(draw, palette, index, pageCount(contentPages.length, state.showQuotePage));
}

export function renderCard(
  draw: CanvasRenderingContext2D,
  state: TextCardState,
  index: number,
  contentPages: string[][],
): void {
  const total = pageCount(contentPages.length, state.showQuotePage);
  if (index === 0) drawCover(draw, state, total);
  else if (isQuotePage(index, state.showQuotePage)) drawQuotePage(draw, state, total);
  else drawContentPage(draw, state, index, contentPages);
}

export function renderCardPng(state: TextCardState, index: number, contentPages: string[][]): string {
  const output = document.createElement("canvas");
  output.width = CARD_WIDTH;
  output.height = CARD_HEIGHT;
  const draw = output.getContext("2d");
  if (!draw) throw new Error("无法创建导出画布");
  renderCard(draw, state, index, contentPages);
  return output.toDataURL("image/png");
}

export function downloadDataUrl(url: string, filename: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}
