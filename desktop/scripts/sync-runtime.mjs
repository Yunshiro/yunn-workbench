import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const projectDir = join(desktopDir, "..");
const runtimeDir = join(desktopDir, "runtime");

rmSync(runtimeDir, { recursive: true, force: true });
mkdirSync(runtimeDir, { recursive: true });
cpSync(join(projectDir, "server", "dist"), join(runtimeDir, "server"), { recursive: true });
cpSync(join(projectDir, "web", "dist"), join(runtimeDir, "web"), { recursive: true });
