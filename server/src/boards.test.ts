import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { getAgentAuthConfig } from "./agent-auth.js";
import { askBoard } from "./board-chat.js";
import { collectBoardContext } from "./board-context.js";
import { classifyBoardLink, setBoardFetchTimeoutForTests } from "./board-link.js";
import { getBoardCard, getBoardSession, insertBoardMessage, updateBoardSession } from "./boards-db.js";
import { db } from "./db.js";
import { app } from "./http.js";
import { selectCitations } from "./knowledge-index.js";

const flags = { xUp: true, retryReady: false };

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function tweet(name: string, text: string, likes: number) {
  return {
    code: 200,
    tweet: {
      text,
      author: { name, screen_name: name.toLowerCase(), avatar_url: "https://example.com/a.jpg" },
      likes,
      retweets: 12,
      replies: 3,
      created_timestamp: 1700000000,
      media: { photos: [{ url: "https://example.com/p.jpg" }] },
    },
  };
}

function hang(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(html("<html><title>too late</title><body>late</body></html>"));
    }, 10_000);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted", "AbortError"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

async function route(url: string, init?: RequestInit): Promise<Response> {
  if (url.startsWith("https://hang.example/")) return hang(init?.signal);
  if (url.includes("api.fxtwitter.com")) {
    const id = url.match(/status\/(\d+)/)?.[1] || "";
    if (id === "777") return flags.retryReady ? json(tweet("Ada", "重试后的正文", 9)) : new Response("unavailable", { status: 503 });
    if (!flags.xUp) return new Response("unavailable", { status: 503 });
    if (id === "111") return json(tweet("Ada", "这条开头先抛一个反常识。", 128));
    if (id === "222") return json(tweet("Bea", "第二条正文。", 3));
    return json(tweet("Ada", `帖子 ${id}`, 1));
  }
  if (url.startsWith("https://www.youtube.com/oembed")) {
    return json({
      title: "雅思口语示范",
      author_name: "IELTS Channel",
      thumbnail_url: "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg",
      provider_name: "YouTube",
    });
  }
  if (url.startsWith("https://example.com/article")) {
    return html(`<!doctype html><head>
      <meta property="og:title" content="如何写开头">
      <meta property="og:description" content="先给结论，再补故事。">
      <meta property="og:image" content="https://example.com/cover.jpg">
      <meta property="og:site_name" content="写作笔记">
      <title>ignored</title>
    </head><body><p>页面里还有更多正文。</p></body></html>`);
  }
  return new Response("not mocked", { status: 500 });
}

