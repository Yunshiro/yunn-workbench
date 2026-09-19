import express from "express";
import cors from "cors";
import type { Response } from "express";
import {
  deleteFeed,
  listFeeds,
  listItems,
  countItems,
  getItemsByIds,
  setItemRead,
  setItemStarred,
  markAllRead,
  countUnread,
  listTopics,
  getTopic,
  setTopicStatus,
  deleteTopic,
  listDrafts,
  getDraft,
  insertDraft,
  updateDraft,
  deleteDraft,
  listTasks,
  getTask,
  getCreatorProfile,
  listCreatorProfiles,
  createCreatorProfile,
  saveCreatorProfile,
  activateCreatorProfile,
  duplicateCreatorProfile,
  deleteCreatorProfile,
  listMemories,
  insertMemory,
  updateMemory,
  deleteMemory,
  listResearchMessages,
  listResearchRevisions,
  type MemoryFact,
  type CreatorProfileInput,
  type Draft,
  type Topic,
} from "./db.js";
import { addFeedByUrl, fetchAllFeeds } from "./rss.js";
import {
  agentEvents,
  enqueueTask,
  cancelTask,
  deleteTasks,
  confirmTaskTopics,
  finishResearchTask,
  getAgentError,
  isAgentConfigured,
  isAgentReady,
  resetAgentRuntime,
  type TaskInput,
  sendResearchMessage,
} from "./agent.js";
import {
  activateModelProfile,
  createModelProfile,
  deleteModelProfile,
  duplicateModelProfile,
  getAgentConfiguration,
  testModelProfile,
  updateModelProfile,
  type ModelProfileInput,
} from "./agent-auth.js";
import {
  DEFAULT_PROMPTS,
  PROMPT_CONTRACTS,
  getPromptConfig,
  getPromptInstructions,
  isPromptKey,
  resetPrompt,
  resetPromptInstruction,
  savePrompt,
  savePromptInstruction,
  validatePromptTemplate,
} from "./prompts.js";

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
  res.json({
    ok: true,
    agentReady: isAgentReady(),
    agentConfigured: isAgentConfigured(),
    agentError: getAgentError(),
  });
});

app.get("/api/agent/status", (_req, res) => {
  res.json({ ready: isAgentReady(), configured: isAgentConfigured(), error: getAgentError() });
});

app.get("/api/agent/config", wrap(async (_req, res) => {
  res.json(await getAgentConfiguration());
}));

const modelProfileInput = (body: any): ModelProfileInput => ({
  name: String(body?.name || "").trim(),
  type: body?.type === "openai_compatible" ? "openai_compatible" : "builtin",
  providerId: String(body?.providerId || ""),
  modelId: String(body?.modelId || ""),
  baseUrl: typeof body?.baseUrl === "string" ? body.baseUrl : null,
  apiKey: typeof body?.apiKey === "string" ? body.apiKey : undefined,
  clearApiKey: body?.clearApiKey === true,
});

app.post("/api/agent/configs", wrap(async (req, res) => {
  res.status(201).json(await createModelProfile(modelProfileInput(req.body)));
}));

app.put("/api/agent/configs/:id", wrap(async (req, res) => {
  const profile = await updateModelProfile(req.params.id, modelProfileInput(req.body));
  resetAgentRuntime();
  res.json(profile);
}));

app.post("/api/agent/configs/:id/activate", wrap(async (req, res) => {
  const profile = activateModelProfile(req.params.id);
  resetAgentRuntime();
  res.json(profile);
}));

app.post("/api/agent/configs/:id/duplicate", wrap(async (req, res) => {
  res.status(201).json(duplicateModelProfile(req.params.id));
}));

app.post("/api/agent/configs/:id/test", wrap(async (req, res) => {
  res.json(await testModelProfile(req.params.id));
}));

app.delete("/api/agent/configs/:id", wrap(async (req, res) => {
  deleteModelProfile(req.params.id);
  resetAgentRuntime();
  res.json({ ok: true });
}));

