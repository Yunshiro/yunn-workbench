import type {
  AgentStatusResponse,
  AgentConfigResponse,
  AgentModelConfig,
  AgentModelConfigInput,
  PromptConfigResponse,
  PromptKey,
  Feed,
  HealthResponse,
  ItemsResponse,
  Task,
  TaskKind,
  ResearchRole,
  Topic,
  TopicStatus,
  CreatorProfile,
  MemoryFact,
  ResearchMessage,
  ResearchRevision,
  Draft,
  DraftStatus,
  Board,
  BoardCard,
  BoardSession,
  BoardMessage,
  BookDetail,
  BookSummary,
  BookType,
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
  agentConfig: () =>
    fetch("/api/agent/config").then((r) => parse<AgentConfigResponse>(r)),
  createAgentConfig: (input: AgentModelConfigInput) =>
    fetch("/api/agent/configs", { method: "POST", headers: jsonHeaders, body: JSON.stringify(input) }).then((r) => parse<AgentModelConfig>(r)),
  updateAgentConfig: (id: string, input: AgentModelConfigInput) =>
    fetch(`/api/agent/configs/${id}`, { method: "PUT", headers: jsonHeaders, body: JSON.stringify(input) }).then((r) => parse<AgentModelConfig>(r)),
  activateAgentConfig: (id: string) =>
    fetch(`/api/agent/configs/${id}/activate`, { method: "POST" }).then((r) => parse<AgentModelConfig>(r)),
  duplicateAgentConfig: (id: string) =>
    fetch(`/api/agent/configs/${id}/duplicate`, { method: "POST" }).then((r) => parse<AgentModelConfig>(r)),
  testAgentConfig: (id: string) =>
    fetch(`/api/agent/configs/${id}/test`, { method: "POST" }).then((r) => parse<{ ok: true; message: string }>(r)),
  deleteAgentConfig: (id: string) =>
    fetch(`/api/agent/configs/${id}`, { method: "DELETE" }).then((r) => parse<{ ok: boolean }>(r)),
  promptConfig: () =>
    fetch("/api/agent/prompts").then((r) => parse<PromptConfigResponse>(r)),
  savePrompt: (key: PromptKey, value: string) =>
    fetch(`/api/agent/prompts/${key}`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ value }),
    }).then((r) => parse<PromptConfigResponse>(r)),
  resetPrompt: (key: PromptKey) =>
    fetch(`/api/agent/prompts/${key}`, { method: "DELETE" })
      .then((r) => parse<PromptConfigResponse>(r)),
  savePromptInstruction: (key: PromptKey, value: string) =>
    fetch(`/api/agent/prompts/${key}/instructions`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ value }),
    }).then((r) => parse<PromptConfigResponse>(r)),
  resetPromptInstruction: (key: PromptKey) =>
    fetch(`/api/agent/prompts/${key}/instructions`, { method: "DELETE" })
      .then((r) => parse<PromptConfigResponse>(r)),
  creatorProfile: () => fetch("/api/creator-profile").then((r) => parse<CreatorProfile>(r)),
  listCreatorProfiles: () => fetch("/api/creator-profiles").then((r) => parse<CreatorProfile[]>(r)),
  createCreatorProfile: (profile: Omit<CreatorProfile, "id" | "isActive" | "version" | "createdAt" | "updatedAt">) =>
    fetch("/api/creator-profiles", { method: "POST", headers: jsonHeaders, body: JSON.stringify(profile) }).then((r) => parse<CreatorProfile>(r)),
  saveCreatorProfile: (id: string, profile: Omit<CreatorProfile, "id" | "isActive" | "version" | "createdAt" | "updatedAt">) =>
    fetch(`/api/creator-profiles/${id}`, { method: "PUT", headers: jsonHeaders, body: JSON.stringify(profile) }).then((r) => parse<CreatorProfile>(r)),
  activateCreatorProfile: (id: string) =>
    fetch(`/api/creator-profiles/${id}/activate`, { method: "POST" }).then((r) => parse<CreatorProfile>(r)),
  duplicateCreatorProfile: (id: string) =>
    fetch(`/api/creator-profiles/${id}/duplicate`, { method: "POST" }).then((r) => parse<CreatorProfile>(r)),
  deleteCreatorProfile: (id: string) =>
    fetch(`/api/creator-profiles/${id}`, { method: "DELETE" }).then((r) => parse<{ ok: boolean }>(r)),
  saveActiveCreatorProfile: (profile: Omit<CreatorProfile, "id" | "isActive" | "version" | "createdAt" | "updatedAt">) =>
    fetch("/api/creator-profile", { method: "PUT", headers: jsonHeaders, body: JSON.stringify(profile) }).then((r) => parse<CreatorProfile>(r)),
  listMemories: (profileId?: string) => {
    const query = profileId ? `?profileId=${encodeURIComponent(profileId)}` : "";
    return fetch(`/api/memories${query}`).then((r) => parse<MemoryFact[]>(r));
  },
  createMemory: (content: string, category = "preference", profileId?: string) =>
    fetch("/api/memories", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ content, category, profileId }) }).then((r) => parse<MemoryFact>(r)),
  updateMemory: (id: string, patch: Partial<Pick<MemoryFact, "content" | "category" | "status">>) =>
    fetch(`/api/memories/${id}`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify(patch) }).then((r) => parse<MemoryFact>(r)),
  deleteMemory: (id: string) => fetch(`/api/memories/${id}`, { method: "DELETE" }).then((r) => parse<{ ok: boolean }>(r)),

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

  listDrafts: (params: { topicId?: string; status?: DraftStatus } = {}) => {
    const qs = new URLSearchParams();
    if (params.topicId) qs.set("topicId", params.topicId);
    if (params.status) qs.set("status", params.status);
    const suffix = qs.size ? `?${qs.toString()}` : "";
    return fetch(`/api/drafts${suffix}`).then((r) => parse<Draft[]>(r));
  },
  createDraft: (input: { topicId?: string | null; title?: string; content?: string } = {}) =>
    fetch("/api/drafts", { method: "POST", headers: jsonHeaders, body: JSON.stringify(input) }).then((r) => parse<Draft>(r)),
  updateDraft: (id: string, patch: Partial<Pick<Draft, "topicId" | "title" | "content" | "status">>) =>
    fetch(`/api/drafts/${id}`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify(patch) }).then((r) => parse<Draft>(r)),
  deleteDraft: (id: string) =>
    fetch(`/api/drafts/${id}`, { method: "DELETE" }).then((r) => parse<{ ok: boolean }>(r)),

  listTasks: () => fetch("/api/tasks").then((r) => parse<Task[]>(r)),
  deleteTasks: (ids: string[]) =>
    fetch("/api/tasks", { method: "DELETE", headers: jsonHeaders, body: JSON.stringify({ ids }) })
      .then((r) => parse<{ deletedIds: string[] }>(r)),
  getTask: (id: string) => fetch(`/api/tasks/${id}`).then((r) => parse<Task>(r)),
  researchMessages: (id: string) => fetch(`/api/tasks/${id}/messages`).then((r) => parse<ResearchMessage[]>(r)),
  researchRevisions: (id: string) => fetch(`/api/tasks/${id}/revisions`).then((r) => parse<ResearchRevision[]>(r)),
  sendResearchMessage: (id: string, content: string, mode: "steer" | "follow_up") =>
    fetch(`/api/tasks/${id}/messages`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ content, mode }) }).then((r) => parse<ResearchMessage>(r)),
  finishResearch: (id: string) => fetch(`/api/tasks/${id}/finish`, { method: "POST" }).then((r) => parse<Task>(r)),
  createTask: (
    kind: TaskKind,
    itemIds: string[],
    extra?: string,
    research?: { goal?: string; role?: ResearchRole },
  ) =>
    fetch("/api/tasks", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ kind, itemIds, extra, ...research }),
    }).then((r) => parse<Task>(r)),
  cancelTask: (id: string) =>
    fetch(`/api/tasks/${id}/cancel`, { method: "POST" }).then((r) => parse<Task>(r)),
  confirmTopics: (id: string, indexes: number[], revision?: number) =>
    fetch(`/api/tasks/${id}/confirm-topics`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ indexes, revision }),
    }).then((r) => parse<{ topics: Topic[] }>(r)),

  listBoards: () => fetch("/api/boards").then((r) => parse<Board[]>(r)),
  createBoard: (name?: string) =>
    fetch("/api/boards", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ name }) }).then((r) => parse<Board>(r)),
  renameBoard: (id: string, name: string) =>
    fetch(`/api/boards/${id}`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ name }) }).then((r) => parse<Board>(r)),
  deleteBoard: (id: string) => fetch(`/api/boards/${id}`, { method: "DELETE" }).then((r) => parse<{ ok: boolean }>(r)),
  listBoardCards: (id: string) => fetch(`/api/boards/${id}/cards`).then((r) => parse<BoardCard[]>(r)),
  addBoardLink: async (boardId: string, input: { url: string; x?: number; y?: number }): Promise<{ card: BoardCard; duplicate: boolean }> => {
    const res = await fetch(`/api/boards/${boardId}/cards`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(input) });
    let body: { error?: string; card?: BoardCard } | BoardCard | null = null;
    try { body = await res.json(); } catch { /* 非 JSON */ }
    if (res.status === 409 && body && "card" in body && body.card) return { card: body.card, duplicate: true };
    if (!res.ok) {
      const message = body && "error" in body && typeof body.error === "string" ? body.error : `请求失败（${res.status}）`;
      throw new Error(message);
    }
    return { card: body as BoardCard, duplicate: false };
  },
  addBoardNote: (boardId: string, input: { x?: number; y?: number; body?: string }) =>
    fetch(`/api/boards/${boardId}/cards`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ kind: "note", ...input }) }).then((r) => parse<BoardCard>(r)),
  updateBoardCard: (boardId: string, cardId: string, input: { body?: string; x?: number; y?: number }) =>
    fetch(`/api/boards/${boardId}/cards/${cardId}`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify(input) }).then((r) => parse<BoardCard>(r)),
  retryBoardCard: (boardId: string, cardId: string) =>
    fetch(`/api/boards/${boardId}/cards/${cardId}/retry`, { method: "POST" }).then((r) => parse<BoardCard>(r)),
  deleteBoardCard: (boardId: string, cardId: string) =>
    fetch(`/api/boards/${boardId}/cards/${cardId}`, { method: "DELETE" }).then((r) => parse<{ ok: boolean }>(r)),
  listBoardSessions: (id: string) => fetch(`/api/boards/${id}/sessions`).then((r) => parse<BoardSession[]>(r)),
  createBoardSession: (id: string) =>
    fetch(`/api/boards/${id}/sessions`, { method: "POST" }).then((r) => parse<BoardSession>(r)),
  listBoardMessages: (id: string, sessionId: string) =>
    fetch(`/api/boards/${id}/sessions/${sessionId}/messages`).then((r) => parse<BoardMessage[]>(r)),
  listBooks: () => fetch("/api/books").then((r) => parse<BookSummary[]>(r)),
  getBook: (id: string) => fetch(`/api/books/${id}`).then((r) => parse<BookDetail>(r)),
  importBook: async (file: File) => {
    const res = await fetch("/api/books", {
      method: "POST",
      headers: { "Content-Type": "application/epub+zip" },
      body: file,
    });
    return parse<BookDetail>(res);
  },
  updateBook: (id: string, input: { title?: string; author?: string; bookType?: BookType; rebuild?: boolean }) =>
    fetch(`/api/books/${id}`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify(input) }).then((r) => parse<BookDetail>(r)),
  setBookLevel: (id: string, level: number) =>
    fetch(`/api/books/${id}/level`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ level }) }).then((r) => parse<BookDetail>(r)),
  useBookHeadings: (id: string) =>
    fetch(`/api/books/${id}/level`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ source: "spine" }) }).then((r) => parse<BookDetail>(r)),
  setBookChapterSkipped: (id: string, chapterId: string, skipped: boolean) =>
    fetch(`/api/books/${id}/chapters/${chapterId}/skip`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ skipped }) }).then((r) => parse<BookDetail>(r)),
  renameBookChapter: (id: string, chapterId: string, title: string) =>
    fetch(`/api/books/${id}/chapters/${chapterId}`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ title }) }).then((r) => parse<BookDetail>(r)),
  mergeBookChapter: (id: string, chapterId: string) =>
    fetch(`/api/books/${id}/chapters/${chapterId}/merge`, { method: "POST" }).then((r) => parse<BookDetail>(r)),
  confirmBook: (id: string) => fetch(`/api/books/${id}/confirm`, { method: "POST" }).then((r) => parse<BookDetail>(r)),
  continueBook: (id: string) => fetch(`/api/books/${id}/continue`, { method: "POST" }).then((r) => parse<BookDetail>(r)),
  reopenBook: (id: string) => fetch(`/api/books/${id}/reopen`, { method: "POST" }).then((r) => parse<BookDetail>(r)),
  deleteBook: (id: string) => fetch(`/api/books/${id}`, { method: "DELETE" }).then((r) => parse<{ ok: boolean }>(r)),
  sendBoardMessage: (id: string, sessionId: string, content: string, cardIds?: string[]) =>
    fetch(`/api/boards/${id}/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ content, cardIds }),
    }).then((r) => parse<{ user: BoardMessage; assistant: BoardMessage }>(r)),
};
