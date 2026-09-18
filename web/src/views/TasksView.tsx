import { useCallback, useEffect, useState } from "react";
import { ListChecks } from "@phosphor-icons/react";
import { api } from "../lib/api";
import { useEvent } from "../lib/sse";
import { fullDate, kindLabel, statusLabel } from "../lib/format";
import type { Task } from "../lib/types";
import { EmptyState, ErrorBanner, SkeletonList, Tag } from "../components/ui";
import TaskLiveModal from "../components/TaskLiveModal";

function statusColor(status: Task["status"]): string {
  switch (status) {
    case "done":
      return "green";
    case "error":
      return "red";
    case "running":
      return "ink";
    default:
      return "gray";
  }
}

export default function TasksView() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<Task | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setTasks(await api.listTasks());
    } catch (err) {
      setError((err as Error).message);
      setTasks([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 任务生命周期变化时刷新列表
  useEvent("task_queued", () => void load());
  useEvent("task_done", () => void load());
  useEvent("task_error", () => void load());

  return (
    <div className="fade-in">
      <div className="toolbar">
        <span className="topbar__hint">
          在「信息流」勾选素材后即可发起 AI 任务，这里记录所有历史。
        </span>
      </div>

      {error && <ErrorBanner message={error} />}

      {tasks === null ? (
        <SkeletonList count={4} />
      ) : tasks.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="还没有任务"
          desc="任务类型：摘要、评估、聚类、找选题。去「信息流」选择素材，一键运行。"
        />
      ) : (
        <div className="tasks">
          {tasks.map((task) => (
            <div className="task" key={task.id} onClick={() => setActiveTask(task)}>
              <Tag color={statusColor(task.status)}>{kindLabel(task.kind)}</Tag>
              <div className="task__main">
                <div className="task__title">
                  {task.kind === "ideate" && Array.isArray(task.input?.itemIds)
                    ? `基于 ${task.input.itemIds.length} 条素材的选题策划`
                    : task.kind === "summarize"
                      ? "信息摘要"
                      : task.kind === "evaluate"
                        ? "价值评估"
                        : "主题聚类"}
                </div>
                <div className="task__meta">
                  {statusLabel(task.status)} · {fullDate(task.createdAt)}
                  {Array.isArray(task.input?.itemIds) && ` · ${task.input.itemIds.length} 条素材`}
                </div>
              </div>
              <Tag color="gray">查看</Tag>
            </div>
          ))}
        </div>
      )}

      {activeTask && <TaskLiveModal task={activeTask} onClose={() => setActiveTask(null)} />}
    </div>
  );
}
