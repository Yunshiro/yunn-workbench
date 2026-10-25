import { useCallback, useEffect, useState } from "react";
import {
  BookOpen,
  Lightbulb,
  ListChecks,
  Newspaper,
  NotePencil,
  Rss,
  SlidersHorizontal,
  SquaresFour,
  Toolbox,
} from "@phosphor-icons/react";
import { api } from "./lib/api";
import { parsePath, pathFor, type AppRoute, type AppView } from "./lib/route";
import { useEvent } from "./lib/sse";
import { findToolboxTool } from "./lib/toolbox";
import { StatusDot } from "./components/ui";
import ItemsView from "./views/ItemsView";
import FeedsView from "./views/FeedsView";
import TopicsView from "./views/TopicsView";
import TasksView from "./views/TasksView";
import SettingsView from "./views/SettingsView";
import DraftsView from "./views/DraftsView";
import BoardsView from "./views/BoardsView";
import BooksView from "./views/BooksView";
import { ToolboxScreen } from "./views/ToolboxView";

type View = AppView;

const NAV: { id: View; label: string; icon: typeof Newspaper; badge?: boolean }[] = [
  { id: "items", label: "信息流", icon: Newspaper, badge: true },
  { id: "feeds", label: "订阅源", icon: Rss },
  { id: "topics", label: "选题", icon: Lightbulb },
  { id: "drafts", label: "草稿箱", icon: NotePencil },
  { id: "boards", label: "画板", icon: SquaresFour },
  { id: "books", label: "读书", icon: BookOpen },
  { id: "toolbox", label: "工具箱", icon: Toolbox },
  { id: "tasks", label: "任务", icon: ListChecks },
  { id: "settings", label: "Agent 设置", icon: SlidersHorizontal },
];

const TITLES: Record<View, string> = {
  items: "信息流",
  feeds: "订阅源",
  topics: "选题看板",
  drafts: "推文草稿箱",
  boards: "画板",
  books: "读书",
  toolbox: "工具箱",
  tasks: "AI 任务",
  settings: "Agent 设置",
};

export default function App() {
  const [route, setRoute] = useState<AppRoute>(() => parsePath(window.location.pathname));
  const [unread, setUnread] = useState(0);
  const [agentReady, setAgentReady] = useState<boolean | null>(null);
  const [agentConfigured, setAgentConfigured] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [draftTopicId, setDraftTopicId] = useState<string | null>(null);
  const view = route.view;

  function commitRoute(next: AppRoute) {
    const path = pathFor(next);
    if (window.location.pathname !== path) {
      window.history.pushState(null, "", path);
    }
    setRoute(next);
  }

  function navigate(viewId: View) {
    setDraftTopicId(null);
    commitRoute({ view: viewId, toolId: null });
  }

  function openToolboxTool(toolId: string) {
    setDraftTopicId(null);
    commitRoute({ view: "toolbox", toolId });
  }

  function createDraftForTopic(topicId: string) {
    setDraftTopicId(topicId);
    commitRoute({ view: "drafts", toolId: null });
  }

  useEffect(() => {
    const onPopState = () => {
      setRoute(parsePath(window.location.pathname));
      setDraftTopicId(null);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const refreshAgent = useCallback(async () => {
    try {
      const s = await api.agentStatus();
      setAgentReady(s.ready);
      setAgentConfigured(s.configured);
      setAgentError(s.error);
    } catch {
      /* 忽略：后端不可达时保持原状 */
    }
  }, []);

  useEffect(() => {
    void refreshAgent();
    void api.health().then(() => {}).catch(() => {});
  }, [refreshAgent]);

  // 首次任务触发 Pi 运行时懒加载 → 重新探测就绪状态
  useEvent("task_queued", () => void refreshAgent());
  useEvent("task_done", () => void refreshAgent());
  useEvent("task_error", () => void refreshAgent());

  const agentState: "ok" | "err" | "idle" | "run" =
    agentReady ? "ok" : agentConfigured || agentReady === null ? "idle" : "err";
  const pageTitle = view === "toolbox" && route.toolId
    ? (findToolboxTool(route.toolId)?.name ?? TITLES.toolbox)
    : TITLES[view];
  const workspace = view === "boards" || (view === "toolbox" && findToolboxTool(route.toolId)?.id === "text-cards");

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand__mark" src="/icon.svg" alt="" />
          <div>
            <div className="brand__name">Yunn Workbench</div>
            <div className="brand__sub">AI Content Studio</div>
          </div>
        </div>

        <nav className="nav">
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={`nav__item${view === item.id ? " nav__item--active" : ""}`}
                onClick={() => navigate(item.id)}
              >
                <Icon size={17} weight={view === item.id ? "bold" : "regular"} />
                {item.label}
                {item.badge && unread > 0 && <span className="nav__count">{unread}</span>}
              </button>
            );
          })}
        </nav>

        <div className="sidebar__foot">
          <div className="agent-status">
            <StatusDot state={agentState} />
            {agentReady === null
              ? "Agent 待命"
              : agentReady
                ? "Agent 就绪"
                : agentConfigured
                  ? "Agent 已配置"
                  : "Agent 未配置"}
          </div>
          {agentError && (
            <div
              className="agent-status"
              style={{ color: "var(--red-ink)", fontSize: 11, lineHeight: 1.5 }}
              title={agentError}
            >
              {agentError.length > 40 ? `${agentError.slice(0, 40)}…` : agentError}
            </div>
          )}
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <span className="topbar__title">{pageTitle}</span>
          <div className="toolbar__spacer" />
          {view === "items" && (
            <span className="topbar__hint">勾选条目 → 底部运行 AI 任务（摘要 / 评估 / 聚类 / 找选题）</span>
          )}
          {view === "boards" && (
            <span className="topbar__hint">粘贴链接生成卡片，双击空白处写便签，右侧可以对着卡片提问。</span>
          )}
          {view === "books" && (
            <span className="topbar__hint">导入 epub 后先核对章节，确认后才开始写笔记。</span>
          )}
          {view === "toolbox" && !route.toolId && (
            <span className="topbar__hint">本地小工具，生成结果只保存在这台浏览器。</span>
          )}
          {view === "toolbox" && route.toolId === "text-cards" && (
            <span className="topbar__hint">封面、语录和正文分页可导出为 1080×1440 PNG。</span>
          )}
        </div>
        <div className={`content${workspace ? " content--workspace" : ""}`}>
          {view === "items" && <ItemsView onUnreadChange={setUnread} />}
          {view === "feeds" && <FeedsView />}
          {view === "topics" && <TopicsView onCreateDraft={createDraftForTopic} />}
          {view === "drafts" && <DraftsView createForTopicId={draftTopicId} />}
          {view === "boards" && <BoardsView />}
          {view === "books" && <BooksView />}
          {view === "toolbox" && (
            <ToolboxScreen
              toolId={route.toolId}
              onOpen={openToolboxTool}
              onBack={() => navigate("toolbox")}
            />
          )}
          {view === "tasks" && <TasksView />}
          {view === "settings" && <SettingsView onConfigChanged={refreshAgent} />}
        </div>
      </main>
    </div>
  );
}
