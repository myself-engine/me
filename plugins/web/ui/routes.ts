// Hash routing: #/chat, #/chat/:threadId, #/tasks, #/tasks/:taskId?project=, #/approvals, #/ops, #/projects.
// Every screen change is a hash change, so the browser's back button walks the screen stack.
import { useMemo, useSyncExternalStore } from "react";

export type Tab = "chat" | "tasks" | "approvals" | "ops" | "projects";

export type Route =
  | { tab: "chat"; threadId: string | null }
  | { tab: "tasks"; taskId: string | null; project: string | null }
  | { tab: "approvals" }
  | { tab: "ops" }
  | { tab: "projects" };

/** Thread id used for the phone's "new conversation" screen (desktop shows it at #/chat). */
export const NEW_THREAD = "new";

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const [path = "", query = ""] = raw.split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const q = new URLSearchParams(query);
  switch (parts[0]) {
    case "tasks":
      return { tab: "tasks", taskId: parts[1] ?? null, project: q.get("project") || null };
    case "approvals":
      return { tab: "approvals" };
    case "ops":
      return { tab: "ops" };
    case "projects":
      return { tab: "projects" };
    default:
      return { tab: "chat", threadId: parts[0] === "chat" ? (parts[1] ?? null) : null };
  }
}

/** True when the route is a detail screen (phones hide the tab bar and show a back button). */
export const isDeep = (r: Route) => (r.tab === "chat" && r.threadId !== null) || (r.tab === "tasks" && r.taskId !== null);

export const chatHref = (threadId?: string | null) => (threadId ? `#/chat/${encodeURIComponent(threadId)}` : "#/chat");
export const taskHref = (taskId?: string | null, project?: string | null) =>
  `#/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ""}${project ? `?project=${encodeURIComponent(project)}` : ""}`;

/** Pushes a new screen. */
export const go = (href: string) => {
  location.hash = href.replace(/^#/, "");
};

/** Swaps the current screen without adding history (e.g. a new thread getting its id). */
export const replace = (href: string) => {
  history.replaceState(history.state, "", href);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
};

const subscribe = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => location.hash);
  return useMemo(() => parseRoute(hash), [hash]);
}
