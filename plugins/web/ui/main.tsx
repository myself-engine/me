// Web UI shell: bootstrap, the WebSocket and routing. No tabs: the sidebar owns the
// conversation list and the settings entry; #/task/<id> is a panel over the
// conversation and #/settings is a modal. Old routes redirect in routes.ts.
import { StrictMode, useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import { Connection, fetchBootstrap } from "./api.ts";
import { ChatScreen } from "./chat.tsx";
import { AppContext, useApp as useAppCtx, type Ctx } from "./context.ts";
import { HarnessScreen } from "./harness.tsx";
import { chatHref, go, isDeep, NEW_THREAD, replace, settingsCloseHref, useRoute, type Route } from "./routes.ts";
import { SettingsModal } from "./settings.tsx";
import { initial, reducer, type HeadChoice } from "./state.ts";
import { TaskPanel } from "./tasks.tsx";
import { TraceDrawer } from "./timeline.tsx";

function App() {
  const [s, dispatch] = useReducerSafe();
  const [conn, setConn] = useState<Connection | null>(null);
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [project, setProject] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<{ traceId: string; messageId?: string } | null>(null);
  const route = useRoute();
  // The conversation screen settings opened from; closing settings goes back here.
  // Stays null on a direct load of #/settings, which closes to plain chat.
  const [returnHash, setReturnHash] = useState<string | null>(null);
  useEffect(() => {
    if (route.view !== "settings") setReturnHash(location.hash || null);
  }, [route]);

  useEffect(() => {
    let alive = true;
    fetchBootstrap()
      .then((data) => {
        if (!alive) return;
        dispatch({ type: "bootstrap", data });
        setProject(data.config.defaultProject || data.config.projects[0] || "");
        const c = new Connection(data.token);
        c.onStatus = setStatus;
        c.onMessage = (msg) => dispatch({ type: "server", msg });
        c.connect();
        setConn(c);
      })
      .catch((err) => alive && setLoadError(err.message));
    return () => {
      alive = false;
    };
  }, []);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 6000);
  }, []);

  const openTrace = useCallback((traceId: string, messageId?: string) => setDrawer({ traceId, messageId }), []);
  const closeTrace = useCallback(() => setDrawer(null), []);
  const ctx: Ctx = useMemo(() => ({ s, conn, notify, openTrace }), [s, conn, notify, openTrace]);

  const threadId = route.view === "chat" ? route.threadId : route.view === "task" ? route.threadId : null;
  const openId = threadId !== NEW_THREAD ? threadId : null;

  // A new thread's id arrives in the first op update of its first message; swap the screen to it without a history entry.
  const [pendingTrace, setPendingTrace] = useState<string | null>(null);
  useEffect(() => {
    const id = pendingTrace ? s.live[pendingTrace]?.threadId : undefined;
    if (id) {
      setPendingTrace(null);
      replace(chatHref(id));
    }
  }, [pendingTrace, s.live]);

  const send = async (text: string, choice?: HeadChoice) => {
    if (!conn) return;
    try {
      const res = await conn.request<{ traceId: string }>("chat.send", { threadId: openId ?? undefined, text, project: project || undefined, ...choice });
      if (!openId) setPendingTrace(res.traceId);
    } catch (err: any) {
      notify(err.message);
    }
  };

  return (
    <AppContext.Provider value={ctx}>
      <div className={`app side${isDeep(route) ? " deep" : ""}`}>
        <a className="skip" href="#main" onClick={skipToMain}>
          본문으로 건너뛰기
        </a>
        <main className="screen" id="main" tabIndex={-1}>
          <div role="status">{status === "closed" && <div className="conn-banner">연결이 끊겼어요 · 다시 연결하는 중…</div>}</div>
          {loadError ? (
            <div className="empty">
              <p className="empty-title">불러오지 못했어요</p>
              <p className="empty-sub">{loadError}</p>
            </div>
          ) : !s.ready ? (
            <div className="empty">
              <p className="empty-sub">불러오는 중…</p>
            </div>
          ) : (
            <Screen route={route} threadId={threadId} returnHash={returnHash} project={project} setProject={setProject} onSend={send} />
          )}
        </main>
        {drawer && <TraceDrawer key={drawer.traceId} traceId={drawer.traceId} messageId={drawer.messageId} onClose={closeTrace} />}
        {/* Always mounted so screen readers hear each toast; positioned out of the grid either way. */}
        <div className={toast ? "toast" : "sr"} role="status" aria-live="polite">
          {toast}
        </div>
      </div>
    </AppContext.Provider>
  );
}

import { useReducer } from "react";
function useReducerSafe() {
  return useReducer(reducer, initial);
}

/** Hash routing owns location.hash, so the skip link moves focus itself instead of navigating to #main. */
function skipToMain(e: MouseEvent) {
  e.preventDefault();
  document.getElementById("main")?.focus();
}

function Screen({ route, threadId, returnHash, project, setProject, onSend }: { route: Route; threadId: string | null; returnHash: string | null; project: string; setProject: (p: string) => void; onSend: (t: string, choice?: HeadChoice) => void }) {
  const chat = <ChatScreen threadId={threadId} project={project} setProject={setProject} onSend={onSend} />;
  switch (route.view) {
    case "task":
      return <TaskView route={route} project={project} setProject={setProject} onSend={onSend} />;
    case "settings":
      // Harness shot fakes keep their standalone page so screenshots match the old layout.
      if (route.section === "harness" && route.fake) return <HarnessScreen fake={route.fake} />;
      // Closing (button, scrim, Escape) goes back to the conversation or task panel
      // settings opened from; a direct load of #/settings closes to plain chat.
      return (
        <>
          {chat}
          <SettingsModal section={route.section} fake={route.fake} onClose={() => go(settingsCloseHref(returnHash))} />
        </>
      );
    default:
      return chat;
  }
}

/** A task panel over the conversation it came from (alerts and links land here). */
function TaskView({ route, project, setProject, onSend }: { route: Extract<Route, { view: "task" }>; project: string; setProject: (p: string) => void; onSend: (t: string, choice?: HeadChoice) => void }) {
  const { s } = useAppCtx();
  const from = route.threadId ?? Object.values(s.messages).find((m) => m.taskId === route.taskId)?.threadId ?? null;
  return (
    <>
      <ChatScreen threadId={from} project={project} setProject={setProject} onSend={onSend} />
      <TaskPanel taskId={route.taskId} onClose={() => go(chatHref(from))} />
    </>
  );
}

// PWA links are added here, not in index.html: Bun's HTML bundler tries to resolve every <link href> at build time,
// while these paths are served by server.ts (src/pwa.ts).
for (const [rel, href] of [["manifest", "/manifest.webmanifest"], ["icon", "/icon.svg"], ["apple-touch-icon", "/icon.svg"]]) {
  const link = document.createElement("link");
  link.rel = rel!;
  link.href = href!;
  document.head.append(link);
}

// Push notifications need a worker at the root scope; /sw.js is served verbatim by server.ts, never bundled.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
