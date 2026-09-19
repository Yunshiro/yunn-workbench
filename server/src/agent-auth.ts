import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { MODEL_PROFILES_PATH, PI_AUTH_PATH, PI_SETTINGS_PATH } from "./config.js";

export const AGENT_PROVIDERS = [
  { id: "anthropic", label: "Anthropic", envVar: "ANTHROPIC_API_KEY", defaultModelId: "claude-opus-4-8" },
  { id: "openai", label: "OpenAI", envVar: "OPENAI_API_KEY", defaultModelId: "gpt-5.5" },
  { id: "google", label: "Google Gemini", envVar: "GEMINI_API_KEY", defaultModelId: "gemini-3.1-pro-preview" },
  { id: "deepseek", label: "DeepSeek", envVar: "DEEPSEEK_API_KEY", defaultModelId: "deepseek-v4-pro" },
  { id: "openrouter", label: "OpenRouter", envVar: "OPENROUTER_API_KEY", defaultModelId: "moonshotai/kimi-k2.6" },
  { id: "xai", label: "xAI", envVar: "XAI_API_KEY", defaultModelId: "grok-4.6" },
  { id: "groq", label: "Groq", envVar: "GROQ_API_KEY", defaultModelId: "openai/gpt-oss-120b" },
  { id: "mistral", label: "Mistral", envVar: "MISTRAL_API_KEY", defaultModelId: "devstral-medium-latest" },
  { id: "zai", label: "Z.AI", envVar: "ZAI_API_KEY", defaultModelId: "glm-5.3" },
  { id: "kimi-coding", label: "Kimi For Coding", envVar: "KIMI_API_KEY", defaultModelId: "kimi-for-coding" },
] as const;

type AuthFile = Record<string, { type: string; key?: string; [key: string]: unknown }>;
export type ModelProfileType = "builtin" | "openai_compatible";

interface StoredModelProfile {
  id: string;
  name: string;
  type: ModelProfileType;
  providerId: string;
  modelId: string;
  baseUrl: string | null;
  apiKey?: string;
  createdAt: number;
  updatedAt: number;
}

interface ModelProfilesFile {
  version: 1;
  activeId: string;
  profiles: StoredModelProfile[];
}

export interface ModelProfileInput {
  name: string;
  type: ModelProfileType;
  providerId: string;
  modelId: string;
  baseUrl?: string | null;
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface ModelProfile {
  id: string;
  name: string;
  type: ModelProfileType;
  providerId: string;
  providerLabel: string;
  modelId: string;
  baseUrl: string | null;
  isActive: boolean;
  configured: boolean;
  hasApiKey: boolean;
  apiKeySource: "profile" | "environment" | null;
  createdAt: number;
  updatedAt: number;
}

let modelCatalogPromise: Promise<Map<string, { id: string; name: string }[]>> | null = null;

function readJson(path: string): any {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`模型配置文件无法读取：${String((error as Error).message || error)}`); }
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