const promptConfigResponse = () => ({
  prompts: getPromptConfig(),
  defaults: DEFAULT_PROMPTS,
  instructions: getPromptInstructions(),
  contracts: PROMPT_CONTRACTS,
});

app.get("/api/agent/prompts", (_req, res) => res.json(promptConfigResponse()));

app.put("/api/agent/prompts/:key", wrap(async (req, res) => {
  const key = req.params.key;
  const { value } = req.body || {};
  if (!isPromptKey(key)) return res.status(400).json({ error: "未知提示词类型" });
  if (typeof value !== "string" || !value.trim()) {
    return res.status(400).json({ error: "提示词不能为空" });
  }
  const issues = validatePromptTemplate(key, value);
  if (issues.length > 0) return res.status(400).json({ error: `模板校验失败：${issues.join("；")}` });
  savePrompt(key, value);
  resetAgentRuntime();
  res.json(promptConfigResponse());
}));

app.delete("/api/agent/prompts/:key", wrap(async (req, res) => {
  const key = req.params.key;
  if (!isPromptKey(key)) return res.status(400).json({ error: "未知提示词类型" });
  resetPrompt(key);
  resetAgentRuntime();
  res.json(promptConfigResponse());
}));

app.put("/api/agent/prompts/:key/instructions", wrap(async (req, res) => {
  const key = req.params.key;
  const { value } = req.body || {};
  if (!isPromptKey(key)) return res.status(400).json({ error: "未知提示词类型" });
  if (typeof value !== "string") return res.status(400).json({ error: "补充要求必须是文本" });
  savePromptInstruction(key, value);
  resetAgentRuntime();
  res.json(promptConfigResponse());
}));

app.delete("/api/agent/prompts/:key/instructions", wrap(async (req, res) => {
  const key = req.params.key;
  if (!isPromptKey(key)) return res.status(400).json({ error: "未知提示词类型" });
  resetPromptInstruction(key);
  resetAgentRuntime();
  res.json(promptConfigResponse());
}));

// ---- Creator profile and memory ----

const creatorProfileInput = (body: any): CreatorProfileInput => {
  const stringArray = (value: unknown) => Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 30) : [];
  return {
    cardName: String(body.cardName || "").trim().slice(0, 100) || "未命名画像",
    name: String(body.name || "").trim().slice(0, 100),
    domains: stringArray(body.domains),
    audience: String(body.audience || "").trim().slice(0, 1000),
    goals: String(body.goals || "").trim().slice(0, 1000),
    tone: String(body.tone || "").trim().slice(0, 1000),
    avoidTopics: stringArray(body.avoidTopics),
    outputPreferences: {
      platforms: stringArray(body.outputPreferences?.platforms),
      language: String(body.outputPreferences?.language || "").trim().slice(0, 30),
      length: String(body.outputPreferences?.length || "").trim().slice(0, 100),
    },
  };
};

app.get("/api/creator-profile", (_req, res) => {
  res.json(getCreatorProfile());
});

app.put("/api/creator-profile", wrap(async (req, res) => {
  const current = getCreatorProfile();
  res.json(saveCreatorProfile(current.id, creatorProfileInput(req.body || {})));
}));

app.get("/api/creator-profiles", (_req, res) => {
  res.json(listCreatorProfiles());
});

app.post("/api/creator-profiles", wrap(async (req, res) => {
  res.status(201).json(createCreatorProfile(creatorProfileInput(req.body || {})));
}));

app.put("/api/creator-profiles/:id", wrap(async (req, res) => {
  res.json(saveCreatorProfile(req.params.id, creatorProfileInput(req.body || {})));
}));

app.post("/api/creator-profiles/:id/activate", wrap(async (req, res) => {
  res.json(activateCreatorProfile(req.params.id));
}));

app.post("/api/creator-profiles/:id/duplicate", wrap(async (req, res) => {
  res.status(201).json(duplicateCreatorProfile(req.params.id));
}));

app.delete("/api/creator-profiles/:id", wrap(async (req, res) => {
  deleteCreatorProfile(req.params.id);
  res.json({ ok: true });
}));

