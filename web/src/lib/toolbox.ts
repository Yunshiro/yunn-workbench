export interface ToolboxTool {
  id: string;
  name: string;
  description: string;
  mark: string;
}

/** 工具箱列表。后续加工具时只加这一项，并在工具页挂上对应视图。 */
export const TOOLBOX_TOOLS: ToolboxTool[] = [
  {
    id: "text-cards",
    name: "字卡",
    description: "把文字排成 3:4 小红书卡片，按封面、语录和正文分页，导出 1080×1440 PNG。",
    mark: "字",
  },
];

export function findToolboxTool(id: string | null): ToolboxTool | null {
  if (!id) return null;
  return TOOLBOX_TOOLS.find((tool) => tool.id === id) ?? null;
}
