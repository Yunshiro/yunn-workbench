import type { Draft } from "./types";

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function safeFilename(title: string): string {
  const normalized = title
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 100);
  return normalized || "未命名草稿";
}

export function draftToMarkdown(draft: Draft): string {
  const metadata = [
    "---",
    `title: ${yamlString(draft.title)}`,
    `status: ${yamlString(draft.status)}`,
    ...(draft.topicTitle ? [`topic: ${yamlString(draft.topicTitle)}`] : []),
    `created_at: ${yamlString(new Date(draft.createdAt).toISOString())}`,
    `updated_at: ${yamlString(new Date(draft.updatedAt).toISOString())}`,
    "---",
  ];
  const content = draft.content.replace(/^\uFEFF/, "").replace(/\s+$/g, "");
  return `${metadata.join("\n")}\n\n${content}${content ? "\n" : ""}`;
}

export function downloadDraftMarkdown(draft: Draft): void {
  const blob = new Blob([draftToMarkdown(draft)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeFilename(draft.title)}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
