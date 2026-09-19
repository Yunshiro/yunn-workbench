import { useCallback, useEffect, useState } from "react";
import { ListChecks, Trash } from "@phosphor-icons/react";
import { api } from "../lib/api";
import { useEvent } from "../lib/sse";
import { fullDate, kindLabel, statusLabel } from "../lib/format";
import type { Task } from "../lib/types";
import { Checkbox, EmptyState, ErrorBanner, SkeletonList, Spinner, Tag } from "../components/ui";
import TaskLiveModal from "../components/TaskLiveModal";
import ResearchWorkspace from "../components/ResearchWorkspace";

function statusColor(status: Task["status"]): string {
  switch (status) {
    case "done":
    case "completed":
      return "green";
    case "awaiting_feedback":
      return "blue";
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const nextTasks = await api.listTasks();
      setTasks(nextTasks);
      const availableIds = new Set(nextTasks.map((task) => task.id));
      setSelectedIds((current) => new Set([...current].filter((id) => availableIds.has(id))));
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
  useEvent("tasks_deleted", (data) => {
    void load();
    if (activeTask && Array.isArray(data?.taskIds) && data.taskIds.includes(activeTask.id)) setActiveTask(null);
  });

  function setSelected(id: string, checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function setAllSelected(checked: boolean) {
    setSelectedIds(checked && tasks ? new Set(tasks.map((task) => task.id)) : new Set());
  }

  async function removeTasks(ids: string[]) {
    if (ids.length === 0 || deleting) return;
    const targets = (tasks ?? []).filter((task) => ids.includes(task.id));
    const activeCount = targets.filter((task) => ["queued", "running"].includes(task.status)).length;
    const message = ids.length === 1
      ? `删除这个任务及其运行记录？${activeCount ? "任务仍在运行，将先停止任务。" : "此操作无法撤销。"}`
      : `删除选中的 ${ids.length} 个任务及其运行记录？${activeCount ? `其中 ${activeCount} 个任务仍在运行，将先停止。` : "此操作无法撤销。"}`;
    if (!window.confirm(message)) return;
    setDeleting(true);
    setError(null);
    try {
      const result = await api.deleteTasks(ids);
      const deleted = new Set(result.deletedIds);
      setTasks((current) => current?.filter((task) => !deleted.has(task.id)) ?? null);
      setSelectedIds((current) => new Set([...current].filter((id) => !deleted.has(id))));
      if (activeTask && deleted.has(activeTask.id)) setActiveTask(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  const allSelected = !!tasks?.length && tasks.every((task) => selectedIds.has(task.id));

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
        <>
          <div className="tasks-toolbar">
            <Checkbox checked={allSelected} onChange={setAllSelected} label="全选任务" disabled={deleting} />
            <span>{selectedIds.size > 0 ? `已选择 ${selectedIds.size} 项` : `共 ${tasks.length} 个任务`}</span>
            <div className="toolbar__spacer" />
            {selectedIds.size > 0 && (
              <button className="btn btn--danger" type="button" disabled={deleting} onClick={() => void removeTasks([...selectedIds])}>
                {deleting ? <Spinner size={14} /> : <Trash size={15} />}删除选中
              </button>
            )}
          </div>
          <div className="tasks">
            {tasks.map((task) => (
              <article className={`task${selectedIds.has(task.id) ? " task--selected" : ""}`} key={task.id}>
                <Checkbox checked={selectedIds.has(task.id)} onChange={(checked) => setSelected(task.id, checked)} label={`选择${kindLabel(task.kind)}任务`} disabled={deleting} />
                <button type="button" className="task__open" onClick={() => setActiveTask(task)}>
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
                </button>
                <button className="btn btn--icon btn--danger task__delete" type="button" aria-label="删除任务" title="删除任务" disabled={deleting} onClick={() => void removeTasks([task.id])}>
                  <Trash size={15} />
                </button>
              </article>
            ))}
          </div>
        </>
      )}

      {activeTask && activeTask.kind === "ideate" ? (
        <ResearchWorkspace initialTask={activeTask} onClose={() => setActiveTask(null)} onTopicsCreated={load} />
      ) : activeTask ? (
        <TaskLiveModal task={activeTask} onClose={() => setActiveTask(null)} />
      ) : null}
    </div>
  );
}
