// 与后端 server/src/db.ts 的数据结构一一对应

export interface Feed {
  id: string;
  title: string;
  url: string;
  note: string;
  createdAt: number;
  lastFetchedAt: number | null;
  lastError: string | null;
}

export interface Item {
  id: string;
  feedId: string;
  guid: string;
  title: string;
  link: string;
  author: string | null;
  contentHtml: string | null;
  contentText: string | null;
  publishedAt: number | null;
  fetchedAt: number;
  isRead: boolean;
  isStarred: boolean;
  feedTitle?: string;
}

export type TopicType = "tweet" | "article";
export type TopicStatus = "new" | "writing" | "done" | "discarded";

export interface Topic {
  id: string;
  title: string;
  type: TopicType;
  angle: string | null;
  materials: string[];
  differentiation: string | null;
  language: string | null;
  status: TopicStatus;
  sourceItemIds: string[];
  createdAt: number;
}

export type TaskKind = "summarize" | "evaluate" | "cluster" | "ideate";
export type TaskStatus = "queued" | "running" | "done" | "error";

export interface Task {
  id: string;
  kind: TaskKind;
  status: TaskStatus;
  input: { itemIds: string[]; extra?: string } | null;
  output: { raw: string; parsed: any } | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface ItemsResponse {
  items: Item[];
  unread: number;
}

export interface HealthResponse {
  ok: boolean;
  agentReady: boolean;
  agentError: string | null;
}

export interface AgentStatusResponse {
  ready: boolean;
  error: string | null;
}
