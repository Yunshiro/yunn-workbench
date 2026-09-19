export interface ParsedTaskOutput {
  raw: string;
  parsed: any;
  parseError?: string;
  repaired?: boolean;
  originalRaw?: string;
}

function extractJsonObject(text: string): unknown | null {
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let end = start; end < text.length; end++) {
      const character = text[end];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth++;
      else if (character === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, end + 1)); }
          catch { break; }
        }
      }
    }
  }
  return null;
}

const isRecord = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const isStringArray = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string");

export function validateTaskOutput(kind: string, value: unknown): string | null {
  if (!isRecord(value)) return "顶层结果必须是 JSON 对象";
  if (kind === "summarize") {
    if (typeof value.summary !== "string") return "summary 必须是文本";
    if (!isStringArray(value.key_points)) return "key_points 必须是文本数组";
    if (!isStringArray(value.quotes)) return "quotes 必须是文本数组";
    if (!isStringArray(value.data_points)) return "data_points 必须是文本数组";
    if (typeof value.language !== "string") return "language 必须是文本";
  } else if (kind === "evaluate") {
    if (typeof value.score !== "number" || !Number.isFinite(value.score)) return "score 必须是数字";
    for (const field of ["novelty", "depth", "credibility", "reason", "suggested_angle"]) {
      if (typeof value[field] !== "string") return `${field} 必须是文本`;
    }
    if (typeof value.worth_writing !== "boolean") return "worth_writing 必须是布尔值";
  } else if (kind === "cluster") {
    if (!Array.isArray(value.clusters)) return "clusters 必须是数组";
    for (const [index, cluster] of value.clusters.entries()) {
      if (!isRecord(cluster)) return `clusters[${index}] 必须是对象`;
      for (const field of ["theme", "description", "trend", "language"]) {
        if (typeof cluster[field] !== "string") return `clusters[${index}].${field} 必须是文本`;
      }
      if (!Array.isArray(cluster.item_indexes) || !cluster.item_indexes.every(Number.isInteger)) {
        return `clusters[${index}].item_indexes 必须是整数数组`;
      }
    }
    if (typeof value.overall !== "string") return "overall 必须是文本";
  } else if (kind === "ideate") {
    if (!Array.isArray(value.topics) || value.topics.length === 0) return "topics 必须是非空数组";
    for (const [index, topic] of value.topics.entries()) {
      if (!isRecord(topic)) return `topics[${index}] 必须是对象`;
      for (const field of ["title", "angle", "differentiation", "language"]) {
        if (typeof topic[field] !== "string") return `topics[${index}].${field} 必须是文本`;
      }
      if (!["tweet", "article"].includes(topic.type)) return `topics[${index}].type 必须是 tweet 或 article`;
      if (!isStringArray(topic.materials)) return `topics[${index}].materials 必须是文本数组`;
    }
    if (typeof value.strategy !== "string") return "strategy 必须是文本";
  }
  return null;
}

export function parseJsonOutput(text: string, kind?: string): ParsedTaskOutput {
  const parsed = extractJsonObject(text);
  if (parsed === null) return { raw: text, parsed: null, parseError: "没有找到有效的 JSON 对象" };
  const validationError = kind ? validateTaskOutput(kind, parsed) : null;
  return validationError
    ? { raw: text, parsed: null, parseError: validationError }
    : { raw: text, parsed };
}

export function buildJsonRepairPrompt(kind: string, raw: string, error: string): string {
  return `你刚才的结果无法被程序读取，原因：${error}。
请只修复 JSON 格式和字段类型，不要改变原意，不要调用工具，不要解释，也不要使用 Markdown 代码块。
任务类型：${kind}
原始结果：
${raw.slice(0, 12000)}`;
}
