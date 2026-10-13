import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { KB_CREDENTIALS_DIR, KB_HOOKS_DIR, KB_REPOS_DIR, WORKBENCH_HOME } from "./config.js";
import { KnowledgeError } from "./knowledge-error.js";

export type KbAuthType = "none" | "github_token" | "ssh_key";

export interface ParsedRepoUrl {
  fetchUrl: string;
  protocol: "https" | "ssh";
  name: string;
}

const ALLOWED_GIT = new Set(["clone", "fetch", "reset", "clean", "rev-parse"]);
const GIT_TIMEOUT_MS = 120_000;

export function parseRepoUrl(input: string): ParsedRepoUrl {
  const raw = input.trim();
  if (!raw) throw new KnowledgeError("请填写 Git 仓库地址");
  if (raw.length > 500 || /[\s'"\\]/.test(raw) || raw.startsWith("-")) throw new KnowledgeError("仓库地址格式无效");
  if (/^file:/i.test(raw) || raw.startsWith("/") || raw.startsWith(".")) {
    throw new KnowledgeError("只支持 HTTPS 或 SSH 仓库地址");
  }
  if (raw.includes("://")) {
    let url: URL;
    try { url = new URL(raw); }
    catch { throw new KnowledgeError("仓库地址格式无效"); }
    if (url.protocol === "http:" || url.protocol === "https:") {
      if (url.username || url.password) {
        throw new KnowledgeError("请不要把令牌写进仓库地址，改用 GitHub Token 或 SSH 私钥");
      }
      return { fetchUrl: url.toString().replace(/\/$/, ""), protocol: "https", name: repoName(url.pathname) };
    }
    if (url.protocol === "ssh:") {
      if (url.password) throw new KnowledgeError("请不要把密钥写进仓库地址，改用 SSH 私钥");
      const user = url.username || "git";
      const port = url.port ? `:${url.port}` : "";
      return {
        fetchUrl: `ssh://${user}@${url.hostname}${port}${url.pathname}`,
        protocol: "ssh",
        name: repoName(url.pathname),
      };
    }
    throw new KnowledgeError("只支持 HTTPS 或 SSH 仓库地址");
  }
  const scp = /^([^@]+)@([^:]+):(.+)$/.exec(raw);
  if (!scp) throw new KnowledgeError("仓库地址格式无效");
  return { fetchUrl: `${scp[1]}@${scp[2]}:${scp[3]}`, protocol: "ssh", name: repoName(scp[3]) };
}

function repoName(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new KnowledgeError("仓库地址格式无效");
  }
  const last = parts[parts.length - 1].replace(/\.git$/i, "");
  if (!last) throw new KnowledgeError("仓库地址缺少仓库名");
  return decodeURIComponent(last).slice(0, 80);
}

export function normalizeAuth(input: unknown): KbAuthType {
  if (input == null || input === "" || input === "none" || input === "public") return "none";
  if (input === "github_token") return "github_token";
  if (input === "ssh_key") return "ssh_key";
  throw new KnowledgeError("无效的认证方式");
}

export function assertAuthMatches(protocol: "https" | "ssh", authType: KbAuthType): void {
  if (authType === "github_token" && protocol !== "https") throw new KnowledgeError("GitHub Token 只能用于 HTTPS 仓库地址");
  if (authType === "ssh_key" && protocol !== "ssh") throw new KnowledgeError("SSH 私钥只能用于 SSH 仓库地址");
  if (authType === "none" && protocol === "ssh") throw new KnowledgeError("SSH 地址需要提供私钥，公开仓库请使用 HTTPS 地址");
}

export function normalizeBranch(input: unknown): string | null {
  if (input == null || input === "") return null;
  const branch = String(input).trim();
  if (!branch) return null;
  if (
    !/^[A-Za-z0-9._/-]{1,200}$/.test(branch)
    || branch.includes("..")
    || branch.startsWith("/")
    || branch.endsWith("/")
    || branch.includes("//")
  ) {
    throw new KnowledgeError("分支名无效");
  }
  return branch;
}

export function assertGithubToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length < 8 || trimmed.length > 400 || /[\s\u0000]/.test(trimmed)) {
    throw new KnowledgeError("GitHub Token 无效");
  }
  return trimmed;
}

export function assertPrivateKeyMaterial(secret: string): string {
  const trimmed = secret.replace(/\r\n/g, "\n").trim();
  if (trimmed.length < 64 || trimmed.length > 100_000 || !trimmed.includes("PRIVATE KEY")) {
    throw new KnowledgeError("这不是可用的 SSH 私钥");
  }
  if (/ENCRYPTED/.test(trimmed)) {
    throw new KnowledgeError("暂不支持带密码的私钥，请使用未加密的部署私钥，或改用 GitHub Token");
  }
  return `${trimmed}\n`;
}

function assertKbId(id: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new KnowledgeError("知识库标识无效");
}

