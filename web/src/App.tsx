import { useCallback, useEffect, useState } from "react";
import {
  Lightbulb,
  ListChecks,
  Newspaper,
  Rss,
} from "@phosphor-icons/react";
import { api } from "./lib/api";
import { useEvent } from "./lib/sse";
import { StatusDot } from "./components/ui";
import ItemsView from "./views/ItemsView";
import FeedsView from "./views/FeedsView";
import TopicsView from "./views/TopicsView";
import TasksView from "./views/TasksView";

type View = "items" | "feeds" | "topics" | "tasks";

const NAV: { id: View; label: string; icon: typeof Newspaper; badge?: boolean }[] = [
  { id: "items", label: "信息流", icon: Newspaper, badge: true },
  { id: "feeds", label: "订阅源", icon: Rss },
  { id: "topics", label: "选题", icon: Lightbulb },
  { id: "tasks", label: "任务", icon: ListChecks },
];

const TITLES: Record<View, string> = {
  items: "信息流",
  feeds: "订阅源",
  topics: "选题看板",
  tasks: "AI 任务",
};

export default function App() {
  const [view, setView] = useState<View>("items");
  const [unread, setUnread] = useState(0);
  const [agentReady, setAgentReady] = useState<boolean | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);

  const refreshAgent = useCallback(async () => {
    try {
      const s = await api.agentStatus();
      setAgentReady(s.ready);
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
    agentReady === null ? "idle" : agentReady ? "ok" : "err";

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand__mark">讯</div>
          <div>
            <div className="brand__name">信息工作台</div>
            <div className="brand__sub">Workbench</div>
          </div>
        </div>

        <nav className="nav">
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={`nav__item${view === item.id ? " nav__item--active" : ""}`}
                onClick={() => setView(item.id)}
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
                : "Agent 未就绪"}
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
          <span className="topbar__title">{TITLES[view]}</span>
          <div className="toolbar__spacer" />
          {view === "items" && (
            <span className="topbar__hint">勾选条目 → 底部运行 AI 任务（摘要 / 评估 / 聚类 / 找选题）</span>
          )}
        </div>
        <div className="content">
          {view === "items" && <ItemsView onUnreadChange={setUnread} />}
          {view === "feeds" && <FeedsView />}
          {view === "topics" && <TopicsView />}
          {view === "tasks" && <TasksView />}
        </div>
      </main>
    </div>
  );
}