function readLegacyAuth(): AuthFile {
  const parsed = readJson(PI_AUTH_PATH);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function readLegacySelection(): { providerId: string; modelId: string } | null {
  const parsed = readJson(PI_SETTINGS_PATH);
  return typeof parsed?.providerId === "string" && typeof parsed?.modelId === "string" ? parsed : null;
}

function ensureProfilesFile(): ModelProfilesFile {
  const parsed = readJson(MODEL_PROFILES_PATH);
  if (parsed?.version === 1 && Array.isArray(parsed.profiles) && typeof parsed.activeId === "string") {
    return parsed as ModelProfilesFile;
  }

  const legacyAuth = readLegacyAuth();
  const legacySelection = readLegacySelection();
  const configuredProviders = AGENT_PROVIDERS.filter((provider) => {
    const credential = legacyAuth[provider.id];
    return (credential?.type === "api_key" && !!credential.key) || !!process.env[provider.envVar];
  });
  const selectedProvider = AGENT_PROVIDERS.find((provider) => provider.id === legacySelection?.providerId)
    ?? configuredProviders[0]
    ?? AGENT_PROVIDERS[0];
  const providers = configuredProviders.length > 0 ? configuredProviders : [selectedProvider];
  if (!providers.some((provider) => provider.id === selectedProvider.id)) providers.unshift(selectedProvider);
  const now = Date.now();
  const profiles = providers.map((provider, index): StoredModelProfile => ({
    id: randomUUID(),
    name: provider.label,
    type: "builtin",
    providerId: provider.id,
    modelId: provider.id === selectedProvider.id && legacySelection?.modelId ? legacySelection.modelId : provider.defaultModelId,
    baseUrl: null,
    apiKey: legacyAuth[provider.id]?.type === "api_key" ? legacyAuth[provider.id].key : undefined,
    createdAt: now + index,
    updatedAt: now + index,
  }));
  const result: ModelProfilesFile = {
    version: 1,
    activeId: profiles.find((profile) => profile.providerId === selectedProvider.id)!.id,
    profiles,
  };
  atomicWrite(MODEL_PROFILES_PATH, result);
  return result;
}

function writeProfilesFile(file: ModelProfilesFile): void {
  atomicWrite(MODEL_PROFILES_PATH, file);
}

function providerInfo(providerId: string) {
  return AGENT_PROVIDERS.find((provider) => provider.id === providerId);
}

function normalizeBaseUrl(value?: string | null): string | null {
  const normalized = String(value || "").trim().replace(/\/+$/, "");
  if (!normalized) return null;
  let url: URL;
  try { url = new URL(normalized); }
  catch { throw new Error("Base URL 格式无效"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Base URL 仅支持 http 或 https");
  return normalized;
}

function validateInput(input: ModelProfileInput): ModelProfileInput {
  const type: ModelProfileType = input.type === "openai_compatible" ? "openai_compatible" : "builtin";
  const providerId = type === "builtin" ? String(input.providerId || "") : "custom-openai";
  if (type === "builtin" && !providerInfo(providerId)) throw new Error("不支持的模型供应商");
  const modelId = String(input.modelId || "").trim();
  if (!modelId) throw new Error("Model ID 不能为空");
  const baseUrl = type === "openai_compatible" ? normalizeBaseUrl(input.baseUrl) : null;
  if (type === "openai_compatible" && !baseUrl) throw new Error("自定义模型需要 Base URL");
  return {
    ...input,
    name: String(input.name || "").trim().slice(0, 100) || "未命名模型配置",
    type,
    providerId,
    modelId: modelId.slice(0, 200),
    baseUrl,
    apiKey: typeof input.apiKey === "string" ? input.apiKey.trim() : undefined,
  };
}

function toPublic(profile: StoredModelProfile, activeId: string): ModelProfile {
  const provider = providerInfo(profile.providerId);
  const fromProfile = !!profile.apiKey;
  const fromEnvironment = profile.type === "builtin" && !!provider && !!process.env[provider.envVar];
  return {
    id: profile.id,
    name: profile.name,
    type: profile.type,
    providerId: profile.providerId,
    providerLabel: profile.type === "openai_compatible" ? "OpenAI 兼容接口" : provider?.label || profile.providerId,
    modelId: profile.modelId,
    baseUrl: profile.baseUrl,
    isActive: profile.id === activeId,
    configured: profile.type === "openai_compatible" ? !!profile.baseUrl && !!profile.modelId : (fromProfile || fromEnvironment),
    hasApiKey: fromProfile || fromEnvironment,
    apiKeySource: fromProfile ? "profile" : fromEnvironment ? "environment" : null,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

async function getModelCatalog(): Promise<Map<string, { id: string; name: string }[]>> {
  if (!modelCatalogPromise) {
    modelCatalogPromise = (async () => {
      const runtime = await ModelRuntime.create({ authPath: PI_AUTH_PATH, refreshOnCreate: false });
      return new Map(AGENT_PROVIDERS.map((provider) => [
        provider.id,
        runtime.getModels(provider.id).map((model) => ({ id: model.id, name: model.name || model.id })),
      ]));
    })();
  }
  return modelCatalogPromise;
}

export async function getAgentConfiguration() {
  const file = ensureProfilesFile();
  const catalog = await getModelCatalog();
  const profiles = file.profiles.map((profile) => toPublic(profile, file.activeId));
  const active = profiles.find((profile) => profile.isActive);
  return {
    configured: !!active?.configured,
    activeConfigId: file.activeId,
    configs: profiles,
    providers: AGENT_PROVIDERS.map((provider) => ({
      ...provider,
      models: catalog.get(provider.id) ?? [],
      environmentConfigured: !!process.env[provider.envVar],
    })),
  };
}

export function getAgentAuthConfig() {
  const file = ensureProfilesFile();
  const active = file.profiles.find((profile) => profile.id === file.activeId);
  const publicProfile = active ? toPublic(active, file.activeId) : null;
  return { configured: !!publicProfile?.configured, active: publicProfile };
}

export async function createModelProfile(input: ModelProfileInput): Promise<ModelProfile> {
  const valid = validateInput(input);
  if (valid.type === "builtin") {
    const models = (await getModelCatalog()).get(valid.providerId) ?? [];
    if (!models.some((model) => model.id === valid.modelId)) throw new Error("所选模型不属于该供应商");
  }
  const file = ensureProfilesFile();
  const now = Date.now();
  const profile: StoredModelProfile = {
    id: randomUUID(), name: valid.name, type: valid.type, providerId: valid.providerId,
    modelId: valid.modelId, baseUrl: valid.baseUrl ?? null, apiKey: valid.apiKey || undefined,
    createdAt: now, updatedAt: now,
  };
  file.profiles.push(profile);
  writeProfilesFile(file);
  return toPublic(profile, file.activeId);
}

export async function updateModelProfile(id: string, input: ModelProfileInput): Promise<ModelProfile> {
  const valid = validateInput(input);
  if (valid.type === "builtin") {
    const models = (await getModelCatalog()).get(valid.providerId) ?? [];
    if (!models.some((model) => model.id === valid.modelId)) throw new Error("所选模型不属于该供应商");
  }
  const file = ensureProfilesFile();
  const profile = file.profiles.find((item) => item.id === id);
  if (!profile) throw new Error("模型配置不存在");
  const providerChanged = profile.type !== valid.type || profile.providerId !== valid.providerId;
  profile.name = valid.name;
  profile.type = valid.type;
  profile.providerId = valid.providerId;
  profile.modelId = valid.modelId;
  profile.baseUrl = valid.baseUrl ?? null;
  if (valid.clearApiKey || (providerChanged && !valid.apiKey)) delete profile.apiKey;
  else if (valid.apiKey) profile.apiKey = valid.apiKey;
  profile.updatedAt = Date.now();
  writeProfilesFile(file);
  return toPublic(profile, file.activeId);
}

export function activateModelProfile(id: string): ModelProfile {
  const file = ensureProfilesFile();
  const profile = file.profiles.find((item) => item.id === id);
  if (!profile) throw new Error("模型配置不存在");
  const publicProfile = toPublic(profile, id);
  if (!publicProfile.configured) throw new Error("请先完成该模型的认证配置");
  file.activeId = id;
  writeProfilesFile(file);
  return publicProfile;
}

export function duplicateModelProfile(id: string): ModelProfile {
  const file = ensureProfilesFile();
  const source = file.profiles.find((item) => item.id === id);
  if (!source) throw new Error("模型配置不存在");
  const now = Date.now();
  const copy: StoredModelProfile = { ...source, id: randomUUID(), name: `${source.name} 副本`, createdAt: now, updatedAt: now };
  file.profiles.push(copy);
  writeProfilesFile(file);
  return toPublic(copy, file.activeId);
}

export function deleteModelProfile(id: string): void {
  const file = ensureProfilesFile();
  if (file.profiles.length <= 1) throw new Error("至少需要保留一张模型配置");
  const index = file.profiles.findIndex((profile) => profile.id === id);
  if (index < 0) throw new Error("模型配置不存在");
  file.profiles.splice(index, 1);
  if (file.activeId === id) file.activeId = file.profiles[0].id;
  writeProfilesFile(file);
}

export function getActiveModelProfile(): StoredModelProfile | null {
  const file = ensureProfilesFile();
  return file.profiles.find((profile) => profile.id === file.activeId) ?? null;
}

function registerCustomProfile(runtime: ModelRuntime, profile: StoredModelProfile): { providerId: string; modelId: string } {
  const providerId = `workbench-${profile.id}`;
  runtime.registerProvider(providerId, {
    name: profile.name,
    baseUrl: profile.baseUrl!,
    api: "openai-completions",
    apiKey: profile.apiKey || "local-no-key",
    authHeader: !!profile.apiKey,
    models: [{
      id: profile.modelId, name: profile.modelId, api: "openai-completions", reasoning: false,
      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000, maxTokens: 8192,
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    }],
  });
  return { providerId, modelId: profile.modelId };
}

export async function prepareActiveModel(runtime: ModelRuntime) {
  const profile = getActiveModelProfile();
  if (!profile) return undefined;
  const selection = profile.type === "openai_compatible"
    ? registerCustomProfile(runtime, profile)
    : { providerId: profile.providerId, modelId: profile.modelId };
  if (profile.type === "builtin" && profile.apiKey) await runtime.setRuntimeApiKey(profile.providerId, profile.apiKey);
  const model = runtime.getModel(selection.providerId, selection.modelId);
  if (!model) throw new Error(`已配置的模型不存在：${selection.providerId}/${selection.modelId}`);
  return model;
}

export async function testModelProfile(id: string): Promise<{ ok: true; message: string }> {
  const file = ensureProfilesFile();
  const profile = file.profiles.find((item) => item.id === id);
  if (!profile) throw new Error("模型配置不存在");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    if (profile.type === "openai_compatible") {
      const response = await fetch(`${profile.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: profile.modelId, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 1, stream: false }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`连接失败（HTTP ${response.status}）：${(await response.text()).slice(0, 300)}`);
    } else {
      const runtime = await ModelRuntime.create({ authPath: PI_AUTH_PATH, refreshOnCreate: false });
      if (profile.apiKey) await runtime.setRuntimeApiKey(profile.providerId, profile.apiKey);
      const model = runtime.getModel(profile.providerId, profile.modelId);
      if (!model) throw new Error("模型不存在");
      await runtime.completeSimple(model, { messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }] } as any, { signal: controller.signal } as any);
    }
    return { ok: true, message: "连接成功，模型已响应。" };
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new Error("连接测试超时（15 秒）");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
