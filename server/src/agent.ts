import { EventEmitter } from "node:events";
import { unlinkSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  deleteTask as deleteTaskRecord, getCreatorContextSnapshot, getItemsByIds, getResearchRevision, getTask,
  insertMemory, insertResearchMessage, insertResearchRevision, insertTask, insertTopic,
  updateResearchMessage, updateTask,
  type CreatorContextSnapshot, type ResearchMessage, type Task, type TaskTrace, type Topic,
} from "./db.js";
import { buildTaskPrompt, getPromptConfig, getPromptInstructions } from "./prompts.js";
import { PI_AUTH_PATH, PI_SESSIONS_DIR } from "./config.js";
import { getAgentAuthConfig, prepareActiveModel } from "./agent-auth.js";
import { createResearchTools, RESEARCH_TOOL_LABELS } from "./research-tools.js";
import { buildJsonRepairPrompt, parseJsonOutput, type ParsedTaskOutput } from "./structured-output.js";

export const agentEvents = new EventEmitter();

interface Runtime { modelRuntime: ModelRuntime; loader: DefaultResourceLoader; }
interface QueueJob { taskId: string; prompt?: string; messageId?: string; }

let runtimePromise: Promise<Runtime> | null = null;
let agentReady = false;
let agentError: string | null = null;

export function isAgentReady(): boolean { return agentReady; }
export function getAgentError(): string | null { return agentError; }
export function isAgentConfigured(): boolean { return getAgentAuthConfig().configured; }

export function resetAgentRuntime(): void {
  runtimePromise = null;
  agentReady = false;
  agentError = null;
}

function getRuntime(): Promise<Runtime> {
  if (!runtimePromise) {
    console.log("[agent] 初始化 Pi 运行时…");
    runtimePromise = (async () => {
      const modelRuntime = await ModelRuntime.create({ authPath: PI_AUTH_PATH });
      const loader = new DefaultResourceLoader({
        cwd: process.cwd(), agentDir: getAgentDir(), noExtensions: true, noSkills: true,
        noContextFiles: true, systemPromptOverride: () => {
          const base = getPromptConfig().system;
          const custom = getPromptInstructions().system;
          return custom ? `${base}\n\n用户自定义要求：\n${custom}` : base;
        },
      });
      await loader.reload();
      agentReady = true;
      agentError = null;
      console.log("[agent] Pi 运行时就绪");
      return { modelRuntime, loader };
    })();
    runtimePromise.catch((err) => {
      agentError = String((err as Error).message || err);
      console.error("[agent] 初始化失败：", agentError);
    });
  }
  return runtimePromise;
}

export interface TaskInput {
  itemIds: string[];
  extra?: string;
  goal?: string;
  role?: "editor" | "growth" | "researcher";
}

const queue: QueueJob[] = [];
let running = false;
const activeSessions = new Map<string, AgentSession>();
const cancelledTasks = new Set<string>();

export function enqueueTask(kind: string, input: TaskInput): Task {
  let task = insertTask(kind, input);
  if (kind === "ideate") {
    updateTask(task.id, { profileSnapshot: getCreatorContextSnapshot(), lastActivityAt: Date.now() });
    task = getTask(task.id)!;
  }
  queue.push({ taskId: task.id });
  agentEvents.emit("task_queued", { task });
  void processQueue();
  return task;
}

async function processQueue(): Promise<void> {
  if (running) return;
  running = true;
  while (queue.length > 0) await runJob(queue.shift()!);
  running = false;
}

