#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(cliDir, "..");
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

function printHelp() {
  console.log(`Yunn Workbench ${packageJson.version}

用法：
  yworkbench [选项]

选项：
  --port <端口>       指定本地服务端口，默认自动选择空闲端口
  --data-dir <目录>   指定数据目录，默认使用 ~/.workbench
  --no-open           启动后不自动打开浏览器
  -v, --version       显示版本号
  -h, --help          显示帮助
`);
}

function fail(message) {
  console.error(`错误：${message}`);
  process.exit(1);
}

function readOptionValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) fail(`${option} 需要一个参数`);
  return value;
}

function parseArgs(args) {
  const environmentPort = process.env.WORKBENCH_PORT;
  const defaultPort = environmentPort ? Number(environmentPort) : 0;
  if (!Number.isInteger(defaultPort) || defaultPort < 0 || defaultPort > 65535) {
    fail(`WORKBENCH_PORT 不是有效端口：${environmentPort}`);
  }
  const options = {
    port: defaultPort,
    dataDir: undefined,
    open: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }
    if (arg === "-v" || arg === "--version") {
      console.log(packageJson.version);
      process.exit(0);
    }
    if (arg === "--no-open") {
      options.open = false;
      continue;
    }
    if (arg === "--port") {
      const value = readOptionValue(args, index, arg);
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        fail(`无效端口：${value}`);
      }
      options.port = port;
      index += 1;
      continue;
    }
    if (arg === "--data-dir") {
      options.dataDir = resolve(readOptionValue(args, index, arg));
      index += 1;
      continue;
    }
    fail(`未知参数：${arg}。使用 --help 查看帮助`);
  }

  return options;
}

function openBrowser(url) {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "explorer.exe"
      : "xdg-open";
  const child = spawn(command, [url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.once("error", (error) => {
    console.warn(`无法自动打开浏览器：${error.message}`);
    console.warn(`请手动访问 ${url}`);
  });
  child.unref();
}

async function main() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 24) {
    fail(`需要 Node.js 24 或更高版本，当前版本为 ${process.versions.node}`);
  }

  const options = parseArgs(process.argv.slice(2));
  process.env.WORKBENCH_HOST = "127.0.0.1";
  process.env.WORKBENCH_PORT = String(options.port);
  process.env.WORKBENCH_WEB_DIST = join(packageRoot, "web", "dist");
  if (options.dataDir) process.env.WORKBENCH_HOME = options.dataDir;

  const { startWorkbenchServer } = await import("../server/dist/index.js");
  const runtime = await startWorkbenchServer({
    host: "127.0.0.1",
    port: options.port,
  });

  console.log("");
  console.log(`Yunn Workbench 已启动：${runtime.url}`);
  console.log("按 Ctrl+C 停止服务。\n");
  if (options.open) openBrowser(runtime.url);

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n收到 ${signal}，正在停止 Yunn Workbench…`);
    await runtime.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`Yunn Workbench 启动失败：\n${message}`);
  process.exit(1);
});
