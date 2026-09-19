import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 数据根目录，可用环境变量 WORKBENCH_HOME 覆盖 */
export const WORKBENCH_HOME = process.env.WORKBENCH_HOME || join(homedir(), ".workbench");

export const DB_PATH = join(WORKBENCH_HOME, "workbench.db");

/** 工作台专用的 Pi 认证文件；与全局 ~/.pi 配置隔离 */
export const PI_AUTH_PATH = join(WORKBENCH_HOME, "pi-auth.json");

/** Pi 默认供应商与模型选择 */
export const PI_SETTINGS_PATH = join(WORKBENCH_HOME, "pi-settings.json");

/** 可命名的多模型配置（含本机密钥，文件权限为 0600） */
export const MODEL_PROFILES_PATH = join(WORKBENCH_HOME, "model-profiles.json");

/** 可由前端编辑的任务提示词 */
export const PI_PROMPTS_PATH = join(WORKBENCH_HOME, "pi-prompts.json");

/** 持久化的 Pi 研究会话目录 */
export const PI_SESSIONS_DIR = join(WORKBENCH_HOME, "pi-sessions");

/** 服务端口 */
export const PORT = Number(process.env.WORKBENCH_PORT || 3001);

/** 监听地址；桌面版固定使用回环地址，避免暴露到局域网 */
export const HOST = process.env.WORKBENCH_HOST || "127.0.0.1";

/** 前端构建产物目录（若存在则由后端直接托管） */
export const WEB_DIST = process.env.WORKBENCH_WEB_DIST || join(__dirname, "..", "..", "web", "dist");

/** RSS 抓取间隔（毫秒），本地工具 10 分钟一次 */
export const FETCH_INTERVAL_MS = 10 * 60 * 1000;

/** 单次抓取超时（毫秒） */
export const FETCH_TIMEOUT_MS = 20 * 1000;

/** 信息抓取时间窗：保留最近 N 天（避免无限膨胀） */
export const RETENTION_DAYS = 90;
