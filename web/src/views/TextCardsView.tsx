import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CaretLeft, CaretRight, Plus } from "@phosphor-icons/react";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  PALETTE_ORDER,
  PALETTES,
  bodyStart,
  createSampleState,
  downloadDataUrl,
  exportFileLabel,
  isBodyPage,
  isQuotePage,
  layoutCards,
  layoutManualPage,
  layoutStatus,
  loadTextCardState,
  measureContext,
  pageChipLabel,
  pageCount,
  persistTextCardState,
  previewTitle,
  renderCard,
  renderCardPng,
  splitSource,
  type TextCardState,
} from "../lib/text-cards";

const EMPTY_LAYOUT = { contentPages: [[]] as string[][], bodyTexts: [""] };

export default function TextCardsView({ onBack }: { onBack: () => void }) {
  const [state, setState] = useState<TextCardState>(() => loadTextCardState());
  const [activePage, setActivePage] = useState(0);
  const [saveLabel, setSaveLabel] = useState("已保存");
  const [fontTick, setFontTick] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const pageEditRef = useRef<HTMLTextAreaElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<"title" | "page" | null>(null);
  const exportTimers = useRef<number[]>([]);
  const skipSave = useRef(true);

  useEffect(() => {
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) setFontTick((tick) => tick + 1);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => {
    exportTimers.current.forEach((id) => window.clearTimeout(id));
  }, []);

  useEffect(() => {
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    setSaveLabel("保存中");
    let pending = true;
    const handle = window.setTimeout(() => {
      pending = false;
      try {
        persistTextCardState(state);
        setSaveLabel("已保存");
      } catch {
        setSaveLabel("无法保存");
      }
    }, 300);
    return () => {
      window.clearTimeout(handle);
      if (!pending) return;
      try {
        persistTextCardState(state);
      } catch {
        /* 离开页面时写不进去就保留内存里的这一次编辑 */
      }
    };
  }, [state]);

  const layout = useMemo(() => {
    const draw = measureContext();
    if (!draw) return EMPTY_LAYOUT;
    return layoutCards(state, draw);
  }, [state, fontTick]);

  const total = pageCount(layout.contentPages.length, state.showQuotePage);
  const safePage = Math.max(0, Math.min(activePage, Math.max(0, total - 1)));
  const bodyIndex = safePage - bodyStart(state.showQuotePage);
  const onBodyPage = isBodyPage(safePage, state.showQuotePage);
  const pageText = onBodyPage ? (state.manualPages ? state.manualPages[bodyIndex] ?? "" : layout.bodyTexts[bodyIndex] ?? "") : "";
  const overfull = onBodyPage ? (measureContext() ? layoutManualPage(measureContext()!, pageText).height > 790 : false) : false;

  useEffect(() => {
    if (activePage !== safePage) setActivePage(safePage);
  }, [activePage, safePage]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const draw = canvas?.getContext("2d");
    if (!draw) return;
    renderCard(draw, state, safePage, layout.contentPages);
  }, [state, safePage, layout.contentPages]);

  useEffect(() => {
    if (pendingFocus.current === "title") titleRef.current?.focus();
    if (pendingFocus.current === "page") pageEditRef.current?.focus();
    pendingFocus.current = null;
  });

  useEffect(() => {
    const strip = stripRef.current;
    const chip = strip?.querySelector<HTMLButtonElement>("[data-active='true']");
    if (!strip || !chip) return;
    const left = chip.offsetLeft;
    const right = left + chip.offsetWidth;
    if (left < strip.scrollLeft) strip.scrollLeft = Math.max(0, left - 8);
    else if (right > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = right - strip.clientWidth + 8;
    }
  }, [safePage, total]);

  function patch(partial: Partial<TextCardState>) {
    setState((current) => ({ ...current, ...partial }));
  }

  function formatSource() {
    const result = splitSource(state.source);
    setState((current) => ({
      ...current,
      title: result.title,
      quote: result.quote,
      content: result.content,
      manualPages: null,
      showQuotePage: true,
      lastDeletedBody: null,
    }));
    setActivePage(0);
    pendingFocus.current = "title";
  }

  function editBodyPage(value: string) {
    const draw = measureContext();
    const existing = state.manualPages ?? (draw ? layoutCards(state, draw).bodyTexts : []);
    const next = existing.slice();
    const index = safePage - bodyStart(state.showQuotePage);
    if (index < 0) return;
    next[index] = value;
    patch({ manualPages: next });
  }

  function addPage() {
    const draw = measureContext();
    const texts = state.manualPages ?? (draw ? layoutCards(state, draw).bodyTexts : []);
    const insertAt = isBodyPage(safePage, state.showQuotePage)
      ? safePage - bodyStart(state.showQuotePage) + 1
      : texts.length;
    const next = texts.slice();
    next.splice(insertAt, 0, "");
    patch({ manualPages: next, lastDeletedBody: null });
    setActivePage(bodyStart(state.showQuotePage) + insertAt);
    pendingFocus.current = "page";
  }

  function deletePage() {
    if (safePage === 0) return;
    if (isQuotePage(safePage, state.showQuotePage)) {
      patch({ showQuotePage: false });
      return;
    }
    const draw = measureContext();
    const texts = state.manualPages ?? (draw ? layoutCards(state, draw).bodyTexts : []);
    const index = safePage - bodyStart(state.showQuotePage);
    const next = texts.slice();
    const removed = next.splice(index, 1)[0] ?? "";
    patch({ manualPages: next, lastDeletedBody: { index, text: removed } });
  }

  function undoDelete() {
    if (!state.lastDeletedBody || !state.manualPages) return;
    const next = state.manualPages.slice();
    const index = Math.min(state.lastDeletedBody.index, next.length);
    next.splice(index, 0, state.lastDeletedBody.text);
    patch({ manualPages: next, lastDeletedBody: null });
    setActivePage(bodyStart(state.showQuotePage) + index);
  }

  function restoreQuote() {
    patch({ showQuotePage: true });
    setActivePage(1);
  }

  function resetSample() {
    setState(createSampleState());
    setActivePage(0);
  }

  function exportCurrent() {
    try {
      const label = exportFileLabel(safePage, state.showQuotePage);
      downloadDataUrl(
        renderCardPng(state, safePage, layout.contentPages),
        `字卡-${PALETTES[state.palette].name}-${label}.png`,
      );
    } catch {
      setSaveLabel("导出失败");
    }
  }

  function exportAll() {
    exportTimers.current.forEach((id) => window.clearTimeout(id));
    exportTimers.current = [];
    try {
      const files = Array.from({ length: total }, (_, index) => ({
        url: renderCardPng(state, index, layout.contentPages),
        name: `字卡-${PALETTES[state.palette].name}-${String(index + 1).padStart(2, "0")}.png`,
      }));
      files.forEach((file, index) => {
        const handle = window.setTimeout(() => downloadDataUrl(file.url, file.name), index * 180);
        exportTimers.current.push(handle);
      });
    } catch {
      setSaveLabel("导出失败");
    }
  }

  const pageNote = overfull
    ? `本页文字过多，请精简以免超出画面 · ${pageText.length} / 300 字`
    : `此处只修改当前页，不影响其他正文页 · ${pageText.length} / 300 字`;

  return (
    <div className="text-cards">
      <section className="text-cards__editor" aria-label="字卡编辑">
        <header className="text-cards__intro">
          <div>
            <h2>内容</h2>
            <p>封面、语录和正文都只保存在这台浏览器。</p>
          </div>
          <div className="text-cards__intro-actions">
            <span id="saveState" className={`text-cards__save${saveLabel === "已保存" ? " text-cards__save--saved" : ""}`} aria-live="polite">
              {saveLabel}
            </span>
            <button className="btn btn--ghost btn--sm" type="button" onClick={onBack}>返回列表</button>
            <button id="resetButton" className="btn btn--ghost btn--sm" type="button" onClick={resetSample}>恢复示例</button>
          </div>
        </header>

        <label className="text-cards__field" htmlFor="sourceText">
          <span className="text-cards__field-head">
            <span>原始文字</span>
            <span id="sourceCount">{state.source.length} / 5000</span>
          </span>
          <textarea
            id="sourceText"
            className="text-cards__control"
            rows={8}
            maxLength={5000}
            value={state.source}
            onChange={(event) => patch({ source: event.target.value })}
          />
        </label>

        <button id="formatButton" className="btn btn--primary text-cards__generate" type="button" onClick={formatSource}>
          生成封面与分页
        </button>

        <div className="text-cards__divider" role="separator" />

        <div className="text-cards__split">
          <label className="text-cards__field" htmlFor="coverTitleText">
            <span>封面标题</span>
            <textarea
              id="coverTitleText"
              ref={titleRef}
              className="text-cards__control"
              rows={3}
              maxLength={60}
              value={state.title}
              onChange={(event) => patch({ title: event.target.value })}
            />
          </label>
          <label className="text-cards__field" htmlFor="subtitleText">
            <span>封面副标题</span>
            <textarea
              id="subtitleText"
              className="text-cards__control"
              rows={3}
              maxLength={60}
              value={state.subtitle}
              onChange={(event) => patch({ subtitle: event.target.value })}
            />
          </label>
        </div>

        <label className="text-cards__field" htmlFor="quotePageText">
          <span>封面引文 / 语录页</span>
          <textarea
            id="quotePageText"
            className="text-cards__control"
            rows={4}
            maxLength={60}
            value={state.quote}
            onChange={(event) => patch({ quote: event.target.value })}
          />
          <small>封面下方引用这句话，并生成一张独立语录页</small>
        </label>

        <label className="text-cards__field" htmlFor="quoteSourceText">
          <span>引文出处</span>
          <input
            id="quoteSourceText"
            className="text-cards__control"
            type="text"
            maxLength={50}
            placeholder="可留空，例如：写给认真生活的你"
            value={state.quoteSource}
            onChange={(event) => patch({ quoteSource: event.target.value })}
          />
        </label>

        <label className="text-cards__field" htmlFor="contentText">
          <span>正文原稿</span>
          <textarea
            id="contentText"
            className="text-cards__control"
            rows={9}
            maxLength={5000}
            value={state.content}
            onChange={(event) => patch({
              content: event.target.value,
              manualPages: null,
              lastDeletedBody: null,
            })}
          />
          <small>修改原稿会重新自动分页；单页修改请先选择右侧的正文卡片</small>
        </label>

        {onBodyPage && (
          <label className="text-cards__field text-cards__page-editor" id="pageEditor" htmlFor="pageEditText">
            <span id="pageEditTitle">单独编辑正文第 {bodyIndex + 1} 页</span>
            <textarea
              id="pageEditText"
              ref={pageEditRef}
              className="text-cards__control"
              rows={7}
              maxLength={300}
              value={pageText}
              onChange={(event) => editBodyPage(event.target.value)}
            />
            <small id="pageEditNote" className={overfull ? "text-cards__hint--warning" : undefined}>{pageNote}</small>
          </label>
        )}

        <div className="text-cards__themes-wrap">
          <div className="text-cards__field-head">
            <span>模板配色</span>
            <span id="themeName">{PALETTES[state.palette].name}</span>
          </div>
          <div className="text-cards__themes" id="themeGrid" role="radiogroup" aria-label="选择配色">
            {PALETTE_ORDER.map((key) => {
              const palette = PALETTES[key];
              const selected = state.palette === key;
              return (
                <button
                  key={key}
                  className={`text-cards__swatch${selected ? " text-cards__swatch--active" : ""}`}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-theme={key}
                  onClick={() => patch({ palette: key })}
                >
                  <span
                    className="text-cards__swatch-chip"
                    style={{ background: `radial-gradient(circle at 22% 24%, ${palette.wash[0]}, transparent 64%), ${palette.base}` }}
                  />
                  <span>{palette.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        <label className="text-cards__field" htmlFor="signatureText">
          <span>右上角栏目名</span>
          <input
            id="signatureText"
            className="text-cards__control"
            type="text"
            maxLength={20}
            placeholder="例如：暖心文案分享"
            value={state.column}
            onChange={(event) => patch({ column: event.target.value })}
          />
        </label>
      </section>

      <section className="text-cards__preview" aria-label="卡片预览">
        <div className="text-cards__toolbar">
          <div>
            <span className="text-cards__preview-title" id="previewTitle">{previewTitle(safePage, state.showQuotePage)}</span>
            <span className="text-cards__dimensions">1080 × 1440 px</span>
          </div>
          <div className="text-cards__exports">
            <button id="exportCurrentButton" className="btn btn--ghost" type="button" onClick={exportCurrent}>导出当前页</button>
            <button id="exportAllButton" className="btn btn--primary" type="button" onClick={exportAll}>导出全部</button>
          </div>
        </div>

        <div className="text-cards__stage">
          <canvas
            id="cardCanvas"
            ref={canvasRef}
            width={CARD_WIDTH}
            height={CARD_HEIGHT}
            className="text-cards__canvas"
            aria-label="生成的 3:4 文字卡片"
          />
        </div>

        <div className="text-cards__status">
          <p id="layoutStatus" role="status">{layoutStatus(layout.contentPages.length, state.showQuotePage)}</p>
          <div className="text-cards__pager">
            <button
              id="previousPageButton"
              className="btn btn--ghost btn--icon"
              type="button"
              aria-label="上一页"
              disabled={safePage === 0}
              onClick={() => setActivePage(safePage - 1)}
            >
              <CaretLeft size={14} />
            </button>
            <span id="pageCounter">{safePage + 1} / {total}</span>
            <button
              id="nextPageButton"
              className="btn btn--ghost btn--icon"
              type="button"
              aria-label="下一页"
              disabled={safePage >= total - 1}
              onClick={() => setActivePage(safePage + 1)}
            >
              <CaretRight size={14} />
            </button>
          </div>
        </div>

        <div className="text-cards__actions">
          <button id="addPageButton" className="btn btn--ghost btn--sm" type="button" onClick={addPage}>
            <Plus size={14} weight="bold" />
            新增正文卡片
          </button>
          {!state.showQuotePage && (
            <button id="restoreQuoteButton" className="btn btn--ghost btn--sm" type="button" onClick={restoreQuote}>
              恢复语录页
            </button>
          )}
          <button
            id="deletePageButton"
            className="btn btn--ghost btn--sm btn--danger"
            type="button"
            disabled={safePage === 0}
            onClick={deletePage}
          >
            {isQuotePage(safePage, state.showQuotePage) ? "删除语录页" : "删除当前卡片"}
          </button>
          {state.lastDeletedBody && (
            <button id="undoDeleteButton" className="btn btn--ghost btn--sm" type="button" onClick={undoDelete}>
              撤销删除
            </button>
          )}
        </div>

        <div className="text-cards__strip" id="pageStrip" ref={stripRef} aria-label="卡片页面列表">
          {Array.from({ length: total }, (_, index) => {
            const label = pageChipLabel(index, state.showQuotePage);
            const selected = index === safePage;
            return (
              <button
                key={`${label}-${index}`}
                className={`text-cards__chip${selected ? " text-cards__chip--active" : ""}`}
                type="button"
                data-active={selected ? "true" : "false"}
                aria-label={`查看${label}`}
                aria-current={selected ? "true" : undefined}
                onClick={() => setActivePage(index)}
              >
                {label}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