describe("boards", { concurrency: 1 }, () => {
  let server: Server;
  let baseUrl = "";
  const realFetch = globalThis.fetch.bind(globalThis);

  before(async () => {
    assert.ok(process.env.WORKBENCH_HOME && !process.env.WORKBENCH_HOME.includes("/.workbench"));
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) return realFetch(input, init);
      return route(url, init);
    }) as typeof fetch;
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("无法确定测试端口");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    setBoardFetchTimeoutForTests(null);
    globalThis.fetch = realFetch;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function call(path: string, init: RequestInit = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers || {}) },
    });
    const text = await res.text();
    return { res, body: text ? JSON.parse(text) : null };
  }

  async function waitCard(boardId: string, cardId: string, ready: (card: any) => boolean) {
    const start = Date.now();
    let last: any = null;
    while (Date.now() - start < 4000) {
      const { body } = await call(`/api/boards/${boardId}/cards`);
      last = (body as any[]).find((card) => card.id === cardId);
      if (last && ready(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`卡片没有进入期望状态：${JSON.stringify(last)}`);
  }

  it("recognizes x.com, twitter.com and youtube links, and ignores plain text", () => {
    const x = classifyBoardLink("看看 https://x.com/Ada/status/111?s=20");
    const twitter = classifyBoardLink("https://twitter.com/Ada/status/111");
    const mobile = classifyBoardLink("https://mobile.twitter.com/Ada/status/111/photo/1");
    assert.equal(x?.source, "x");
    assert.equal(twitter?.source, "x");
    assert.equal(mobile?.source, "x");
    assert.equal(x?.dedupeKey, "x:111");
    assert.equal(twitter?.dedupeKey, x?.dedupeKey);
    assert.match(x?.fetchUrl || "", /^https:\/\/api\.fxtwitter\.com\/Ada\/status\/111$/);
    const watch = classifyBoardLink("https://www.youtube.com/watch?v=abcdefghijk&t=12");
    const short = classifyBoardLink("https://youtu.be/abcdefghijk");
    assert.equal(watch?.source, "youtube");
    assert.equal(short?.dedupeKey, watch?.dedupeKey);
    assert.equal(classifyBoardLink("https://example.com/article")?.source, "web");
    assert.equal(
      classifyBoardLink("https://example.com/article")?.dedupeKey,
      classifyBoardLink("https://example.com/article/")?.dedupeKey,
    );
    assert.equal(classifyBoardLink("今天先不贴链接"), null);
    assert.equal(classifyBoardLink("www.example.com/no-scheme"), null);
    assert.doesNotThrow(() => classifyBoardLink(""));
  });

  it("creates, renames and deletes boards, and keeps note text and position", async () => {
    const created = await call("/api/boards", { method: "POST", body: JSON.stringify({ name: "爆款墙" }) });
    assert.equal(created.res.status, 201);
    assert.equal(created.body.name, "爆款墙");
    const renamed = await call(`/api/boards/${created.body.id}`, { method: "PATCH", body: JSON.stringify({ name: "雅思素材" }) });
    assert.equal(renamed.body.name, "雅思素材");
    const note = await call(`/api/boards/${created.body.id}/cards`, {
      method: "POST",
      body: JSON.stringify({ kind: "note", x: 12.5, y: 48, body: "雅思开头：先问一个问题" }),
    });
    assert.equal(note.res.status, 201);
    assert.equal(note.body.source, "note");
    const moved = await call(`/api/boards/${created.body.id}/cards/${note.body.id}`, {
      method: "PATCH",
      body: JSON.stringify({ x: 400, y: 220, body: "雅思开头：先问一个问题。" }),
    });
    assert.equal(moved.body.x, 400);
    assert.equal(moved.body.y, 220);
    assert.equal(moved.body.body, "雅思开头：先问一个问题。");
    const again = await call(`/api/boards/${created.body.id}/cards`);
    const stored = again.body.find((card: any) => card.id === note.body.id);
    assert.equal(stored.body, "雅思开头：先问一个问题。");
    assert.equal(stored.x, 400);
    assert.equal(stored.y, 220);
    const removed = await call(`/api/boards/${created.body.id}/cards/${note.body.id}`, { method: "DELETE" });
    assert.equal(removed.body.ok, true);
    const empty = await call(`/api/boards/${created.body.id}/cards`);
    assert.equal(empty.body.length, 0);
    await call(`/api/boards/${created.body.id}/cards`, {
      method: "POST",
      body: JSON.stringify({ kind: "note", body: "删画板时一起消失" }),
    });
    const deleted = await call(`/api/boards/${created.body.id}`, { method: "DELETE" });
    assert.equal(deleted.body.ok, true);
    const missing = await call(`/api/boards/${created.body.id}/cards`);
    assert.equal(missing.res.status, 404);
    const left = db.prepare("SELECT COUNT(*) AS count FROM board_cards WHERE board_id = ?").get(created.body.id) as { count: number };
    assert.equal(Number(left.count), 0);
  });

  it("fetches x, twitter, youtube and web cards, and rejects duplicate or non-link text", async () => {
    flags.xUp = true;
    const board = (await call("/api/boards", { method: "POST", body: JSON.stringify({ name: "链接" }) })).body;
    const started = Date.now();
    const x = (await call(`/api/boards/${board.id}/cards`, {
      method: "POST",
      body: JSON.stringify({ url: "https://x.com/Ada/status/111", x: 10, y: 20 }),
    })).body;
    assert.equal(x.status, "loading");
    const ready = await waitCard(board.id, x.id, (card) => card.status === "ready");
    assert.ok(Date.now() - started < 5000);
    assert.equal(ready.source, "x");
    assert.equal(ready.authorName, "Ada");
    assert.equal(ready.authorHandle, "ada");
    assert.match(ready.body, /反常识/);
    assert.equal(ready.metrics.likes, 128);
    assert.equal(ready.url, "https://x.com/Ada/status/111");

    const twitter = (await call(`/api/boards/${board.id}/cards`, {
      method: "POST",
      body: JSON.stringify({ url: "https://twitter.com/Bea/status/222" }),
    })).body;
    const twitterReady = await waitCard(board.id, twitter.id, (card) => card.status === "ready");
    assert.equal(twitterReady.source, "x");
    assert.match(twitterReady.body, /第二条正文/);

    const duplicate = await call(`/api/boards/${board.id}/cards`, {
      method: "POST",
      body: JSON.stringify({ url: "https://twitter.com/Ada/status/111" }),
    });
    assert.equal(duplicate.res.status, 409);
    assert.equal(duplicate.body.error, "已存在");
    assert.equal(duplicate.body.card.id, x.id);
    const cards = await call(`/api/boards/${board.id}/cards`);
    assert.equal(cards.body.length, 2);

    const plain = await call(`/api/boards/${board.id}/cards`, {
      method: "POST",
      body: JSON.stringify({ url: "今天先不贴链接" }),
    });
    assert.equal(plain.res.status, 400);
    assert.equal(plain.body.error, "请输入链接");
    assert.equal((await call(`/api/boards/${board.id}/cards`)).body.length, 2);

    const video = (await call(`/api/boards/${board.id}/cards`, {
      method: "POST",
      body: JSON.stringify({ url: "https://youtu.be/abcdefghijk" }),
    })).body;
    const videoReady = await waitCard(board.id, video.id, (card) => card.status === "ready");
    assert.equal(videoReady.source, "youtube");
    assert.equal(videoReady.title, "雅思口语示范");
    assert.equal(videoReady.authorName, "IELTS Channel");
    assert.equal(videoReady.imageUrl, "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg");
    const sameVideo = await call(`/api/boards/${board.id}/cards`, {
      method: "POST",
      body: JSON.stringify({ url: "https://www.youtube.com/watch?v=abcdefghijk" }),
    });
    assert.equal(sameVideo.res.status, 409);

    const article = (await call(`/api/boards/${board.id}/cards`, {
      method: "POST",
      body: JSON.stringify({ url: "https://example.com/article" }),
    })).body;
    const articleReady = await waitCard(board.id, article.id, (card) => card.status === "ready");
    assert.equal(articleReady.source, "web");
    assert.equal(articleReady.title, "如何写开头");
    assert.match(articleReady.summary, /先给结论/);
    assert.equal(articleReady.imageUrl, "https://example.com/cover.jpg");
    assert.equal(articleReady.siteName, "写作笔记");
  });

  it("falls back when FxTwitter fails without blocking ordinary pages, and keeps manual text", async () => {
    flags.xUp = false;
    flags.retryReady = false;
    const board = (await call("/api/boards", { method: "POST", body: JSON.stringify({ name: "兜底" }) })).body;
    const x = (await call(`/api/boards/${board.id}/cards`, {
      method: "POST",
      body: JSON.stringify({ url: "https://x.com/Ada/status/333" }),
    })).body;
    const failed = await waitCard(board.id, x.id, (card) => card.status === "failed");
    assert.equal(failed.error, "抓取失败");
    assert.equal(failed.body, "");

    const article = (await call(`/api/boards/${board.id}/cards`, {
      method: "POST",
      body: JSON.stringify({ url: "https://example.com/article" }),
    })).body;
    const articleReady = await waitCard(board.id, article.id, (card) => card.status === "ready");
    assert.equal(articleReady.title, "如何写开头");
    assert.match(articleReady.summary, /先给结论/);

    const pasted = "手动粘贴的雅思开头：先抛一个反常识，再给自己的例子。";
    const saved = await call(`/api/boards/${board.id}/cards/${x.id}`, {
      method: "PATCH",
      body: JSON.stringify({ body: pasted }),
    });
    assert.equal(saved.res.status, 200);
    assert.equal(saved.body.status, "ready");
    assert.equal(saved.body.manual, true);
    assert.equal(saved.body.body, pasted);
    assert.equal(saved.body.error, null);
    const reread = await call(`/api/boards/${board.id}/cards`);
    assert.equal(reread.body.find((card: any) => card.id === x.id).body, pasted);

    const context = collectBoardContext(board.id, [x.id], 100_000);
    assert.equal(context.cards.length, 1);
    assert.equal(context.prompt.includes(pasted), true);
    assert.equal(context.citations[0].cardId, x.id);

    const retryCard = (await call(`/api/boards/${board.id}/cards`, {
      method: "POST",
      body: JSON.stringify({ url: "https://x.com/Ada/status/777" }),
    })).body;
    await waitCard(board.id, retryCard.id, (card) => card.status === "failed");
    flags.retryReady = true;
    const retried = await call(`/api/boards/${board.id}/cards/${retryCard.id}/retry`, { method: "POST" });
    assert.equal(retried.body.status, "loading");
    const recovered = await waitCard(board.id, retryCard.id, (card) => card.status === "ready");
    assert.match(recovered.body, /重试后的正文/);
    flags.xUp = true;
  });

  it("marks a card failed when fetching times out", async () => {
    setBoardFetchTimeoutForTests(80);
    try {
      const board = (await call("/api/boards", { method: "POST", body: JSON.stringify({ name: "超时" }) })).body;
      const started = Date.now();
      const card = (await call(`/api/boards/${board.id}/cards`, {
        method: "POST",
        body: JSON.stringify({ url: "https://hang.example/slow" }),
      })).body;
      const failed = await waitCard(board.id, card.id, (item) => item.status === "failed");
      assert.equal(failed.error, "抓取失败");
      assert.ok(Date.now() - started < 4000);
    } finally {
      setBoardFetchTimeoutForTests(null);
    }
  });

  it("builds citations from the selected cards and refuses an oversized context", async () => {
    const board = (await call("/api/boards", { method: "POST", body: JSON.stringify({ name: "对话" }) })).body;
    const bodies = ["ONLY_A 开头都是提问", "ONLY_B 先给结论", "ONLY_C 不该被引用"];
    const ids: string[] = [];
    for (const body of bodies) {
      const note = await call(`/api/boards/${board.id}/cards`, {
        method: "POST",
        body: JSON.stringify({ kind: "note", body }),
      });
      ids.push(note.body.id);
    }
    const selected = collectBoardContext(board.id, [ids[0], ids[1]], 100_000);
    assert.equal(selected.cards.length, 2);
    assert.equal(selected.prompt.includes("ONLY_A"), true);
    assert.equal(selected.prompt.includes("ONLY_B"), true);
    assert.equal(selected.prompt.includes("ONLY_C"), false);
    assert.deepEqual(selectCitations("见 [2]。", selected.citations).map((item) => item.cardId), [ids[1]]);
    const unnumbered = selectCitations("没有编号", selected.citations);
    assert.equal(unnumbered.length, 2);
    assert.equal(unnumbered.some((item) => item.cardId === ids[2]), false);

    const full = "乙".repeat(3000);
    const fitting = await call(`/api/boards/${board.id}/cards`, {
      method: "POST",
      body: JSON.stringify({ kind: "note", body: full }),
    });
    const fitted = collectBoardContext(board.id, [fitting.body.id], 100_000);
    assert.equal(fitted.prompt.includes(full), true);

    const huge = "甲".repeat(5000);
    const oversized = await call(`/api/boards/${board.id}/cards`, {
      method: "POST",
      body: JSON.stringify({ kind: "note", body: huge }),
    });
    assert.throws(() => collectBoardContext(board.id, [oversized.body.id], 100), /卡片内容超出模型上下文，请选中部分卡片后再提问/);
    assert.equal(getBoardCard(oversized.body.id)?.body.length, 5000);

    const session = (await call(`/api/boards/${board.id}/sessions`, { method: "POST" })).body;
    insertBoardMessage({ sessionId: session.id, role: "user", content: "这几条开头有什么共同点？", cardIds: [ids[0], ids[1]], status: "done" });
    insertBoardMessage({
      sessionId: session.id,
      role: "assistant",
      content: "都是先抛问题。[1]",
      citations: selected.citations.slice(0, 1),
      cardIds: [ids[0], ids[1]],
      status: "done",
    });
    updateBoardSession(session.id, { piSessionId: session.id, piSessionPath: "/tmp/board-session.jsonl" });
    const storedSession = getBoardSession(session.id);
    assert.equal(storedSession?.piSessionPath, "/tmp/board-session.jsonl");
    const listedSessions = await call(`/api/boards/${board.id}/sessions`);
    assert.equal(JSON.stringify(listedSessions.body).includes("piSessionPath"), false);
    const messages = await call(`/api/boards/${board.id}/sessions/${session.id}/messages`);
    assert.equal(messages.body.length, 2);
    assert.equal(messages.body[1].citations[0].cardId, ids[0]);
    assert.equal(messages.body[0].cardIds.length, 2);

    assert.equal(getAgentAuthConfig().configured, false);
    await assert.rejects(() => askBoard(board.id, session.id, "帮我写一条关于雅思的推文", [ids[0], ids[1]]), /请先在 Agent 设置中启用一个可用的模型/);
    const rejected = await call(`/api/boards/${board.id}/sessions/${session.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "再写一条", cardIds: [ids[0]] }),
    });
    assert.equal(rejected.res.status, 400);
    assert.match(rejected.body.error, /请先在 Agent 设置中启用一个可用的模型/);
    const unchanged = await call(`/api/boards/${board.id}/sessions/${session.id}/messages`);
    assert.equal(unchanged.body.length, 2);
  });
});
