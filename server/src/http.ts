import express from "express";
import cors from "cors";
import type { Response } from "express";
import {
  deleteFeed,
  listFeeds,
  listItems,
  getItemsByIds,
  setItemRead,
  setItemStarred,
  markAllRead,
  countUnread,
  listTopics,
  setTopicStatus,
  deleteTopic,
  listTasks,
  type Topic,
} from "./db.js";
import { addFeedByUrl, fetchAllFeeds } from "./rss.js";
import { agentEvents, enqueueTask, getAgentError, isAgentReady, type TaskInput } from "./agent.js";

export const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const wrap = (fn: (req: any, res: Response) => Promise<any> | any) => {
  return (req: any, res: Response) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      res.status(500).json({ error: String((err as Error).message || err) });
    });
  };
};

// ---- 健康检查 / 状态 ----

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, agentReady: isAgentReady(), agentError: getAgentError() });
});

app.get("/api/agent/status", (_req, res) => {
  res.json({ ready: isAgentReady(), error: getAgentError() });
});

// ---- Feeds ----

app.get("/api/feeds", wrap(async (_req, res) => {
  res.json(listFeeds());
}));

app.post("/api/feeds", wrap(async (req, res) => {
  const { url, note } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "缺少 url" });
  }
  const result = await addFeedByUrl(url.trim(), (note || "").trim());
  res.json(result);
}));

app.delete("/api/feeds/:id", wrap(async (req, res) => {
  deleteFeed(req.params.id);
  res.json({ ok: true });
}));

app.post("/api/feeds/fetch", wrap(async (_req, res) => {
  const results = await fetchAllFeeds();
  res.json(results);
}));

// ---- Items ----

app.get("/api/items", wrap(async (req, res) => {
  const q = req.query as any;
  const items = listItems({
    feedId: q.feedId,
    unreadOnly: q.unread === "1" || q.unread === "true",
    starredOnly: q.starred === "1" || q.starred === "true",
    query: q.query,
    limit: q.limit ? Number(q.limit) : 200,
    offset: q.offset ? Number(q.offset) : 0,
  });
  res.json({ items, unread: countUnread() });
}));

app.post("/api/items/batch", wrap(async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: "缺少 ids" });
  res.json({ items: getItemsByIds(ids) });
}));

app.post("/api/items/:id/read", wrap(async (req, res) => {
  const { isRead } = req.body || {};
  setItemRead(req.params.id, !!isRead);
  res.json({ ok: true, unread: countUnread() });
}));

app.post("/api/items/:id/star", wrap(async (req, res) => {
  const { isStarred } = req.body || {};
  setItemStarred(req.params.id, !!isStarred);
  res.json({ ok: true });
}));

app.post("/api/items/mark-all-read", wrap(async (req, res) => {
  const { feedId } = req.body || {};
  markAllRead(feedId || undefined);
  res.json({ ok: true, unread: countUnread() });
}));

// ---- Topics ----

app.get("/api/topics", wrap(async (_req, res) => {
  res.json(listTopics());
}));

app.patch("/api/topics/:id", wrap(async (req, res) => {
  const { status } = req.body || {};
  const valid = ["new", "writing", "done", "discarded"];
  if (!valid.includes(status)) return res.status(400).json({ error: "无效状态" });
  setTopicStatus(req.params.id, status as Topic["status"]);
  res.json({ ok: true });
}));

app.delete("/api/topics/:id", wrap(async (req, res) => {
  deleteTopic(req.params.id);
  res.json({ ok: true });
}));

// ---- Tasks ----

app.get("/api/tasks", wrap(async (_req, res) => {
  res.json(listTasks(50));
}));

app.post("/api/tasks", wrap(async (req, res) => {
  const { kind, itemIds, extra } = req.body || {};
  const validKinds = ["summarize", "evaluate", "cluster", "ideate"];
  if (!validKinds.includes(kind)) return res.status(400).json({ error: "无效任务类型" });
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    return res.status(400).json({ error: "缺少 itemIds" });
  }
  const input: TaskInput = { itemIds, extra: extra || undefined };
  const task = enqueueTask(kind, input);
  res.json(task);
}));

// ---- SSE ----

const sseClients = new Set<Response>();

export function broadcast(event: string, data: any): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// 把 agent 事件广播到所有 SSE 客户端
agentEvents.on("task_queued", ({ task }) => broadcast("task_queued", { task }));
agentEvents.on("task_status", (d) => broadcast("task_status", d));
agentEvents.on("task_delta", (d) => broadcast("task_delta", d));
agentEvents.on("task_thinking", (d) => broadcast("task_thinking", d));
agentEvents.on("task_done", (d) => broadcast("task_done", d));
agentEvents.on("task_error", (d) => broadcast("task_error", d));
agentEvents.on("topics_created", (d) => broadcast("topics_created", d));
