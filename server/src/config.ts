import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 数据根目录，可用环境变量 WORKBENCH_HOME 覆盖 */
export const WORKBENCH_HOME = process.env.WORKBENCH_HOME || join(homedir(), ".workbench");

export const DB_PATH = join(WORKBENCH_HOME, "workbench.db");

/** 服务端口 */
export const PORT = Number(process.env.WORKBENCH_PORT || 3001);

/** 前端构建产物目录（若存在则由后端直接托管） */
export const WEB_DIST = join(__dirname, "..", "..", "web", "dist");

/** RSS 抓取间隔（毫秒），本地工具 10 分钟一次 */
export const FETCH_INTERVAL_MS = 10 * 60 * 1000;

/** 单次抓取超时（毫秒） */
export const FETCH_TIMEOUT_MS = 20 * 1000;

/** 信息抓取时间窗：保留最近 N 天（避免无限膨胀） */
export const RETENTION_DAYS = 90;
