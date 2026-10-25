export type AppView =
  | "items"
  | "feeds"
  | "topics"
  | "drafts"
  | "boards"
  | "books"
  | "tasks"
  | "settings"
  | "toolbox";

export interface AppRoute {
  view: AppView;
  toolId: string | null;
}

const VIEW_PATH: Record<Exclude<AppView, "toolbox">, string> = {
  items: "/",
  feeds: "/feeds",
  topics: "/topics",
  drafts: "/drafts",
  boards: "/boards",
  books: "/books",
  tasks: "/tasks",
  settings: "/settings",
};

function stripTrailingSlash(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.replace(/\/+$/, "");
  return pathname;
}

export function parsePath(pathname: string): AppRoute {
  const path = stripTrailingSlash(pathname);
  if (path === "/toolbox") return { view: "toolbox", toolId: null };
  if (path.startsWith("/toolbox/")) {
    const toolId = decodeURIComponent(path.slice("/toolbox/".length));
    return { view: "toolbox", toolId: toolId || null };
  }
  const match = (Object.entries(VIEW_PATH) as [Exclude<AppView, "toolbox">, string][])
    .find(([, viewPath]) => viewPath === path);
  if (match) return { view: match[0], toolId: null };
  return { view: "items", toolId: null };
}

export function pathFor(route: AppRoute): string {
  if (route.view === "toolbox") {
    return route.toolId ? `/toolbox/${encodeURIComponent(route.toolId)}` : "/toolbox";
  }
  return VIEW_PATH[route.view];
}