async function runJob(job: QueueJob): Promise<void> {
  const task = getTask(job.taskId);
  if (!task || cancelledTasks.has(task.id) || task.status === "completed") return;
  updateTask(task.id, { status: "running", error: null, lastActivityAt: Date.now() });
  agentEvents.emit("task_status", { taskId: task.id, status: "running", kind: task.kind });
  let session: AgentSession | null = null;
  try {
    const runtime = await getRuntime();
    if (cancelledTasks.has(task.id)) return;
    const isResearch = task.kind === "ideate";
    const model = await prepareActiveModel(runtime.modelRuntime);

    const sessionManager = isResearch
      ? task.sessionPath
        ? SessionManager.open(task.sessionPath, PI_SESSIONS_DIR, process.cwd())
        : SessionManager.create(process.cwd(), PI_SESSIONS_DIR, { id: task.id })
      : SessionManager.inMemory();
    const created = await createAgentSession({
      sessionManager, modelRuntime: runtime.modelRuntime, model, resourceLoader: runtime.loader,
      noTools: isResearch ? "builtin" : "all",
      customTools: isResearch ? createResearchTools((task.input as TaskInput).itemIds || []) : undefined,
      thinkingLevel: (process.env.WORKBENCH_THINKING || "medium") as any,
    });
    session = created.session;
    activeSessions.set(task.id, session);
    if (isResearch) updateTask(task.id, { sessionId: sessionManager.getSessionId(), sessionPath: sessionManager.getSessionFile() ?? task.sessionPath });

    let latestText = "";
    let repairingOutput = false;
    let trace: TaskTrace[] = task.trace || [];
    const unsubscribe = session.subscribe((event) => {
      const rawEvent = event as any;
      if (event.type === "message_start" && rawEvent.message?.role === "assistant") {
        latestText = "";
      } else if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta") {
          latestText += update.delta;
          if (!repairingOutput) agentEvents.emit("task_delta", { taskId: task.id, delta: update.delta });
        } else if (update.type === "thinking_delta") {
          agentEvents.emit("task_thinking", { taskId: task.id, delta: update.delta });
        }
      } else if (event.type === "tool_execution_start") {
        const action: TaskTrace = {
          id: event.toolCallId, tool: event.toolName,
          label: RESEARCH_TOOL_LABELS[event.toolName] || event.toolName,
          status: "running", input: event.args && typeof event.args === "object" ? event.args : {},
          summary: null, startedAt: Date.now(), finishedAt: null,
        };
        trace = [...trace, action];
        updateTask(task.id, { trace, lastActivityAt: Date.now() });
        agentEvents.emit("task_trace", { taskId: task.id, trace });
      } else if (event.type === "tool_execution_end") {
        const details = event.result?.details as { summary?: string } | undefined;
        trace = trace.map((action) => action.id === event.toolCallId ? {
          ...action, status: event.isError ? "error" as const : "done" as const,
          summary: details?.summary || (event.isError ? "工具执行失败" : "工具执行完成"), finishedAt: Date.now(),
        } : action);
        updateTask(task.id, { trace, lastActivityAt: Date.now() });
        agentEvents.emit("task_trace", { taskId: task.id, trace });
      }
    });

    let output: ParsedTaskOutput = { raw: "", parsed: null, parseError: "模型尚未返回结果" };
    try {
      if (job.messageId) {
        const delivered = updateResearchMessage(job.messageId, "delivered");
        if (delivered) agentEvents.emit("research_message", { taskId: task.id, message: delivered });
      }
      await session.prompt(job.prompt ?? buildPrompt(task));
      const firstOutput = parseJsonOutput(latestText, task.kind);
      if (firstOutput.parsed || !firstOutput.parseError) {
        output = firstOutput;
      } else {
        const originalRaw = latestText;
        repairingOutput = true;
        await session.prompt(buildJsonRepairPrompt(task.kind, originalRaw, firstOutput.parseError));
        const repaired = parseJsonOutput(latestText, task.kind);
        output = { ...repaired, repaired: !!repaired.parsed, originalRaw };
      }
    } finally {
      unsubscribe();
    }
    if (cancelledTasks.has(task.id)) return;
    if (isResearch) {
      const revision = output.parsed ? insertResearchRevision(task.id, output) : null;
      const savedOutput = { ...output, revision: revision?.revision ?? null, confirmedIndexes: [] };
      const assistantMessage = insertResearchMessage(task.id, "assistant", revision
        ? `已生成第 ${revision.revision} 版候选选题，共 ${Array.isArray(output.parsed?.topics) ? output.parsed.topics.length : 0} 个。`
        : "本轮已结束，但没有生成可解析的候选选题。", null, "delivered");
      agentEvents.emit("research_message", { taskId: task.id, message: assistantMessage });
      updateTask(task.id, {
        status: "awaiting_feedback", output: savedOutput,
        sessionId: sessionManager.getSessionId(), sessionPath: sessionManager.getSessionFile() ?? task.sessionPath,
        lastActivityAt: Date.now(),
      });
      agentEvents.emit("research_revision", { taskId: task.id, revision });
      agentEvents.emit("task_done", { taskId: task.id, kind: task.kind, status: "awaiting_feedback", output: savedOutput });
    } else {
      updateTask(task.id, { status: "done", output, finishedAt: Date.now() });
      agentEvents.emit("task_done", { taskId: task.id, kind: task.kind, status: "done", output });
    }
  } catch (err) {
    if (job.messageId) updateResearchMessage(job.messageId, "failed");
    if (cancelledTasks.has(task.id)) return;
    const message = String((err as Error).message || err);
    updateTask(task.id, { status: "error", error: message, finishedAt: Date.now(), lastActivityAt: Date.now() });
    agentEvents.emit("task_error", { taskId: task.id, kind: task.kind, error: message });
  } finally {
    activeSessions.delete(task.id);
    session?.dispose();
  }
}

