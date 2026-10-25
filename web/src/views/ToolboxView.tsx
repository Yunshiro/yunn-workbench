import { ArrowRight, Toolbox } from "@phosphor-icons/react";
import { EmptyState } from "../components/ui";
import { TOOLBOX_TOOLS, findToolboxTool } from "../lib/toolbox";
import TextCardsView from "./TextCardsView";

export default function ToolboxView({ onOpen }: { onOpen: (toolId: string) => void }) {
  return (
    <div className="fade-in toolbox">
      <p className="toolbox__lead">本地小工具。字卡的文案和配色只留在这台浏览器里。</p>
      {TOOLBOX_TOOLS.length === 0 ? (
        <EmptyState icon={Toolbox} title="还没有工具" desc="新工具加在工具列表配置里就会出现在这里。" />
      ) : (
        <div className="toolbox__grid">
          {TOOLBOX_TOOLS.map((tool) => (
            <button
              key={tool.id}
              className="toolbox-card"
              type="button"
              data-tool-id={tool.id}
              onClick={() => onOpen(tool.id)}
            >
              <span className="toolbox-card__mark" aria-hidden="true">{tool.mark}</span>
              <span className="toolbox-card__body">
                <span className="toolbox-card__name">{tool.name}</span>
                <span className="toolbox-card__desc">{tool.description}</span>
              </span>
              <span className="toolbox-card__go">
                打开
                <ArrowRight size={14} />
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ToolboxMissing({ onBack }: { onBack: () => void }) {
  return (
    <div className="fade-in toolbox">
      <EmptyState
        icon={Toolbox}
        title="没有这个工具"
        desc="它不在当前工具列表里。"
        action={<button className="btn btn--ghost" type="button" onClick={onBack}>返回列表</button>}
      />
    </div>
  );
}

export function ToolboxScreen({
  toolId,
  onOpen,
  onBack,
}: {
  toolId: string | null;
  onOpen: (toolId: string) => void;
  onBack: () => void;
}) {
  if (!toolId) return <ToolboxView onOpen={onOpen} />;
  const tool = findToolboxTool(toolId);
  if (tool?.id === "text-cards") return <TextCardsView onBack={onBack} />;
  return <ToolboxMissing onBack={onBack} />;
}
