import type {
  AgentStatusResponse,
  Feed,
  HealthResponse,
  ItemsResponse,
  Task,
  TaskKind,
  Topic,
  TopicStatus,
} from "./types";

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `请求失败（${res.status}）`;
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

const jsonHeaders = { "Content-Type": "application/json" };

export const api = {
  health: () => fetch("/api/health").then((r) => parse<HealthResponse>(r)),
  agentStatus: () =>
    fetch("/api/agent/status").then((r) => parse<AgentStatusResponse>(r)),

  listFeeds: () => fetch("/api/feeds").then((r) => parse<Feed[]>(r)),
  addFeed: (url: string, note = "") =>
    fetch("/api/feeds", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ url, note }),
    }).then((r) => parse<{ feedId: string; title: string; added: number }>(r)),
  deleteFeed: (id: string) =>
    fetch(`/api/feeds/${id}`, { method: "DELETE" }).then((r) => parse<{ ok: boolean }>(r)),
  fetchAllFeeds: () =>
    fetch("/api/feeds/fetch", { method: "POST" }).then((r) =>
      parse<{ feedId: string; title: string; added: number; error?: string }[]>(r),
    ),

  listItems: (params: {
    feedId?: string;
    unread?: boolean;
    starred?: boolean;
    query?: string;
    limit?: number;
    offset?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params.feedId) qs.set("feedId", params.feedId);
    if (params.unread) qs.set("unread", "1");
    if (params.starred) qs.set("starred", "1");
    if (params.query) qs.set("query", params.query);
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    return fetch(`/api/items?${qs.toString()}`).then((r) => parse<ItemsResponse>(r));
  },

  setRead: (id: string, isRead: boolean) =>
    fetch(`/api/items/${id}/read`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ isRead }),
    }).then((r) => parse<{ ok: boolean; unread: number }>(r)),
  setStar: (id: string, isStarred: boolean) =>
    fetch(`/api/items/${id}/star`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ isStarred }),
    }).then((r) => parse<{ ok: boolean }>(r)),
  markAllRead: (feedId?: string) =>
    fetch("/api/items/mark-all-read", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ feedId }),
    }).then((r) => parse<{ ok: boolean; unread: number }>(r)),

  listTopics: () => fetch("/api/topics").then((r) => parse<Topic[]>(r)),
  setTopicStatus: (id: string, status: TopicStatus) =>
    fetch(`/api/topics/${id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ status }),
    }).then((r) => parse<{ ok: boolean }>(r)),
  deleteTopic: (id: string) =>
    fetch(`/api/topics/${id}`, { method: "DELETE" }).then((r) => parse<{ ok: boolean }>(r)),

  listTasks: () => fetch("/api/tasks").then((r) => parse<Task[]>(r)),
  createTask: (kind: TaskKind, itemIds: string[], extra?: string) =>
    fetch("/api/tasks", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ kind, itemIds, extra }),
    }).then((r) => parse<Task>(r)),
};
