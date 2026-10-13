import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  deleteKnowledgeBaseRecord,
  getKnowledgeBase,
  getKnowledgeBaseRecord,
  getKnowledgeDocument,
  insertKnowledgeBase,
  listKnowledgeBaseRecords,
  listKnowledgeBases,
  replaceKnowledgeIndex,
  updateKnowledgeBaseRecord,
  hashContent,
  type IndexedDocument,
  type KbDocument,
  type KnowledgeBase,
} from "./knowledge-db.js";
import { knowledgeEvents } from "./knowledge-events.js";
import { KnowledgeError } from "./knowledge-error.js";
import {
  assertAuthMatches,
  assertGithubToken,
  assertKeyUsable,
  assertPrivateKeyMaterial,
  cloneRepository,
  credentialConfigured,
  deleteCredential,
  normalizeAuth,
  normalizeBranch,
  parseRepoUrl,
  removeRepoDir,
  resolveRepoDir,
  sshKeyPath,
  syncRepository,
  writeGithubToken,
  writeSshKey,
  type KbAuthType,
} from "./knowledge-git.js";
import { chunkMarkdown, readMarkdownTree, searchableText } from "./knowledge-index.js";

const jobs = new Map<string, { cancelled: boolean }>();

function canonicalRepoKey(fetchUrl: string): string {
  return fetchUrl.replace(/\.git$/i, "").replace(/\/$/, "").toLowerCase();
}

function emitStatus(id: string): void {
  const knowledgeBase = getKnowledgeBase(id);
  if (knowledgeBase) knowledgeEvents.emit("kb_status", { knowledgeBase });
}

function indexDocuments(root: string): IndexedDocument[] {
  return readMarkdownTree(root).map((source) => {
    const chunked = chunkMarkdown(source.path, source.markdown);
    return {
      path: source.path,
      title: chunked.title,
      content: source.markdown,
      contentHash: hashContent(source.markdown),
      frontmatter: {
        ...chunked.frontmatter,
        title: chunked.title,
        tags: chunked.tags,
        aliases: chunked.aliases,
        ...(chunked.description ? { description: chunked.description } : {}),
      },
      chunks: chunked.chunks.map((chunk) => ({
        heading: chunk.heading,
        content: chunk.content,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        searchText: searchableText({
          title: chunked.title,
          tags: chunked.tags,
          aliases: chunked.aliases,
          description: chunked.description,
          heading: chunk.heading,
          content: chunk.content,
        }),
      })),
    };
  });
}

async function runSync(id: string, job: { cancelled: boolean }): Promise<void> {
  const current = getKnowledgeBaseRecord(id);
  if (!current || job.cancelled) return;
  updateKnowledgeBaseRecord(id, { status: "syncing", lastError: null });
  emitStatus(id);
  console.log(`[kb] 开始同步 ${current.name}`);
  const destination = resolveRepoDir(current.localPath);
  const partial = `${destination}.partial`;
  try {
    const cloned = existsSync(join(destination, ".git"));
    if (cloned && !current.branch) throw new KnowledgeError("请先指定要同步的分支");
    const result = cloned
      ? await syncRepository({
        kbId: id,
        repoDir: destination,
        branch: current.branch as string,
        authType: current.authType,
      })
      : await cloneRepository({
        kbId: id,
        fetchUrl: current.repoUrl,
        branch: current.branch,
        authType: current.authType,
        dest: partial,
      });
    if (job.cancelled || !getKnowledgeBaseRecord(id)) return;
    if (!cloned) {
      if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
      renameSync(partial, destination);
    }
    updateKnowledgeBaseRecord(id, { branch: result.branch, commitSha: result.commitSha });
    const indexed = replaceKnowledgeIndex(id, indexDocuments(destination));
    if (job.cancelled || !getKnowledgeBaseRecord(id)) return;
    updateKnowledgeBaseRecord(id, {
      status: "ready",
      lastError: null,
      lastSyncedAt: Date.now(),
      commitSha: result.commitSha,
      branch: result.branch,
      fileCount: indexed.fileCount,
      chunkCount: indexed.chunkCount,
    });
    console.log(`[kb] 同步完成 ${current.name}，${indexed.fileCount} 个 Markdown，${indexed.chunkCount} 个片段`);
  } catch (error) {
    if (existsSync(partial)) rmSync(partial, { recursive: true, force: true });
    if (job.cancelled || !getKnowledgeBaseRecord(id)) return;
    const message = error instanceof Error ? error.message : String(error);
    updateKnowledgeBaseRecord(id, { status: "error", lastError: message });
    console.error(`[kb] 同步失败 ${current.name}：${message}`);
  } finally {
    emitStatus(id);
    if (job.cancelled) {
      removeRepoDir(current.localPath);
      deleteCredential(id);
    }
  }
}

function scheduleSync(id: string): void {
  if (jobs.has(id)) throw new KnowledgeError("这个知识库正在同步", 409);
  const job = { cancelled: false };
  jobs.set(id, job);
  void runSync(id, job).finally(() => {
    if (jobs.get(id) === job) jobs.delete(id);
  });
}

