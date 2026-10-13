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
import { KB_SESSIONS_DIR, PI_AUTH_PATH, WORKBENCH_HOME } from "./config.js";
import {
  getKnowledgeBase,
  getKnowledgeMessage,
  getKnowledgeSession,
  hasRunningKnowledgeMessage,
  insertKnowledgeMessage,
  insertKnowledgeSession,
  listKnowledgeMessages,
  listKnowledgeSessions,
  deleteKnowledgeSession,
  searchKnowledgeChunks,
  updateKnowledgeMessage,
  updateKnowledgeSession,
  type KbCitation,
  type KbMessage,
  type KbSearchHit,
  type KbSession,
} from "./knowledge-db.js";
import { knowledgeEvents } from "./knowledge-events.js";
import { KnowledgeError } from "./knowledge-error.js";
import { excerpt, selectCitations } from "./knowledge-index.js";

const KB_SYSTEM_PROMPT = `你是 Yunn Workbench 的知识库助手。只根据本次提供的 Markdown 摘录回答问题。
规则：
1. 只使用摘录里的信息，不要编造仓库中没有的内容。
2. 如果摘录不足以回答，直接说明知识库里没有找到足够依据。
3. 默认用简体中文回答。
4. 引用摘录时使用对应编号，例如 [1]、[2]。编号必须来自本次摘录。
5. 知识库是只读的。不要建议修改、提交或推送仓库。`;

let runtimePromise: Promise<ModelRuntime> | null = null;
let loaderPromise: Promise<DefaultResourceLoader> | null = null;

function chatCwd(): string {
  const cwd = join(WORKBENCH_HOME, "kb-chat-cwd");
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
        systemPromptOverride: () => KB_SYSTEM_PROMPT,
      });
      await loader.reload();
      return loader;
    })();
    loaderPromise.catch(() => { loaderPromise = null; });
  }
  return loaderPromise;
}

export function listSessions(kbId: string): KbSession[] {
  if (!getKnowledgeBase(kbId)) throw new KnowledgeError("知识库不存在", 404);
  return listKnowledgeSessions(kbId);
}

export function createSession(kbId: string): KbSession {
  if (!getKnowledgeBase(kbId)) throw new KnowledgeError("知识库不存在", 404);
  return insertKnowledgeSession(kbId);
}

export function removeSession(kbId: string, sessionId: string): void {
  const session = getKnowledgeSession(sessionId);
  if (!session || session.kbId !== kbId) throw new KnowledgeError("会话不存在", 404);
  deleteKnowledgeSession(sessionId);
}

export function listMessages(kbId: string, sessionId: string): KbMessage[] {
  const session = getKnowledgeSession(sessionId);
  if (!session || session.kbId !== kbId) throw new KnowledgeError("会话不存在", 404);
  return listKnowledgeMessages(sessionId);
}

function citationsFromHits(hits: KbSearchHit[]): KbCitation[] {
  return hits.map((hit, index) => ({
    index: index + 1,
    path: hit.path,
    title: hit.title,
    heading: hit.heading,
    excerpt: excerpt(hit.content),
    documentId: hit.documentId,
  }));
}

function buildPrompt(question: string, citations: KbCitation[], hits: KbSearchHit[]): string {
  const excerpts = hits.map((hit, index) => `[${index + 1}] 路径：${hit.path}\n标题：${citations[index]?.title || hit.title}\n章节：${hit.heading || "（无）"}\n---\n${hit.content}`);
  return `以下是从知识库检索到的 Markdown 摘录。回答时用方括号编号引用。\n\n${excerpts.join("\n\n")}\n\n问题：\n${question}`;
}