function formatCreatorContext(snapshot: CreatorContextSnapshot | null): string {
  if (!snapshot) return "";
  const { profile, memories } = snapshot;
  const lines = [
    profile.name && `创作者：${profile.name}`,
    profile.domains.length > 0 && `创作领域：${profile.domains.join("、")}`,
    profile.audience && `目标读者：${profile.audience}`,
    profile.goals && `创作目标：${profile.goals}`,
    profile.tone && `表达风格：${profile.tone}`,
    profile.avoidTopics.length > 0 && `避免主题：${profile.avoidTopics.join("、")}`,
    profile.outputPreferences.platforms?.length && `常用平台：${profile.outputPreferences.platforms.join("、")}`,
    profile.outputPreferences.language && `默认语言：${profile.outputPreferences.language}`,
    profile.outputPreferences.length && `篇幅偏好：${profile.outputPreferences.length}`,
  ].filter(Boolean);
  if (memories.length > 0) lines.push(`已确认的长期偏好：\n${memories.map((memory) => `- ${memory.content}`).join("\n")}`);
  return lines.length > 0 ? `\n创作者上下文（必须遵守）：\n${lines.join("\n")}\n` : "";
}

function buildPrompt(task: Task): string {
  const input = (task.input || {}) as TaskInput;
  const items = getItemsByIds(input.itemIds || []);
  if (items.length === 0) throw new Error("没有可用的素材条目");
  const base = buildTaskPrompt(task.kind, { items, extra: input.extra || input.goal });
  if (task.kind !== "ideate") return base;
  const roleNames = { editor: "严谨内容编辑", growth: "增长选题策划", researcher: "深度研究员" };
  return `你正在以「${roleNames[input.role || "editor"]}」身份执行一项自主选题研究任务。
研究目标：${input.goal || "从种子素材中发现值得写、证据充分且不重复的选题"}
${formatCreatorContext(task.profileSnapshot)}
工作要求：
1. 先调用 get_seed_materials 阅读种子素材。
2. 自主提炼关键词，调用 search_materials 扩展本地 RSS 证据，并对有价值的结果调用 read_materials 精读。
3. 在形成最终候选前必须调用 search_existing_topics 检查历史重复；必要时改换角度。
4. 工具可以多次调用。不要只复述种子素材，要体现搜索、比较、验证和去重过程。
5. 最终只输出下方要求的 JSON，不要输出工具过程或 Markdown。

${base}`;
}

export async function sendResearchMessage(taskId: string, content: string, mode: "steer" | "follow_up"): Promise<ResearchMessage> {
  const task = getTask(taskId);
  if (!task || task.kind !== "ideate") throw new Error("研究任务不存在");
  if (["completed", "cancelled"].includes(task.status)) throw new Error("研究任务已结束");
  const message = insertResearchMessage(taskId, "user", content, mode, "queued");
  agentEvents.emit("research_message", { taskId, message });
  const active = activeSessions.get(taskId);
  if (active) {
    if (mode === "steer") await active.steer(content);
    else await active.followUp(content);
    const delivered = updateResearchMessage(message.id, "delivered")!;
    agentEvents.emit("research_message", { taskId, message: delivered });
    return delivered;
  }
  updateTask(taskId, { status: "queued", lastActivityAt: Date.now() });
  queue.push({ taskId, prompt: content, messageId: message.id });
  agentEvents.emit("task_status", { taskId, status: "queued", kind: task.kind });
  void processQueue();
  return message;
}

export function finishResearchTask(taskId: string): Task {
  const task = getTask(taskId);
  if (!task || task.kind !== "ideate") throw new Error("研究任务不存在");
  if (["queued", "running"].includes(task.status)) throw new Error("请先停止当前运行再结束研究");
  updateTask(taskId, { status: "completed", finishedAt: Date.now(), lastActivityAt: Date.now() });
  agentEvents.emit("task_status", { taskId, status: "completed", kind: task.kind });
  return getTask(taskId)!;
}

