import type { Item } from "./db.js";

/**
 * 把若干条信息拼成一段供模型阅读的文本。
 * 控制每条长度，避免撑爆上下文。
 */
export function itemsToText(items: Item[], maxPerItem = 2000): string {
  return items
    .map((it, i) => {
      const head = `[${i + 1}] ${it.title}${it.author ? ` — ${it.author}` : ""}${it.feedTitle ? `（来源：${it.feedTitle}）` : ""}`;
      const body = (it.contentText || "").slice(0, maxPerItem);
      return `${head}\n${body}`;
    })
    .join("\n\n---\n\n");
}

const COMMON_RULES = `
通用要求：
- 内容可能是中文或英文，请按内容原语言理解；输出时标注每项的建议语言（zh 或 en）。
- 只基于给出的材料，不要编造信息。材料不足时明确说明。
- 观点要具体、可执行，避免空话套话。
`;

export const PROMPTS: Record<string, (input: { items: Item[]; extra?: string }) => string> = {
  // 单条/多条：提炼核心
  summarize: ({ items, extra }) => `
你是一名资深信息编辑。请阅读下面的信息，提炼出最有价值的内容。

${itemsToText(items)}

${COMMON_RULES}

请严格输出如下 JSON（不要输出其他文字，不要用 markdown 代码块包裹）：
{
  "summary": "整体摘要，2-4 句话",
  "key_points": ["核心观点 1", "核心观点 2"],
  "quotes": ["值得直接引用的原句或金句"],
  "data_points": ["有价值的数据/事实"],
  "language": "zh 或 en"
}
`,

  // 单条：价值评估
  evaluate: ({ items }) => `
你是一名选题编辑，负责判断一条信息是否值得被写成一篇文章或推文。

请评估下面这条信息：
${itemsToText(items, 3000)}

${COMMON_RULES}

请严格输出如下 JSON（不要输出其他文字）：
{
  "score": 0 到 10 的整数,
  "novelty": "新颖度评价（这条信息新不新、反不反直觉）",
  "depth": "信息密度评价",
  "credibility": "可信度评价（来源是否可靠、有无数据支撑）",
  "worth_writing": true 或 false,
  "reason": "一句话说明为什么值得/不值得写",
  "suggested_angle": "如果值得写，建议的切入角度；不值得则留空字符串"
}
`,

  // 多条：聚类找趋势
  cluster: ({ items }) => `
你是一名内容趋势分析师。请阅读下面的多条信息，找出它们之间隐藏的主题与趋势。

${itemsToText(items, 1500)}

${COMMON_RULES}

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
}
`,

  // 找选题
  ideate: ({ items, extra }) => {
    const extraHint = extra
      ? `\n\n用户补充的选题方向偏好：${extra}\n`
      : "";
    return `
你是一名顶级选题策划，擅长从信息中挖掘可写的选题。用户是一名内容创作者，需要你帮他找到值得写的选题，产出形式是「X 推文」或「长文」。

请阅读下面的素材信息：
${itemsToText(items, 1800)}
${extraHint}
${COMMON_RULES}

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
}
`;
  },
};
