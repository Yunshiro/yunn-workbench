import { app, BrowserWindow, dialog, session, shell } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface DesktopServer {
  url: string;
  close: () => Promise<void>;
}

let mainWindow: BrowserWindow | null = null;
let workbenchServer: DesktopServer | null = null;
let quitting = false;

function isExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function startServer(): Promise<DesktopServer> {
  const appRoot = app.getAppPath();
  process.env.WORKBENCH_HOME = join(app.getPath("userData"), "data");
  process.env.WORKBENCH_HOST = "127.0.0.1";
  process.env.WORKBENCH_PORT = "0";
  process.env.WORKBENCH_WEB_DIST = join(appRoot, "runtime", "web");
  const serverEntry = pathToFileURL(join(appRoot, "runtime", "server", "index.js")).href;
  const serverModule = await import(serverEntry) as {
    startWorkbenchServer: (options: { port: number; host: string }) => Promise<DesktopServer>;
  };
  return serverModule.startWorkbenchServer({ port: 0, host: "127.0.0.1" });
}

async function createWindow(): Promise<void> {
  if (!workbenchServer) workbenchServer = await startServer();
  const allowedOrigin = new URL(workbenchServer.url).origin;
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: "#f6f5f2",
    title: "Yunn Workbench",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url) && new URL(url).origin !== allowedOrigin) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin === allowedOrigin) return;
    event.preventDefault();
    if (isExternalUrl(url)) void shell.openExternal(url);
  });
  await window.loadURL(workbenchServer.url);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) {
      void createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    try {
      await createWindow();
    } catch (error) {
      dialog.showErrorBox("Yunn Workbench 启动失败", String((error as Error).stack || error));
      app.quit();
    }
  });

  app.on("activate", () => {
    if (!mainWindow) void createWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    if (quitting) return;
    quitting = true;
    const server = workbenchServer;
    workbenchServer = null;
    if (server) void server.close();
  });
}
