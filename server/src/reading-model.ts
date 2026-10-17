import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AGENT_PROVIDERS, getActiveModelProfile, prepareActiveModel } from "./agent-auth.js";
import { PI_AUTH_PATH } from "./config.js";
import { ReadingError } from "./reading-error.js";

export interface ReadingPrompt {
  system: string;
  user: string;
}

export type ReadingModel = (prompt: ReadingPrompt) => Promise<string>;

const OPENAI_CHAT_URLS: Record<string, string> = {
  deepseek: "https://api.deepseek.com/chat/completions",
  openai: "https://api.openai.com/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
  xai: "https://api.x.ai/v1/chat/completions",
  mistral: "https://api.mistral.ai/v1/chat/completions",
};

let testModel: ReadingModel | null = null;
let runtimePromise: Promise<ModelRuntime> | null = null;

export function setReadingModelForTests(model: ReadingModel | null): void {
  testModel = model;
  runtimePromise = null;
}

export function getReadingAccessError(): string | null {
  if (testModel) return null;
  const profile = getActiveModelProfile();
  if (!profile) return "还没有可用的模型。请到「Agent 设置」添加 DeepSeek，并填写 API Key。";
  const key = resolveApiKey(profile);
  if (key) return null;
  if (profile.type === "openai_compatible" && isLoopback(profile.baseUrl)) return null;
  return missingKeyMessage(profile.providerId);
}

export async function completeReading(prompt: ReadingPrompt): Promise<string> {
  if (testModel) return testModel(prompt);
  const problem = getReadingAccessError();
  if (problem) throw new ReadingError(problem);
  const profile = getActiveModelProfile();
  if (!profile) throw new ReadingError(missingKeyMessage("deepseek"));
  const key = resolveApiKey(profile);
  const url = chatUrl(profile);
  if (url) return completeOpenAI(url, key, profile.modelId, prompt);
  return completeWithRuntime(prompt);
}

function resolveApiKey(profile: NonNullable<ReturnType<typeof getActiveModelProfile>>): string {
  if (profile.apiKey) return profile.apiKey;
  const provider = AGENT_PROVIDERS.find((item) => item.id === profile.providerId);
  if (profile.type === "builtin" && provider) return process.env[provider.envVar]?.trim() || "";
  return "";
}

function missingKeyMessage(providerId: string): string {
  if (providerId === "deepseek") {
    return "缺少 API Key。请打开「Agent 设置」，在当前的 DeepSeek 模型配置里填写密钥，或在启动前设置环境变量 DEEPSEEK_API_KEY。密钥只保存在本机，不会写入项目。";
  }
  return "缺少 API Key。请打开「Agent 设置」，在当前模型配置里填写密钥。密钥只保存在本机，不会写入项目。";
}

function chatUrl(profile: NonNullable<ReturnType<typeof getActiveModelProfile>>): string | null {
  if (profile.type === "openai_compatible") return profile.baseUrl ? joinChatUrl(profile.baseUrl) : null;
  const known = OPENAI_CHAT_URLS[profile.providerId];
  return known ?? null;
}

function joinChatUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}

function isLoopback(baseUrl: string | null): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

async function completeOpenAI(url: string, apiKey: string, model: string, prompt: ReadingPrompt): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 2048,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
      }),
      signal: controller.signal,
    });
    const body = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new ReadingError("API Key 无效或没有权限。请到「Agent 设置」检查当前模型的密钥。");
    }
    if (!response.ok) {
      throw new ReadingError(`模型请求失败（HTTP ${response.status}）：${redact(body, apiKey).slice(0, 300)}`, 502, response.status >= 500);
    }
    let parsed: any;
    try { parsed = JSON.parse(body); }
    catch { throw new ReadingError("模型没有返回可用的结果。", 502, true); }
    const content = parsed?.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part: any) => part?.text || "").join("") : "";
    if (!text.trim()) throw new ReadingError("模型没有返回可用的结果。", 502, true);
    return text;
  } catch (error) {
    if (error instanceof ReadingError) throw error;
    if ((error as Error).name === "AbortError") throw new ReadingError("模型请求超时。这一章还没完成，继续时不会重跑已经完成的章节。", 504, true);
    throw new ReadingError("无法连接模型服务。请检查网络，或到「Agent 设置」确认当前模型。", 502, true);
  } finally {
    clearTimeout(timeout);
  }
}

async function completeWithRuntime(prompt: ReadingPrompt): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    if (!runtimePromise) {
      runtimePromise = ModelRuntime.create({ authPath: PI_AUTH_PATH, refreshOnCreate: false });
    }
    const runtime = await runtimePromise;
    const model = await prepareActiveModel(runtime);
    if (!model) throw new ReadingError(missingKeyMessage(""));
    const result = await runtime.completeSimple(model, {
      messages: [
        { role: "system", content: prompt.system, timestamp: Date.now() },
        { role: "user", content: prompt.user, timestamp: Date.now() },
      ],
    } as any, { signal: controller.signal, maxTokens: 2048 } as any);
    const text = textFromCompletion(result);
    if (!text.trim()) throw new ReadingError("模型没有返回可用的结果。", 502, true);
    return text;
  } catch (error) {
    runtimePromise = null;
    if (error instanceof ReadingError) throw error;
    const message = String((error as Error).message || error);
    if (/401|403|invalid api key|incorrect api key|unauthorized/i.test(message)) {
      throw new ReadingError("API Key 无效或没有权限。请到「Agent 设置」检查当前模型的密钥。");
    }
    if ((error as Error).name === "AbortError") throw new ReadingError("模型请求超时。这一章还没完成，继续时不会重跑已经完成的章节。", 504, true);
    throw new ReadingError(`模型请求失败：${message.slice(0, 300)}`, 502, true);
  } finally {
    clearTimeout(timeout);
  }
}

function textFromCompletion(result: any): string {
  if (typeof result === "string") return result;
  if (typeof result?.content === "string") return result.content;
  if (Array.isArray(result?.content)) {
    return result.content.map((part: any) => (typeof part === "string" ? part : part?.text || "")).join("");
  }
  if (typeof result?.text === "string") return result.text;
  return "";
}

function redact(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("***");
}
