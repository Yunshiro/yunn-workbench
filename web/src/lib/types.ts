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
  draftCount: number;
  createdAt: number;
}

export type DraftStatus = "draft" | "published";

export interface Draft {
  id: string;
  topicId: string | null;
  topicTitle: string | null;
  title: string;
  content: string;
  status: DraftStatus;
  createdAt: number;
  updatedAt: number;
}

export type TaskKind = "summarize" | "evaluate" | "cluster" | "ideate";
export type TaskStatus = "queued" | "running" | "awaiting_feedback" | "completed" | "done" | "error" | "cancelled";
export type ResearchRole = "editor" | "growth" | "researcher";

export interface TaskTrace {
  id: string;
  tool: string;
  label: string;
  status: "running" | "done" | "error";
  input: Record<string, unknown>;
  summary: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface Task {
  id: string;
  kind: TaskKind;
  status: TaskStatus;
  input: { itemIds: string[]; extra?: string; goal?: string; role?: ResearchRole } | null;
  output: { raw: string; parsed: any; revision?: number | null; confirmedIndexes?: number[]; confirmedByRevision?: Record<string, number[]> } | null;
  trace: TaskTrace[];
  sessionId: string | null;
  sessionPath: string | null;
  profileSnapshot: CreatorContextSnapshot | null;
  lastActivityAt: number | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface CreatorProfile {
  id: string;
  cardName: string;
  isActive: boolean;
  name: string;
  domains: string[];
  audience: string;
  goals: string;
  tone: string;
  avoidTopics: string[];
  outputPreferences: { platforms?: string[]; language?: string; length?: string };
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryFact {
  id: string;
  profileId: string;
  category: string;
  content: string;
  status: "candidate" | "active" | "disabled";
  sourceType: "manual" | "topic_confirmation" | "agent";
  sourceId: string | null;
  confidence: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

export interface CreatorContextSnapshot { profile: CreatorProfile; memories: MemoryFact[]; }

export interface ResearchMessage {
  id: string;
  taskId: string;
  role: "user" | "assistant";
  mode: "steer" | "follow_up" | null;
  content: string;
  status: "queued" | "delivered" | "failed";
  createdAt: number;
  deliveredAt: number | null;
}

export interface ResearchRevision {
  id: string;
  taskId: string;
  revision: number;
  output: { raw: string; parsed: any };
  createdAt: number;
}

export interface ItemsResponse {
  items: Item[];
  total: number;
  limit: number;
  offset: number;
  unread: number;
}

export interface HealthResponse {
  ok: boolean;
  agentReady: boolean;
  agentConfigured: boolean;
  agentError: string | null;
}

export interface AgentStatusResponse {
  ready: boolean;
  configured: boolean;
  error: string | null;
}

export interface AgentProviderStatus {
  id: string;
  label: string;
  envVar: string;
  defaultModelId: string;
  environmentConfigured: boolean;
  models: AgentModelOption[];
}

export interface AgentModelOption {
  id: string;
  name: string;
}

export interface AgentConfigResponse {
  configured: boolean;
  activeConfigId: string;
  configs: AgentModelConfig[];
  providers: AgentProviderStatus[];
}

export type AgentModelConfigType = "builtin" | "openai_compatible";

export interface AgentModelConfig {
  id: string;
  name: string;
  type: AgentModelConfigType;
  providerId: string;
  providerLabel: string;
  modelId: string;
  baseUrl: string | null;
  isActive: boolean;
  configured: boolean;
  hasApiKey: boolean;
  apiKeySource: "profile" | "environment" | null;
  createdAt: number;
  updatedAt: number;
}

export interface AgentModelConfigInput {
  name: string;
  type: AgentModelConfigType;
  providerId: string;
  modelId: string;
  baseUrl?: string | null;
  apiKey?: string;
  clearApiKey?: boolean;
}

export type PromptKey = "system" | "common" | "summarize" | "evaluate" | "cluster" | "ideate";

export interface PromptConfigResponse {
  prompts: Record<PromptKey, string>;
  defaults: Record<PromptKey, string>;
  instructions: Record<PromptKey, string>;
  contracts: Record<PromptKey, {
    requiredVariables: string[];
    requiredFields: string[];
    structuredOutput: boolean;
  }>;
}