async function storeCredential(id: string, authType: KbAuthType, token?: string, sshKey?: string): Promise<void> {
  if (authType === "github_token") {
    if (!token) throw new KnowledgeError("请填写 GitHub Token");
    writeGithubToken(id, assertGithubToken(token));
  } else if (authType === "ssh_key") {
    if (!sshKey) throw new KnowledgeError("请填写 SSH 私钥");
    writeSshKey(id, assertPrivateKeyMaterial(sshKey));
    await assertKeyUsable(sshKeyPath(id));
  } else {
    deleteCredential(id);
  }
}

export function listKnowledgeBaseViews(): KnowledgeBase[] {
  return listKnowledgeBases();
}

export async function addKnowledgeBase(input: {
  name?: unknown;
  repoUrl?: unknown;
  authType?: unknown;
  token?: unknown;
  sshKey?: unknown;
  branch?: unknown;
}): Promise<KnowledgeBase> {
  if (typeof input.repoUrl !== "string") throw new KnowledgeError("请填写 Git 仓库地址");
  const parsed = parseRepoUrl(input.repoUrl);
  const authType = normalizeAuth(input.authType);
  assertAuthMatches(parsed.protocol, authType);
  const branch = normalizeBranch(input.branch);
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 80) : parsed.name;
  const token = typeof input.token === "string" ? input.token : undefined;
  const sshKey = typeof input.sshKey === "string" ? input.sshKey : undefined;
  if (authType === "github_token") assertGithubToken(token || "");
  if (authType === "ssh_key") assertPrivateKeyMaterial(sshKey || "");
  const duplicate = listKnowledgeBaseRecords().find((item) => canonicalRepoKey(item.repoUrl) === canonicalRepoKey(parsed.fetchUrl));
  if (duplicate) throw new KnowledgeError("这个仓库已经添加过");
  const created = insertKnowledgeBase({
    name,
    repoUrl: parsed.fetchUrl,
    authType,
    branch,
  });
  try {
    await storeCredential(created.id, authType, token, sshKey);
  } catch (error) {
    deleteKnowledgeBaseRecord(created.id);
    deleteCredential(created.id);
    throw error;
  }
  updateKnowledgeBaseRecord(created.id, { status: "syncing", lastError: null });
  scheduleSync(created.id);
  return getKnowledgeBase(created.id)!;
}

export function requestKnowledgeSync(id: string): KnowledgeBase {
  const record = getKnowledgeBaseRecord(id);
  if (!record) throw new KnowledgeError("知识库不存在", 404);
  if (jobs.has(id)) throw new KnowledgeError("这个知识库正在同步", 409);
  if (!credentialConfigured(id, record.authType)) throw new KnowledgeError("缺少访问凭证");
  updateKnowledgeBaseRecord(id, { status: "syncing", lastError: null });
  scheduleSync(id);
  return getKnowledgeBase(id)!;
}

export async function updateKnowledgeBaseSettings(id: string, input: {
  name?: unknown;
  branch?: unknown;
  authType?: unknown;
  token?: unknown;
  sshKey?: unknown;
}): Promise<KnowledgeBase> {
  const record = getKnowledgeBaseRecord(id);
  if (!record) throw new KnowledgeError("知识库不存在", 404);
  const parsed = parseRepoUrl(record.repoUrl);
  let authType = input.authType === undefined ? record.authType : normalizeAuth(input.authType);
  const token = typeof input.token === "string" ? input.token : undefined;
  const sshKey = typeof input.sshKey === "string" ? input.sshKey : undefined;
  if (token) authType = "github_token";
  if (sshKey) authType = "ssh_key";
  assertAuthMatches(parsed.protocol, authType);
  if (token || sshKey || input.authType !== undefined) await storeCredential(id, authType, token, sshKey);
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 80) : record.name;
  const branch = input.branch === undefined ? record.branch : normalizeBranch(input.branch);
  updateKnowledgeBaseRecord(id, { name: name || record.name, authType, branch });
  return getKnowledgeBase(id)!;
}

export function removeKnowledgeBase(id: string): void {
  const record = getKnowledgeBaseRecord(id);
  if (!record) throw new KnowledgeError("知识库不存在", 404);
  const job = jobs.get(id);
  if (job) job.cancelled = true;
  deleteKnowledgeBaseRecord(id);
  if (!job) {
    removeRepoDir(record.localPath);
    deleteCredential(id);
  }
  knowledgeEvents.emit("kb_deleted", { kbId: id });
}

export function readKnowledgeDocument(kbId: string, path: string): KbDocument {
  if (!getKnowledgeBase(kbId)) throw new KnowledgeError("知识库不存在", 404);
  const document = getKnowledgeDocument(kbId, path);
  if (!document) throw new KnowledgeError("没有找到这篇 Markdown", 404);
  return document;
}
