import { EventEmitter } from "node:events";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { getItemsByIds, insertTask, insertTopic, updateTask, type Task } from "./db.js";
import { PROMPTS } from "./prompts.js";

/** 向 SSE 广播任务生命周期事件 */
export const agentEvents = new EventEmitter();

interface Runtime {
  modelRuntime: ModelRuntime;
  loader: DefaultResourceLoader;
}

let runtimePromise: Promise<Runtime> | null = null;
let agentReady = false;
let agentError: string | null = null;

export function isAgentReady(): boolean {
  return agentReady;
}
export function getAgentError(): string | null {
  return agentError;
}

const SYSTEM_PROMPT = [
  "你是一名内容策展与选题专家，服务于一位内容创作者。",
  "你的任务：分析信息、提炼观点、判断价值，并产出可执行的高质量写作选题（X 推文或长文）。",
  "你总是严格按要求输出 JSON，内容具体、可执行，避免空话套话。",
  "只基于给出的材料作答，不要编造。",
].join(" ");

/** 懒加载 Pi 运行时（ModelRuntime 创建较慢，只在第一次跑任务时初始化） */
function getRuntime(): Promise<Runtime> {
  if (!runtimePromise) {
    console.log("[agent] 初始化 Pi 运行时…");
    runtimePromise = (async () => {
      const modelRuntime = await ModelRuntime.create();
      const loader = new DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir: getAgentDir(),
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        systemPromptOverride: () => SYSTEM_PROMPT,
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
}

const queue: Task[] = [];
let running = false;

/** 提交一个 AI 任务，进入队列串行执行 */
export function enqueueTask(kind: string, input: TaskInput): Task {
  const task = insertTask(kind, input);
  queue.push(task);
  agentEvents.emit("task_queued", { task });
  void processQueue();
  return task;
}

async function processQueue(): Promise<void> {
  if (running) return;
  running = true;
  while (queue.length > 0) {
    const task = queue.shift()!;
    await runTask(task);
  }
  running = false;
}

async function runTask(task: Task): Promise<void> {
  updateTask(task.id, { status: "running" });
  agentEvents.emit("task_status", { taskId: task.id, status: "running", kind: task.kind });

  try {
    const runtime = await getRuntime();
    const prompt = buildPrompt(task);
    const thinkingLevel = process.env.WORKBENCH_THINKING || "medium";

    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      modelRuntime: runtime.modelRuntime,
      resourceLoader: runtime.loader,
      noTools: "all",
      thinkingLevel: thinkingLevel as any,
    });

    let text = "";
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update") {
        const e = event.assistantMessageEvent;
        if (e.type === "text_delta") {
          text += e.delta;
          agentEvents.emit("task_delta", { taskId: task.id, delta: e.delta });
        } else if (e.type === "thinking_delta") {
          agentEvents.emit("task_thinking", { taskId: task.id, delta: e.delta });
        }
      }
    });

    try {
      await session.prompt(prompt);
    } finally {
      unsubscribe();
      session.dispose();
    }

    const output = parseJsonOutput(text);
    updateTask(task.id, { status: "done", output, finishedAt: Date.now() });
    agentEvents.emit("task_done", { taskId: task.id, kind: task.kind, output });
    applySideEffects(task, output);
  } catch (err) {
    const message = String((err as Error).message || err);
    updateTask(task.id, { status: "error", error: message, finishedAt: Date.now() });
    agentEvents.emit("task_error", { taskId: task.id, kind: task.kind, error: message });
  }
}

function buildPrompt(task: Task): string {
  const fn = PROMPTS[task.kind];
  if (!fn) throw new Error(`未知任务类型：${task.kind}`);
  const input = (task.input || {}) as TaskInput;
  const items = getItemsByIds(input.itemIds || []);
  if (items.length === 0) throw new Error("没有可用的素材条目");
  return fn({ items, extra: input.extra });
}

/** 从模型回复中提取 JSON（容错：截取第一个 { 到最后一个 }） */
export function parseJsonOutput(text: string): { raw: string; parsed: any } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return { raw: text, parsed: null };
  }
  const candidate = text.slice(start, end + 1);
  try {
    return { raw: text, parsed: JSON.parse(candidate) };
  } catch {
    return { raw: text, parsed: null };
  }
}

/** 任务完成后的落库副作用 */
function applySideEffects(task: Task, output: { raw: string; parsed: any }): void {
  const parsed = output.parsed;
  if (!parsed) return;

  if (task.kind === "ideate" && Array.isArray(parsed.topics)) {
    const input = (task.input || {}) as TaskInput;
    const sourceItemIds = input.itemIds || [];
    for (const t of parsed.topics) {
      if (!t || typeof t.title !== "string") continue;
      insertTopic({
        title: t.title,
        type: t.type === "article" ? "article" : "tweet",
        angle: typeof t.angle === "string" ? t.angle : null,
        materials: Array.isArray(t.materials) ? t.materials.map(String) : [],
        differentiation: typeof t.differentiation === "string" ? t.differentiation : null,
        language: typeof t.language === "string" ? t.language : null,
        sourceItemIds,
      });
    }
    agentEvents.emit("topics_created", { taskId: task.id });
  }
}
