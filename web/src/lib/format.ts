/** 相对时间 */
export function timeAgo(ts: number | null): string {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  if (diff < 0) return "刚刚";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN");
}

/** 完整时间 */
export function fullDate(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

/** 截断文本 */
export function truncate(text: string, max = 120): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const KIND_LABELS: Record<string, string> = {
  summarize: "摘要",
  evaluate: "评估",
  cluster: "聚类",
  ideate: "找选题",
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

const STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  done: "已完成",
  error: "失败",
  new: "新选题",
  writing: "写作中",
  discarded: "已丢弃",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function languageLabel(lang: string | null): string {
  if (lang === "zh") return "中文";
  if (lang === "en") return "英文";
  return lang ?? "—";
}