export function askKnowledge(kbId: string, sessionId: string, content: string): { user: KbMessage; assistant: KbMessage } {
  const question = content.trim();
  if (!question) throw new KnowledgeError("请输入问题");
  if (question.length > 4000) throw new KnowledgeError("单条问题不能超过 4000 字");
  const session = getKnowledgeSession(sessionId);
  if (!session || session.kbId !== kbId) throw new KnowledgeError("会话不存在", 404);
  const knowledgeBase = getKnowledgeBase(kbId);
  if (!knowledgeBase) throw new KnowledgeError("知识库不存在", 404);
  if (knowledgeBase.chunkCount === 0) {
    throw new KnowledgeError(knowledgeBase.status === "error"
      ? (knowledgeBase.lastError || "知识库同步失败")
      : "知识库还在同步，请稍后再提问");
  }
  if (!getAgentAuthConfig().configured) throw new KnowledgeError("请先在 Agent 设置中启用一个可用的模型");
  if (hasRunningKnowledgeMessage(sessionId)) throw new KnowledgeError("上一个回答还在生成", 409);

  const user = insertKnowledgeMessage({ sessionId, role: "user", content: question, status: "done" });
  const assistant = insertKnowledgeMessage({ sessionId, role: "assistant", content: "", status: "running" });
  if (session.title === "新的对话") updateKnowledgeSession(sessionId, { title: question.slice(0, 40) });
  knowledgeEvents.emit("kb_message", { sessionId, message: user });
  knowledgeEvents.emit("kb_message", { sessionId, message: assistant });
  void completeAnswer(sessionId, assistant.id, question).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    const saved = updateKnowledgeMessage(assistant.id, { status: "error", error: message });
    if (saved) knowledgeEvents.emit("kb_message", { sessionId, message: saved });
    console.error(`[kb] 回答失败 ${sessionId}：${message.slice(0, 200)}`);
  });
  return { user, assistant };
}

async function completeAnswer(sessionId: string, messageId: string, question: string): Promise<void> {
  const session = getKnowledgeSession(sessionId);
  if (!session) return;
  const hits = searchKnowledgeChunks(session.kbId, question, 8);
  const citations = citationsFromHits(hits);
  let sessionHandle: AgentSession | null = null;
  try {
    if (hits.length === 0) {
      const saved = updateKnowledgeMessage(messageId, {
        content: "知识库里没有检索到相关的 Markdown 片段。可以换个问法，或先同步仓库。",
        citations: [],
        status: "done",
        error: null,
      });
      if (saved) knowledgeEvents.emit("kb_message", { sessionId, message: saved });
      return;
    }
    const withSources = updateKnowledgeMessage(messageId, { citations });
    if (withSources) knowledgeEvents.emit("kb_message", { sessionId, message: withSources });

    const runtime = await getRuntime();
    const model = await prepareActiveModel(runtime);
    if (!model) throw new KnowledgeError("请先在 Agent 设置中启用一个可用的模型");
    const loader = await getLoader();
    mkdirSync(KB_SESSIONS_DIR, { recursive: true });
    const cwd = chatCwd();
    const sessionManager = session.piSessionPath && existsSync(session.piSessionPath)
      ? SessionManager.open(session.piSessionPath, KB_SESSIONS_DIR, cwd)
      : SessionManager.create(cwd, KB_SESSIONS_DIR, { id: sessionId });
    updateKnowledgeSession(sessionId, {
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
      knowledgeEvents.emit("kb_message_delta", { sessionId, messageId, delta: update.delta });
      const now = Date.now();
      if (now - lastWrite > 400) {
        lastWrite = now;
        updateKnowledgeMessage(messageId, { content: latest });
      }
    });
    try {
      await sessionHandle.prompt(buildPrompt(question, citations, hits));
    } finally {
      unsubscribe();
    }
    const answer = latest.trim();
    if (!answer) throw new Error("模型没有返回内容");
    const shown = selectCitations(answer, citations);
    const saved = updateKnowledgeMessage(messageId, { content: answer, citations: shown, status: "done", error: null });
    if (saved) knowledgeEvents.emit("kb_message", { sessionId, message: saved });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = getKnowledgeMessage(messageId);
    const saved = updateKnowledgeMessage(messageId, {
      content: current?.content || "",
      citations: current?.citations?.length ? current.citations : citations,
      status: "error",
      error: message,
    });
    if (saved) knowledgeEvents.emit("kb_message", { sessionId, message: saved });
    console.error(`[kb] 回答失败 ${sessionId}：${message.slice(0, 200)}`);
  } finally {
    sessionHandle?.dispose();
  }
}