export function githubTokenPath(kbId: string): string {
  assertKbId(kbId);
  return join(KB_CREDENTIALS_DIR, `${kbId}.token`);
}

export function sshKeyPath(kbId: string): string {
  assertKbId(kbId);
  return join(KB_CREDENTIALS_DIR, `${kbId}.key`);
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function writeSecretFile(path: string, content: string): void {
  ensurePrivateDir(KB_CREDENTIALS_DIR);
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function writeGithubToken(kbId: string, token: string): void {
  writeSecretFile(githubTokenPath(kbId), assertGithubToken(token));
}

export function writeSshKey(kbId: string, secret: string): void {
  writeSecretFile(sshKeyPath(kbId), assertPrivateKeyMaterial(secret));
}

export function credentialConfigured(kbId: string, authType: KbAuthType): boolean {
  if (authType === "none") return true;
  if (authType === "github_token") return existsSync(githubTokenPath(kbId));
  return existsSync(sshKeyPath(kbId));
}

export function deleteCredential(kbId: string): void {
  for (const path of [githubTokenPath(kbId), sshKeyPath(kbId)]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
}

export async function assertKeyUsable(path: string): Promise<void> {
  try {
    await runCommand("ssh-keygen", ["-y", "-P", "", "-f", path], 8_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT") || message.includes("没有找到 ssh-keygen")) return;
    throw new KnowledgeError("私钥无法使用，请确认它未加密且格式正确");
  }
}

export function redactSecrets(text: string, secrets: string[]): string {
  let output = text;
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed.length < 4) continue;
    output = output.split(trimmed).join("[redacted]");
  }
  return output;
}

export function gitSubcommand(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-c" || arg === "--config") {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return "";
}

export function assertReadOnlyGitArgs(args: string[]): void {
  if (!ALLOWED_GIT.has(gitSubcommand(args))) {
    throw new KnowledgeError("知识库是只读的，不能写入、提交或推送仓库");
  }
}

export function configArgs(hooksDir: string, allowFileProtocol: boolean): string[] {
  const args = ["-c", `core.hooksPath=${hooksDir}`, "-c", "credential.helper=", "-c", "advice.detachedHead=false"];
  if (!allowFileProtocol) args.push("-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never");
  return args;
}

export function buildCloneArgs(fetchUrl: string, dest: string, branch: string | null, hooksDir: string, allowFileProtocol: boolean): string[] {
  const args = [
    ...configArgs(hooksDir, allowFileProtocol),
    "clone",
    "--no-recurse-submodules",
    "--config", `core.hooksPath=${hooksDir}`,
    "--config", "remote.origin.pushurl=DISABLED",
    "--config", "credential.helper=",
  ];
  if (branch) args.push("--branch", branch);
  args.push("--", fetchUrl, dest);
  assertReadOnlyGitArgs(args);
  return args;
}

export function buildSyncArgs(branch: string, hooksDir: string, allowFileProtocol: boolean): string[][] {
  const config = configArgs(hooksDir, allowFileProtocol);
  const groups = [
    [...config, "fetch", "--prune", "origin", branch],
    [...config, "reset", "--hard", "FETCH_HEAD"],
    [...config, "clean", "-fd"],
  ];
  for (const args of groups) assertReadOnlyGitArgs(args);
  return groups;
}

export function resolveRepoDir(localPath: string): string {
  if (!localPath || localPath.startsWith("/") || localPath.includes("..")) throw new KnowledgeError("知识库路径无效");
  const absolute = resolve(WORKBENCH_HOME, localPath);
  const root = resolve(KB_REPOS_DIR);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) throw new KnowledgeError("知识库路径无效");
  if (absolute === root) throw new KnowledgeError("知识库路径无效");
  return absolute;
}

export function removeRepoDir(localPath: string): void {
  const absolute = resolveRepoDir(localPath);
  if (existsSync(absolute)) rmSync(absolute, { recursive: true, force: true });
  const partial = `${absolute}.partial`;
  if (existsSync(partial)) rmSync(partial, { recursive: true, force: true });
}

function ensureHooksDir(): string {
  mkdirSync(KB_HOOKS_DIR, { recursive: true, mode: 0o700 });
  return KB_HOOKS_DIR;
}

function ensureAskpass(): string {
  ensurePrivateDir(KB_CREDENTIALS_DIR);
  const path = join(KB_CREDENTIALS_DIR, "askpass.sh");
  const script = [
    "#!/bin/sh",
    "case \"$1\" in",
    "  *[Uu]sername*) printf '%s\\n' \"x-access-token\" ;;",
    "  *) printf '%s\\n' \"$WORKBENCH_GIT_ASKPASS_SECRET\" ;;",
    "esac",
    "",
  ].join("\n");
  writeFileSync(path, script, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function gitEnv(kbId: string, authType: KbAuthType): { env: NodeJS.ProcessEnv; secrets: string[] } {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const secrets: string[] = [];
  if (authType === "github_token") {
    const path = githubTokenPath(kbId);
    if (!existsSync(path)) throw new KnowledgeError("未找到已保存的 GitHub Token");
    const token = readFileSync(path, "utf8").trim();
    secrets.push(token);
    env.GIT_ASKPASS = ensureAskpass();
    env.WORKBENCH_GIT_ASKPASS_SECRET = token;
  }
  if (authType === "ssh_key") {
    const path = sshKeyPath(kbId);
    if (!existsSync(path)) throw new KnowledgeError("未找到已保存的 SSH 私钥");
    secrets.push(readFileSync(path, "utf8"));
    const knownHosts = join(KB_CREDENTIALS_DIR, "known_hosts");
    if (!existsSync(knownHosts)) writeSecretFile(knownHosts, "");
    env.GIT_SSH_COMMAND = [
      "ssh",
      "-i", shellQuote(path),
      "-o", "IdentitiesOnly=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", `UserKnownHostsFile=${shellQuote(knownHosts)}`,
      "-o", "BatchMode=yes",
    ].join(" ");
  }
  return { env, secrets };
}

function explainGitFailure(detail: string): string {
  const text = detail.replace(/\s+/g, " ").trim().slice(0, 400);
  if (/authentication failed|invalid username or password|permission denied|could not read from remote/i.test(text)) {
    return `认证失败，请检查 GitHub Token 或 SSH 私钥。${text}`;
  }
  if (/repository .*not found|not found/i.test(text)) return `仓库不存在，或当前凭证无权访问。${text}`;
  if (/could not resolve host|failed to connect|network is unreachable/i.test(text)) return `无法连接仓库主机。${text}`;
  return `仓库同步失败：${text || "未知错误"}`;
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(error.code === "ENOENT" ? `没有找到 ${command}` : error.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveOutput(stdout.trim());
      else reject(new Error(stderr || stdout || `${command} 退出码 ${code}`));
    });
  });
}

