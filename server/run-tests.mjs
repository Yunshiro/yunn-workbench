import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(tmpdir(), "workbench-kb-test-"));
const child = spawn(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", "src/knowledge-base.test.ts", "src/boards.test.ts"], {
  cwd: dirname(fileURLToPath(import.meta.url)),
  env: { ...process.env, WORKBENCH_HOME: home },
  stdio: "inherit",
});

child.on("exit", (code) => {
  rmSync(home, { recursive: true, force: true });
  process.exit(code ?? 1);
});
