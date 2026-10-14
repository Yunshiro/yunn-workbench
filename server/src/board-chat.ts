import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { getAgentAuthConfig, prepareActiveModel } from "./agent-auth.js";
import { boardEvents } from "./board-events.js";
import { collectBoardContext, type BoardContext } from "./board-context.js";
import { BoardError } from "./board-error.js";
import {
  deleteBoardSession,
  getBoard,
  getBoardMessage,
  getBoardSession,
  hasRunningBoardMessage,
  insertBoardMessage,
  insertBoardSession,
  listBoardMessages,
  listBoardSessions,
  updateBoardMessage,
  updateBoardSession,
  type BoardMessage,
  type BoardSession,
} from "./boards-db.js";
import { BOARD_SESSIONS_DIR, PI_AUTH_PATH, WORKBENCH_HOME } from "./config.js";
import { selectCitations } from "./knowledge-index.js";

export type BoardAnswerRunner = (input: { prompt: string; question: string; cardIds: string[] }) => string | Promise<string>;

let answerRunnerForTests: BoardAnswerRunner | null = null;

/** 测试里代替 Pi 会话。传入 null 恢复真实模型。 */
export function setBoardAnswerRunnerForTests(runner: BoardAnswerRunner | null): void {
  answerRunnerForTests = runner;
}

const BOARD_SYSTEM_PROMPT = `你是 Yunn Workbench 的画板助手。只根据本次提供的卡片内容分析素材，并可以据此起草文案。
规则：
1. 只使用卡片里的信息，不要编造卡片中没有的内容。
2. 如果卡片不足以回答，直接说明。
3. 默认用简体中文回答。
4. 引用卡片时使用对应编号，例如 [1]、[2]。编号必须来自本次卡片。
5. 起草文案时也要标出依据了哪几张卡片。`;

let runtimePromise: Promise<ModelRuntime> | null = null;
let loaderPromise: Promise<DefaultResourceLoader> | null = null;

function chatCwd(): string {
  const cwd = join(WORKBENCH_HOME, "board-chat-cwd");
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

function getRuntime(): Promise<ModelRuntime> {
  if (!runtimePromise) {
    runtimePromise = ModelRuntime.create({ authPath: PI_AUTH_PATH });
    runtimePromise.catch(() => { runtimePromise = null; });
  }
  return runtimePromise;
}

function getLoader(): Promise<DefaultResourceLoader> {
  if (!loaderPromise) {
    loaderPromise = (async () => {
      const loader = new DefaultResourceLoader({
        cwd: chatCwd(),
        agentDir: getAgentDir(),
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        systemPromptOverride: () => BOARD_SYSTEM_PROMPT,
      });
      await loader.reload();
      return loader;
    })();
    loaderPromise.catch(() => { loaderPromise = null; });
  }
  return loaderPromise;
}

async function resolveContextWindow(): Promise<number> {
  const runtime = await getRuntime();
  const model = await prepareActiveModel(runtime);
  if (!model) throw new BoardError("请先在 Agent 设置中启用一个可用的模型");
  const contextWindow = (model as { contextWindow?: number }).contextWindow;
  if (typeof contextWindow === "number" && contextWindow > 0) return contextWindow;
  return 8192;
}

export function listSessions(boardId: string): BoardSession[] {
  if (!getBoard(boardId)) throw new BoardError("画板不存在", 404);
  return listBoardSessions(boardId);
}

export function createSession(boardId: string): BoardSession {
  if (!getBoard(boardId)) throw new BoardError("画板不存在", 404);
  return insertBoardSession(boardId);
}

export function removeSession(boardId: string, sessionId: string): void {
  const session = getBoardSession(sessionId);
  if (!session || session.boardId !== boardId) throw new BoardError("会话不存在", 404);
  deleteBoardSession(sessionId);
}

export function listMessages(boardId: string, sessionId: string): BoardMessage[] {
  const session = getBoardSession(sessionId);
  if (!session || session.boardId !== boardId) throw new BoardError("会话不存在", 404);
  return listBoardMessages(sessionId);
}

export async function askBoard(boardId: string, sessionId: string, content: string, cardIds?: string[]): Promise<{ user: BoardMessage; assistant: BoardMessage }> {
  const question = content.trim();
  if (!question) throw new BoardError("请输入问题");
  if (question.length > 4000) throw new BoardError("单条问题不能超过 4000 字");
  const session = getBoardSession(sessionId);
  if (!session || session.boardId !== boardId) throw new BoardError("会话不存在", 404);
  if (!answerRunnerForTests && !getAgentAuthConfig().configured) throw new BoardError("请先在 Agent 设置中启用一个可用的模型");
  if (hasRunningBoardMessage(sessionId)) throw new BoardError("上一个回答还在生成", 409);

  const contextWindow = await resolveContextWindow();
  const prepared = collectBoardContext(boardId, cardIds, contextWindow);
  const ids = prepared.cards.map((card) => card.id);
  const user = insertBoardMessage({ sessionId, role: "user", content: question, cardIds: ids, status: "done" });
  const assistant = insertBoardMessage({
    sessionId,
    role: "assistant",
    content: "",
    citations: prepared.citations,
    cardIds: ids,
    status: "running",
  });
  if (session.title === "新的对话") updateBoardSession(sessionId, { title: question.slice(0, 40) });
  boardEvents.emit("board_message", { sessionId, message: user });
  boardEvents.emit("board_message", { sessionId, message: assistant });
  void completeAnswer(sessionId, assistant.id, question, prepared).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    const saved = updateBoardMessage(assistant.id, { status: "error", error: message });
    if (saved) boardEvents.emit("board_message", { sessionId, message: saved });
    console.error(`[board] 回答失败 ${sessionId}：${message.slice(0, 200)}`);
  });
  return { user, assistant };
}

