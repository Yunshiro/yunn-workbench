import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Item } from "./db.js";
import { PI_PROMPTS_PATH } from "./config.js";

export type PromptKey = "system" | "common" | "summarize" | "evaluate" | "cluster" | "ideate";
export type PromptConfig = Record<PromptKey, string>;
export type PromptInstructions = Record<PromptKey, string>;

export interface PromptContract {
  requiredVariables: string[];
  requiredFields: string[];
  structuredOutput: boolean;
}

export const PROMPT_CONTRACTS: Record<PromptKey, PromptContract> = {
  system: { requiredVariables: [], requiredFields: [], structuredOutput: false },
  common: { requiredVariables: [], requiredFields: [], structuredOutput: false },
  summarize: {
    requiredVariables: ["{{items}}", "{{commonRules}}"],
    requiredFields: ["summary", "key_points", "quotes", "data_points", "language"],
    structuredOutput: true,
  },
  evaluate: {
    requiredVariables: ["{{items}}", "{{commonRules}}"],
    requiredFields: ["score", "novelty", "depth", "credibility", "worth_writing", "reason", "suggested_angle"],
    structuredOutput: true,
  },
  cluster: {
    requiredVariables: ["{{items}}", "{{commonRules}}"],
    requiredFields: ["clusters", "theme", "item_indexes", "description", "trend", "language", "overall"],
    structuredOutput: true,
  },
  ideate: {
    requiredVariables: ["{{items}}", "{{commonRules}}", "{{extra}}"],
    requiredFields: ["topics", "title", "type", "angle", "materials", "differentiation", "language", "strategy"],
    structuredOutput: true,
  },
};

const EMPTY_INSTRUCTIONS: PromptInstructions = {
  system: "", common: "", summarize: "", evaluate: "", cluster: "", ideate: "",
};

/** 默认提示词中的 {{items}}、{{commonRules}}、{{extra}} 会在执行时替换。 */
export const DEFAULT_PROMPTS: PromptConfig = {
  system: [
    "你是一名内容策展与选题专家，服务于一位内容创作者。",
    "你的任务：分析信息、提炼观点、判断价值，并产出可执行的高质量写作选题（X 推文或长文）。",
    "你总是严格按要求输出 JSON，内容具体、可执行，避免空话套话。",
    "只基于给出的材料作答，不要编造。",
  ].join(" "),

  common: `通用要求：
- 内容可能是中文或英文，请按内容原语言理解；输出时标注每项的建议语言（zh 或 en）。
- 只基于给出的材料，不要编造信息。材料不足时明确说明。
- 观点要具体、可执行，避免空话套话。`,

  summarize: `你是一名资深信息编辑。请阅读下面的信息，提炼出最有价值的内容。

{{items}}

{{commonRules}}

请严格输出如下 JSON（不要输出其他文字，不要用 markdown 代码块包裹）：
{
  "summary": "整体摘要，2-4 句话",
  "key_points": ["核心观点 1", "核心观点 2"],
  "quotes": ["值得直接引用的原句或金句"],
  "data_points": ["有价值的数据/事实"],
  "language": "zh 或 en"
}`,

  evaluate: `你是一名选题编辑，负责判断一条信息是否值得被写成一篇文章或推文。

请评估下面这条信息：
{{items}}

{{commonRules}}

请严格输出如下 JSON（不要输出其他文字）：
{
  "score": 0 到 10 的整数,
  "novelty": "新颖度评价（这条信息新不新、反不反直觉）",
  "depth": "信息密度评价",
  "credibility": "可信度评价（来源是否可靠、有无数据支撑）",
  "worth_writing": true 或 false,
  "reason": "一句话说明为什么值得/不值得写",
  "suggested_angle": "如果值得写，建议的切入角度；不值得则留空字符串"
}`,

  cluster: `你是一名内容趋势分析师。请阅读下面的多条信息，找出它们之间隐藏的主题与趋势。

{{items}}

{{commonRules}}

请严格输出如下 JSON（不要输出其他文字）：
{
  "clusters": [
    {
      "theme": "主题名（一句话）",
      "item_indexes": [属于该主题的条目编号，如 1, 3, 5],
      "description": "这个主题在讨论什么、为什么值得关注",
      "trend": "趋势判断（上升/降温/持续）",
      "language": "zh 或 en"
    }
  ],
  "overall": "整体观察，2-3 句话"
}`,

  ideate: `你是一名顶级选题策划，擅长从信息中挖掘可写的选题。用户是一名内容创作者，需要你帮他找到值得写的选题，产出形式是「X 推文」或「长文」。

请阅读下面的素材信息：
{{items}}
{{extra}}
{{commonRules}}

请严格输出如下 JSON（不要输出其他文字）。topics 数组给 3-6 个选题，按价值从高到低排序：
{
  "topics": [
    {
      "title": "选题标题，要有吸引力且准确",
      "type": "tweet 或 article",
      "angle": "切入角度：这篇要讲什么、核心论点是什么",
      "materials": ["引用的素材要点，标注来自第几条，如 '来自第2条：xxx'"],
      "differentiation": "差异化建议：和常见写法相比有什么不同、读者为什么非看不可",
      "language": "zh 或 en"
    }
  ],
  "strategy": "整体选题策略建议，2-3 句话，说明为什么这几个选题值得优先写"
}`,
};

