import { existsSync } from "node:fs";
import express from "express";
import { app } from "./http.js";
import { FETCH_INTERVAL_MS, PORT, RETENTION_DAYS, WEB_DIST } from "./config.js";
import { fetchAllFeeds } from "./rss.js";
import { pruneOldItems, listFeeds } from "./db.js";

// ---- 静态资源：若前端已构建，直接由后端托管（单进程运行） ----
if (existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  // SPA 回退：非 API 路径都返回 index.html
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(WEB_DIST + "/index.html");
  });
  console.log(`[http] 托管前端构建产物：${WEB_DIST}`);
} else {
  console.log("[http] 未检测到前端构建产物，仅提供 API（前端请用 npm run dev:web）");
}

// ---- 定时抓取 ----
let fetching = false;
async function scheduledFetch(): Promise<void> {
  if (fetching) return;
  fetching = true;
  try {
    const feeds = listFeeds();
    if (feeds.length === 0) return;
    console.log(`[rss] 开始抓取 ${feeds.length} 个源…`);
    const results = await fetchAllFeeds();
    const total = results.reduce((n, r) => n + r.added, 0);
    const failed = results.filter((r) => r.error);
    console.log(`[rss] 抓取完成：新增 ${total} 条${failed.length ? `，${failed.length} 个源失败` : ""}`);
    if (failed.length) {
      for (const f of failed) console.warn(`[rss] 源「${f.title}」失败：${f.error}`);
    }
  } catch (err) {
    console.error("[rss] 定时抓取出错：", err);
  } finally {
    fetching = false;
  }
}

async function scheduledPrune(): Promise<void> {
  try {
    pruneOldItems(RETENTION_DAYS);
  } catch (err) {
    console.error("[db] 清理旧数据出错：", err);
  }
}

setInterval(scheduledFetch, FETCH_INTERVAL_MS);
setInterval(scheduledPrune, 24 * 60 * 60 * 1000);

// ---- 启动 ----
app.listen(PORT, () => {
  console.log(`工作台后端已启动：http://localhost:${PORT}`);
  console.log(`数据目录：${process.env.WORKBENCH_HOME || "~/.workbench"}`);
  // 启动后异步抓取一次（不阻塞启动）
  void scheduledFetch();
});