async function finishAnswer(sessionId: string, messageId: string, prepared: BoardContext, answer: string): Promise<void> {
  const text = answer.trim();
  if (!text) throw new Error("模型没有返回内容");
  const shown = selectCitations(text, prepared.citations);
  const saved = updateBoardMessage(messageId, { content: text, citations: shown, status: "done", error: null });
  if (saved) boardEvents.emit("board_message", { sessionId, message: saved });
}

async function completeAnswer(sessionId: string, messageId: string, question: string, prepared: BoardContext): Promise<void> {
  if (answerRunnerForTests) {
    try {
      const answer = await answerRunnerForTests({
        prompt: prepared.prompt,
        question,
        cardIds: prepared.cards.map((card) => card.id),
      });
      await finishAnswer(sessionId, messageId, prepared, answer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const saved = updateBoardMessage(messageId, { status: "error", error: message });
      if (saved) boardEvents.emit("board_message", { sessionId, message: saved });
    }
    return;
  }
  const session = getBoardSession(sessionId);
  if (!session) return;
  let sessionHandle: AgentSession | null = null;
  try {
    const runtime = await getRuntime();
    const model = await prepareActiveModel(runtime);
    if (!model) throw new BoardError("请先在 Agent 设置中启用一个可用的模型");
    const loader = await getLoader();
    mkdirSync(BOARD_SESSIONS_DIR, { recursive: true });
    const cwd = chatCwd();
    const sessionManager = session.piSessionPath && existsSync(session.piSessionPath)
      ? SessionManager.open(session.piSessionPath, BOARD_SESSIONS_DIR, cwd)
      : SessionManager.create(cwd, BOARD_SESSIONS_DIR, { id: sessionId });
    updateBoardSession(sessionId, {
      piSessionId: sessionManager.getSessionId(),
      piSessionPath: sessionManager.getSessionFile() ?? session.piSessionPath,
    });
    const created = await createAgentSession({
      cwd,
      sessionManager,
      modelRuntime: runtime,
      model,
      resourceLoader: loader,
      noTools: "all",
      thinkingLevel: "off",
    });
    sessionHandle = created.session;
    let latest = "";
    let lastWrite = 0;
    const unsubscribe = sessionHandle.subscribe((event) => {
      if (event.type !== "message_update") return;
      const update = event.assistantMessageEvent;
      if (update.type !== "text_delta") return;
      latest += update.delta;
      boardEvents.emit("board_message_delta", { sessionId, messageId, delta: update.delta });
      const now = Date.now();
      if (now - lastWrite > 400) {
        lastWrite = now;
        updateBoardMessage(messageId, { content: latest });
      }
    });
    try {
      await sessionHandle.prompt(`${prepared.prompt}\n\n问题：\n${question}`);
    } finally {
      unsubscribe();
    }
    await finishAnswer(sessionId, messageId, prepared, latest);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = getBoardMessage(messageId);
    const saved = updateBoardMessage(messageId, {
      content: current?.content || "",
      citations: current?.citations?.length ? current.citations : prepared.citations,
      status: "error",
      error: message,
    });
    if (saved) boardEvents.emit("board_message", { sessionId, message: saved });
    console.error(`[board] 回答失败 ${sessionId}：${message.slice(0, 200)}`);
  } finally {
    sessionHandle?.dispose();
  }
}
