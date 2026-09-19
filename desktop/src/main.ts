import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  session,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface DesktopServer {
  url: string;
  close: () => Promise<void>;
}

let mainWindow: BrowserWindow | null = null;
let workbenchServer: DesktopServer | null = null;
let quitting = false;
const appName = "Yunn Workbench";

app.setName(appName);

function configureApplicationMenu(): void {
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
          label: appName,
          submenu: [
            { role: "about", label: `关于 ${appName}` },
            { type: "separator" },
            { role: "services", label: "服务" },
            { type: "separator" },
            { role: "hide", label: `隐藏 ${appName}` },
            { role: "hideOthers", label: "隐藏其他应用" },
            { role: "unhide", label: "全部显示" },
            { type: "separator" },
            { role: "quit", label: `退出 ${appName}` },
          ],
        } satisfies MenuItemConstructorOptions]
      : []),
    {
      label: "文件",
      submenu: [
        isMac
          ? { role: "close", label: "关闭窗口" }
          : { role: "quit", label: `退出 ${appName}` },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        ...(isMac
          ? [{ role: "pasteAndMatchStyle", label: "粘贴并匹配样式" } satisfies MenuItemConstructorOptions]
          : []),
        { role: "delete", label: "删除" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "显示",
      submenu: [
        { role: "reload", label: "重新加载" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "进入全屏" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "zoom", label: "缩放" },
        ...(isMac
          ? [
              { type: "separator" } satisfies MenuItemConstructorOptions,
              { role: "front", label: "前置全部窗口" } satisfies MenuItemConstructorOptions,
            ]
          : [{ role: "close", label: "关闭窗口" } satisfies MenuItemConstructorOptions]),
      ],
    },
    {
      role: "help",
      label: "帮助",
      submenu: [
        {
          label: "查看项目主页",
          click: () => void shell.openExternal("https://github.com/Yunshiro/yunn-workbench"),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

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
    icon: join(app.getAppPath(), "assets", "icon.png"),
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
    if (process.platform === "darwin") {
      app.dock?.setIcon(join(app.getAppPath(), "assets", "icon.png"));
      app.setAboutPanelOptions({
        applicationName: appName,
        applicationVersion: app.getVersion(),
      });
    }
    configureApplicationMenu();
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