export async function cancelTask(taskId: string): Promise<boolean> {
  const task = getTask(taskId);
  if (!task || !["queued", "running"].includes(task.status)) return false;
  cancelledTasks.add(taskId);
  for (let index = queue.length - 1; index >= 0; index--) if (queue[index].taskId === taskId) queue.splice(index, 1);
  const session = activeSessions.get(taskId);
  if (session) await session.abort();
  updateTask(taskId, { status: "cancelled", finishedAt: Date.now(), lastActivityAt: Date.now() });
  agentEvents.emit("task_status", { taskId, status: "cancelled", kind: task.kind });
  return true;
}

export async function deleteTasks(taskIds: string[]): Promise<string[]> {
  const deletedIds: string[] = [];
  const sessionsRoot = `${resolve(PI_SESSIONS_DIR)}${sep}`;
  for (const taskId of [...new Set(taskIds)]) {
    const task = getTask(taskId);
    if (!task) continue;
    if (["queued", "running"].includes(task.status)) await cancelTask(taskId);
    if (!deleteTaskRecord(taskId)) continue;
    deletedIds.push(taskId);
    if (task.sessionPath) {
      const sessionPath = resolve(task.sessionPath);
      if (sessionPath.startsWith(sessionsRoot)) {
        try { unlinkSync(sessionPath); }
        catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[agent] 删除任务会话失败：${sessionPath}`, err);
        }
      }
    }
  }
  if (deletedIds.length > 0) agentEvents.emit("tasks_deleted", { taskIds: deletedIds });
  return deletedIds;
}

export function confirmTaskTopics(taskId: string, indexes: number[], revisionNumber?: number): Topic[] {
  const task = getTask(taskId);
  if (!task || task.kind !== "ideate" || !["awaiting_feedback", "completed", "done"].includes(task.status)) throw new Error("研究任务尚未产生候选选题");
  const revision = revisionNumber ? getResearchRevision(taskId, revisionNumber) : undefined;
  const sourceOutput = revision?.output ?? task.output;
  const candidates = sourceOutput?.parsed?.topics;
  if (!Array.isArray(candidates)) throw new Error("任务没有可确认的候选选题");
  const revisionKey = String(revision?.revision ?? task.output?.revision ?? 0);
  const confirmedByRevision = task.output?.confirmedByRevision ?? {};
  const confirmedIndexes = Array.isArray(confirmedByRevision[revisionKey]) ? confirmedByRevision[revisionKey].map(Number) : [];
  const selected = [...new Set(indexes)].filter((index) => Number.isInteger(index) && index >= 0 && index < candidates.length && !confirmedIndexes.includes(index));
  if (selected.length === 0) throw new Error("请选择尚未写入的候选选题");
  const input = (task.input || {}) as TaskInput;
  const topics = selected.map((index) => {
    const candidate = candidates[index];
    if (!candidate || typeof candidate.title !== "string") throw new Error(`第 ${index + 1} 个候选格式无效`);
    return insertTopic({
      title: candidate.title, type: candidate.type === "article" ? "article" : "tweet",
      angle: typeof candidate.angle === "string" ? candidate.angle : null,
      materials: Array.isArray(candidate.materials) ? candidate.materials.map(String) : [],
      differentiation: typeof candidate.differentiation === "string" ? candidate.differentiation : null,
      language: typeof candidate.language === "string" ? candidate.language : null,
      sourceItemIds: input.itemIds || [],
    });
  });
  const nextConfirmed = [...confirmedIndexes, ...selected];
  updateTask(taskId, { output: {
    ...task.output,
    confirmedByRevision: { ...confirmedByRevision, [revisionKey]: nextConfirmed },
    confirmedIndexes: revisionKey === String(task.output?.revision ?? 0) ? nextConfirmed : task.output?.confirmedIndexes ?? [],
  } });
  insertMemory({
    category: "topic_preference", content: `用户选择了选题方向：${topics.map((topic) => topic.title).join("；")}`,
    status: "candidate", sourceType: "topic_confirmation", sourceId: taskId, confidence: 0.8,
  });
  agentEvents.emit("topics_created", { taskId, topicIds: topics.map((topic) => topic.id) });
  agentEvents.emit("profile_memory_candidate", { taskId });
  return topics;
}