function runGit(args: string[], cwd: string | undefined, env: NodeJS.ProcessEnv, secrets: string[]): Promise<string> {
  assertReadOnlyGitArgs(args);
  return new Promise((resolveOutput, reject) => {
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ENOENT") reject(new KnowledgeError("没有找到 git 命令，无法同步知识库"));
      else reject(new KnowledgeError(redactSecrets(error.message, secrets)));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveOutput(stdout.trim());
      else reject(new KnowledgeError(explainGitFailure(redactSecrets(stderr || stdout || `git 退出码 ${code}`, secrets))));
    });
  });
}

async function resolveBranch(repoDir: string, requested: string | null, hooksDir: string, allowFileProtocol: boolean, env: NodeJS.ProcessEnv, secrets: string[]): Promise<string> {
  const name = await runGit([...configArgs(hooksDir, allowFileProtocol), "rev-parse", "--abbrev-ref", "HEAD"], repoDir, env, secrets);
  if (name && name !== "HEAD") return name;
  if (requested) return requested;
  throw new KnowledgeError("无法确定仓库默认分支");
}

export async function cloneRepository(options: {
  kbId: string;
  fetchUrl: string;
  branch: string | null;
  authType: KbAuthType;
  dest: string;
  allowFileProtocol?: boolean;
}): Promise<{ commitSha: string; branch: string }> {
  const allowFileProtocol = options.allowFileProtocol === true;
  const hooksDir = ensureHooksDir();
  mkdirSync(dirname(options.dest), { recursive: true });
  if (existsSync(options.dest)) rmSync(options.dest, { recursive: true, force: true });
  const { env, secrets } = gitEnv(options.kbId, options.authType);
  try {
    await runGit(buildCloneArgs(options.fetchUrl, options.dest, options.branch, hooksDir, allowFileProtocol), undefined, env, secrets);
    const branch = await resolveBranch(options.dest, options.branch, hooksDir, allowFileProtocol, env, secrets);
    const commitSha = await runGit([...configArgs(hooksDir, allowFileProtocol), "rev-parse", "HEAD"], options.dest, env, secrets);
    return { commitSha, branch };
  } catch (error) {
    if (existsSync(options.dest)) rmSync(options.dest, { recursive: true, force: true });
    throw error;
  }
}

export async function syncRepository(options: {
  kbId: string;
  repoDir: string;
  branch: string;
  authType: KbAuthType;
  allowFileProtocol?: boolean;
}): Promise<{ commitSha: string; branch: string }> {
  const allowFileProtocol = options.allowFileProtocol === true;
  const hooksDir = ensureHooksDir();
  const { env, secrets } = gitEnv(options.kbId, options.authType);
  for (const args of buildSyncArgs(options.branch, hooksDir, allowFileProtocol)) {
    await runGit(args, options.repoDir, env, secrets);
  }
  const commitSha = await runGit([...configArgs(hooksDir, allowFileProtocol), "rev-parse", "HEAD"], options.repoDir, env, secrets);
  return { commitSha, branch: options.branch };
}