const PROMPT_KEYS = Object.keys(DEFAULT_PROMPTS) as PromptKey[];

interface PromptStore {
  prompts: Partial<PromptConfig>;
  instructions: Partial<PromptInstructions>;
}

function readStore(): PromptStore {
  if (!existsSync(PI_PROMPTS_PATH)) return { prompts: {}, instructions: {} };
  try {
    const parsed = JSON.parse(readFileSync(PI_PROMPTS_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { prompts: {}, instructions: {} };
    const promptSource = parsed.prompts && typeof parsed.prompts === "object" ? parsed.prompts : parsed;
    const instructionSource = parsed.instructions && typeof parsed.instructions === "object" ? parsed.instructions : {};
    return {
      prompts: Object.fromEntries(
        PROMPT_KEYS.filter((key) => typeof promptSource[key] === "string").map((key) => [key, promptSource[key]]),
      ) as Partial<PromptConfig>,
      instructions: Object.fromEntries(
        PROMPT_KEYS.filter((key) => typeof instructionSource[key] === "string").map((key) => [key, instructionSource[key]]),
      ) as Partial<PromptInstructions>,
    };
  } catch (err) {
    throw new Error(`提示词配置无法读取：${String((err as Error).message || err)}`);
  }
}

function writeStore(store: PromptStore): void {
  mkdirSync(dirname(PI_PROMPTS_PATH), { recursive: true });
  const temporaryPath = `${PI_PROMPTS_PATH}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, PI_PROMPTS_PATH);
}

export function isPromptKey(value: string): value is PromptKey {
  return PROMPT_KEYS.includes(value as PromptKey);
}

export function getPromptConfig(): PromptConfig {
  return { ...DEFAULT_PROMPTS, ...readStore().prompts };
}

export function getPromptInstructions(): PromptInstructions {
  return { ...EMPTY_INSTRUCTIONS, ...readStore().instructions };
}

export function validatePromptTemplate(key: PromptKey, value: string): string[] {
  const contract = PROMPT_CONTRACTS[key];
  const issues = contract.requiredVariables
    .filter((variable) => !value.includes(variable))
    .map((variable) => `缺少必需变量 ${variable}`);
  for (const field of contract.requiredFields) {
    if (!value.includes(`"${field}"`)) issues.push(`缺少输出字段 "${field}"`);
  }
  return issues;
}

export function savePrompt(key: PromptKey, value: string): void {
  if (!value.trim()) throw new Error("提示词不能为空");
  const issues = validatePromptTemplate(key, value);
  if (issues.length > 0) throw new Error(`模板校验失败：${issues.join("；")}`);
  const store = readStore();
  store.prompts[key] = value;
  writeStore(store);
}

export function savePromptInstruction(key: PromptKey, value: string): void {
  const store = readStore();
  const trimmed = value.trim().slice(0, 4000);
  if (trimmed) store.instructions[key] = trimmed;
  else delete store.instructions[key];
  writeStore(store);
}

export function resetPrompt(key: PromptKey): void {
  const store = readStore();
  delete store.prompts[key];
  writeStore(store);
}

export function resetPromptInstruction(key: PromptKey): void {
  const store = readStore();
  delete store.instructions[key];
  writeStore(store);
}

/** 把若干条信息拼成一段供模型阅读的文本，并限制单条长度。 */
export function itemsToText(items: Item[], maxPerItem = 2000): string {
  return items
    .map((it, i) => {
      const head = `[${i + 1}] ${it.title}${it.author ? ` — ${it.author}` : ""}${it.feedTitle ? `（来源：${it.feedTitle}）` : ""}`;
      const body = (it.contentText || "").slice(0, maxPerItem);
      return `${head}\n${body}`;
    })
    .join("\n\n---\n\n");
}

export function buildTaskPrompt(kind: string, input: { items: Item[]; extra?: string }): string {
  if (!isPromptKey(kind) || kind === "system" || kind === "common") {
    throw new Error(`未知任务类型：${kind}`);
  }
  const prompts = getPromptConfig();
  const instructions = getPromptInstructions();
  const itemLimits: Record<Exclude<PromptKey, "system" | "common">, number> = {
    summarize: 2000,
    evaluate: 3000,
    cluster: 1500,
    ideate: 1800,
  };
  const variables = {
    items: itemsToText(input.items, itemLimits[kind]),
    commonRules: (() => {
      const custom = [instructions.common, instructions[kind]].filter((value) => value.trim()).join("\n");
      return custom ? `${prompts.common}\n\n用户自定义要求：\n${custom}` : prompts.common;
    })(),
    extra: input.extra ? `\n\n用户补充的选题方向偏好：${input.extra}\n` : "",
  };
  return Object.entries(variables).reduce(
    (result, [name, value]) => result.replaceAll(`{{${name}}}`, value),
    prompts[kind],
  ).trim();
}
