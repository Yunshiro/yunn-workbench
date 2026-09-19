import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getItemsByIds, listFeeds, listItems, listTopics } from "./db.js";

type JsonSchema = Record<string, unknown>;

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

function textResult(value: unknown, summary: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: { summary },
  };
}

function compactItem(item: ReturnType<typeof listItems>[number], includeContent = false) {
  return {
    id: item.id,
    title: item.title,
    source: item.feedTitle,
    author: item.author,
    publishedAt: item.publishedAt,
    link: item.link,
    ...(includeContent
      ? { content: (item.contentText || "").slice(0, 12_000) }
      : { excerpt: (item.contentText || "").slice(0, 360) }),
  };
}

/** Read-only tools exposed to Pi during a topic research task. */
export function createResearchTools(seedItemIds: string[]): ToolDefinition[] {
  return [
    {
      name: "get_seed_materials",
      label: "读取种子素材",
      description: "读取用户为本次研究明确选择的全部 RSS 素材。开始研究时应先调用。",
      parameters: objectSchema({}) as any,
      execute: async () => {
        const items = getItemsByIds(seedItemIds).map((item) => compactItem(item, true));
        return textResult(items, `读取了 ${items.length} 条种子素材`);
      },
    },
    {
      name: "search_materials",
      label: "检索素材库",
      description: "按关键词搜索本地 RSS 条目的标题和正文，用于扩展证据和发现相关报道。",
      parameters: objectSchema({
        query: { type: "string", description: "具体搜索词，建议一次只搜索一个主题" },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 8 },
      }, ["query"]) as any,
      execute: async (_id, params: any) => {
        const limit = Math.min(Math.max(Number(params.limit) || 8, 1), 20);
        const items = listItems({ query: String(params.query), limit }).map((item) => compactItem(item));
        return textResult(items, `“${params.query}”找到 ${items.length} 条素材`);
      },
    },
    {
      name: "read_materials",
      label: "精读相关素材",
      description: "根据搜索结果中的 ID 阅读一到多条 RSS 正文，核对观点、事实和出处。",
      parameters: objectSchema({
        item_ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 8,
          description: "要精读的素材 ID",
        },
      }, ["item_ids"]) as any,
      execute: async (_id, params: any) => {
        const ids = Array.isArray(params.item_ids) ? params.item_ids.slice(0, 8).map(String) : [];
        const items = getItemsByIds(ids).map((item) => compactItem(item, true));
        return textResult(items, `精读了 ${items.length} 条相关素材`);
      },
    },
    {
      name: "list_sources",
      label: "查看订阅来源",
      description: "查看当前本地素材库包含哪些 RSS 来源以及来源备注。",
      parameters: objectSchema({}) as any,
      execute: async () => {
        const sources = listFeeds().map(({ id, title, note }) => ({ id, title, note }));
        return textResult(sources, `查看了 ${sources.length} 个订阅来源`);
      },
    },
    {
      name: "search_existing_topics",
      label: "检查历史选题",
      description: "搜索已经保存的选题，判断候选方向是否重复。完成候选选题前必须调用。",
      parameters: objectSchema({
        query: { type: "string", description: "候选主题或标题中的核心关键词；留空则查看最近选题" },
        limit: { type: "integer", minimum: 1, maximum: 30, default: 12 },
      }) as any,
      execute: async (_id, params: any) => {
        const query = String(params.query || "").trim().toLowerCase();
        const limit = Math.min(Math.max(Number(params.limit) || 12, 1), 30);
        const topics = listTopics()
          .filter((topic) => !query || [topic.title, topic.angle, topic.differentiation]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(query))
          .slice(0, limit)
          .map(({ id, title, type, angle, status, createdAt }) => ({ id, title, type, angle, status, createdAt }));
        return textResult(topics, query ? `检查“${params.query}”，找到 ${topics.length} 个历史选题` : `查看了最近 ${topics.length} 个历史选题`);
      },
    },
  ];
}

export const RESEARCH_TOOL_LABELS: Record<string, string> = {
  get_seed_materials: "读取种子素材",
  search_materials: "检索素材库",
  read_materials: "精读相关素材",
  list_sources: "查看订阅来源",
  search_existing_topics: "检查历史选题",
};
