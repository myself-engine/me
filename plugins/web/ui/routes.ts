// Hash routing: #/chat, #/chat/:threadId, #/task/:taskId (panel over the conversation), #/settings.
// Old links redirect: #/tasks → #/chat, #/tasks/:id → #/task/:id, #/approvals → #/chat,
// #/ops and #/projects → #/settings, #/ops/harness → #/settings/harness (fakes preserved for shots).
// Every screen change is a hash change, so the browser's back button walks the screen stack.
import { useMemo, useSyncExternalStore } from "react";

export type Route =
  | { view: "chat"; threadId: string | null }
  | { view: "task"; taskId: string; threadId: string | null }
  | { view: "settings"; section: string | null; fake: string | null };

/** Thread id used for the phone's "new conversation" screen (desktop shows it at #/chat). */
export const NEW_THREAD = "new";

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const [path = "", query = ""] = raw.split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const q = new URLSearchParams(query);
  switch (parts[0]) {
    case "task":
      return { view: "task", taskId: parts[1] ?? "", threadId: q.get("thread") };
    case "tasks":
      if (parts[1]) return { view: "task", taskId: parts[1], threadId: q.get("thread") };
      return { view: "chat", threadId: null };
    case "settings":
      return { view: "settings", section: parts[1] ?? null, fake: q.get("fake") };
    case "ops":
      if (parts[1] === "harness") return { view: "settings", section: "harness", fake: q.get("fake") };
      return { view: "settings", section: null, fake: null };
    case "approvals":
    case "chat":
      return { view: "chat", threadId: parts[0] === "chat" ? (parts[1] ?? null) : null };
    case "projects":
      return { view: "settings", section: "projects", fake: null };
    default:
      return { view: "chat", threadId: parts[0] === "chat" ? (parts[1] ?? null) : null };
  }
}

/** True when the route is a detail screen (phones hide the sidebar and show a back button). */
export const isDeep = (r: Route) => (r.view === "chat" && r.threadId !== null) || r.view === "task" || (r.view === "settings" && r.section !== null);

export const chatHref = (threadId?: string | null) => (threadId ? `#/chat/${encodeURIComponent(threadId)}` : "#/chat");
export const taskHref = (taskId?: string | null, _project?: string | null) => (taskId ? `#/task/${encodeURIComponent(taskId)}` : "#/chat");

/** 실행 도구 설정 lives in the settings modal; its shot fakes (fake=empty|list|diff) render canned data. */
export const harnessHref = (fake?: string | null) => (fake ? `#/settings/harness?fake=${encodeURIComponent(fake)}` : "#/settings/harness");
export const settingsHref = (section?: string | null) => (section ? `#/settings/${encodeURIComponent(section)}` : "#/settings");

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