app.get("/api/memories", (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const profileId = typeof req.query.profileId === "string" ? req.query.profileId : undefined;
  const valid = ["candidate", "active", "disabled"];
  res.json(listMemories(valid.includes(status || "") ? status as MemoryFact["status"] : undefined, profileId));
});

app.post("/api/memories", wrap(async (req, res) => {
  const content = String(req.body?.content || "").trim();
  if (!content) return res.status(400).json({ error: "记忆内容不能为空" });
  res.json(insertMemory({ profileId: typeof req.body?.profileId === "string" ? req.body.profileId : undefined, category: String(req.body?.category || "preference"), content: content.slice(0, 1000), status: "active", sourceType: "manual" }));
}));

app.patch("/api/memories/:id", wrap(async (req, res) => {
  const patch: Partial<Pick<MemoryFact, "category" | "content" | "status">> = {};
  if (typeof req.body?.category === "string") patch.category = req.body.category.trim().slice(0, 100);
  if (typeof req.body?.content === "string") patch.content = req.body.content.trim().slice(0, 1000);
  if (["candidate", "active", "disabled"].includes(req.body?.status)) patch.status = req.body.status;
  const memory = updateMemory(req.params.id, patch);
  if (!memory) return res.status(404).json({ error: "记忆不存在" });
  res.json(memory);
}));

app.delete("/api/memories/:id", (req, res) => {
  deleteMemory(req.params.id);
  res.json({ ok: true });
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
  const requestedLimit = Number(q.limit);
  const requestedOffset = Number(q.offset);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200) : 30;
  const offset = Number.isFinite(requestedOffset) ? Math.max(Math.trunc(requestedOffset), 0) : 0;
  const filters = {
    feedId: q.feedId,
    unreadOnly: q.unread === "1" || q.unread === "true",
    starredOnly: q.starred === "1" || q.starred === "true",
    query: q.query,
  };
  const items = listItems({ ...filters, limit, offset });
  res.json({ items, total: countItems(filters), limit, offset, unread: countUnread() });
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

// ---- Drafts ----

app.get("/api/drafts", wrap(async (req, res) => {
  const status = req.query.status;
  if (status && !["draft", "published"].includes(String(status))) {
    return res.status(400).json({ error: "无效状态" });
  }
  res.json(listDrafts({
    topicId: typeof req.query.topicId === "string" ? req.query.topicId : undefined,
    status: status as Draft["status"] | undefined,
  }));
}));

app.get("/api/drafts/:id", wrap(async (req, res) => {
  const draft = getDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: "草稿不存在" });
  res.json(draft);
}));

app.post("/api/drafts", wrap(async (req, res) => {
  const topicId = typeof req.body?.topicId === "string" ? req.body.topicId : null;
  const topic = topicId ? getTopic(topicId) : undefined;
  if (topicId && !topic) return res.status(400).json({ error: "关联选题不存在" });
  const title = typeof req.body?.title === "string" ? req.body.title : topic?.title;
  const content = typeof req.body?.content === "string" ? req.body.content : undefined;
  res.status(201).json(insertDraft({ topicId, title, content }));
}));

app.patch("/api/drafts/:id", wrap(async (req, res) => {
  if (!getDraft(req.params.id)) return res.status(404).json({ error: "草稿不存在" });
  const patch: Partial<Pick<Draft, "topicId" | "title" | "content" | "status">> = {};
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "topicId")) {
    const topicId = req.body.topicId === null ? null : String(req.body.topicId || "");
    if (topicId && !getTopic(topicId)) return res.status(400).json({ error: "关联选题不存在" });
    patch.topicId = topicId || null;
  }
  if (typeof req.body?.title === "string") patch.title = req.body.title;
  if (typeof req.body?.content === "string") patch.content = req.body.content;
  if (req.body?.status !== undefined) {
    if (!["draft", "published"].includes(req.body.status)) return res.status(400).json({ error: "无效状态" });
    patch.status = req.body.status;
  }
  res.json(updateDraft(req.params.id, patch));
}));

app.delete("/api/drafts/:id", wrap(async (req, res) => {
  if (!getDraft(req.params.id)) return res.status(404).json({ error: "草稿不存在" });
  deleteDraft(req.params.id);
  res.json({ ok: true });
}));

// ---- Tasks ----

app.get("/api/tasks", wrap(async (_req, res) => {
  res.json(listTasks(50));
}));

app.delete("/api/tasks", wrap(async (req, res) => {
  const ids: string[] = Array.isArray(req.body?.ids)
    ? [...new Set<string>((req.body.ids as unknown[]).map(String).map((id) => id.trim()).filter(Boolean))].slice(0, 100)
    : [];
  if (ids.length === 0) return res.status(400).json({ error: "请选择要删除的任务" });
  res.json({ deletedIds: await deleteTasks(ids) });
}));

app.get("/api/tasks/:id", wrap(async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "任务不存在" });
  res.json(task);
}));

app.get("/api/tasks/:id/messages", wrap(async (req, res) => {
  res.json(listResearchMessages(req.params.id));
}));

app.get("/api/tasks/:id/revisions", wrap(async (req, res) => {
  res.json(listResearchRevisions(req.params.id));
}));

app.post("/api/tasks/:id/messages", wrap(async (req, res) => {
  const content = String(req.body?.content || "").trim();
  const mode = req.body?.mode === "steer" ? "steer" : "follow_up";
  if (!content) return res.status(400).json({ error: "消息不能为空" });
  if (content.length > 2000) return res.status(400).json({ error: "单条消息不能超过 2000 字" });
  res.json(await sendResearchMessage(req.params.id, content, mode));
}));

app.post("/api/tasks/:id/finish", wrap(async (req, res) => {
  res.json(finishResearchTask(req.params.id));
}));

app.post("/api/tasks", wrap(async (req, res) => {
  const { kind, itemIds, extra, goal, role } = req.body || {};
  const validKinds = ["summarize", "evaluate", "cluster", "ideate"];
  if (!validKinds.includes(kind)) return res.status(400).json({ error: "无效任务类型" });
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    return res.status(400).json({ error: "缺少 itemIds" });
  }
  const validRoles = ["editor", "growth", "researcher"];
  if (kind === "ideate" && role && !validRoles.includes(role)) {
    return res.status(400).json({ error: "无效研究角色" });
  }
  const input: TaskInput = {
    itemIds,
    extra: extra || undefined,
    goal: kind === "ideate" && typeof goal === "string" ? goal.trim() || undefined : undefined,
    role: kind === "ideate" ? role || "editor" : undefined,
  };
  const task = enqueueTask(kind, input);
  res.json(task);
}));

app.post("/api/tasks/:id/cancel", wrap(async (req, res) => {
  const cancelled = await cancelTask(req.params.id);
  if (!cancelled) return res.status(409).json({ error: "任务无法取消" });
  res.json(getTask(req.params.id));
}));

app.post("/api/tasks/:id/confirm-topics", wrap(async (req, res) => {
  const { indexes, revision } = req.body || {};
  if (!Array.isArray(indexes)) return res.status(400).json({ error: "缺少候选选题索引" });
  res.json({ topics: confirmTaskTopics(req.params.id, indexes.map(Number), revision ? Number(revision) : undefined) });
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
agentEvents.on("task_trace", (d) => broadcast("task_trace", d));
agentEvents.on("research_message", (d) => broadcast("research_message", d));
agentEvents.on("research_revision", (d) => broadcast("research_revision", d));
agentEvents.on("profile_memory_candidate", (d) => broadcast("profile_memory_candidate", d));
agentEvents.on("task_done", (d) => broadcast("task_done", d));
agentEvents.on("task_error", (d) => broadcast("task_error", d));
agentEvents.on("tasks_deleted", (d) => broadcast("tasks_deleted", d));
agentEvents.on("topics_created", (d) => broadcast("topics_created", d));
