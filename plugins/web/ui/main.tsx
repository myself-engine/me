// Web UI shell: bootstrap, the WebSocket, navigation (left rail on desktop, bottom tabs on phones) and routing.
import { StrictMode, useCallback, useEffect, useMemo, useReducer, useState, type MouseEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Connection, fetchBootstrap } from "./api.ts";
import { ChatScreen } from "./chat.tsx";
import { AppContext, type Ctx } from "./context.ts";
import { downCount, OpsScreen } from "./ops.tsx";
import { HarnessScreen } from "./harness.tsx";
import { chatHref, isDeep, NEW_THREAD, replace, useRoute, type Route, type Tab } from "./routes.ts";
import { initial, isDelegationApproval, reducer, toneOf, workItems, type HeadChoice } from "./state.ts";
import { TasksScreen } from "./tasks.tsx";
import { TraceDrawer } from "./timeline.tsx";

const ICONS: Record<Tab, ReactNode> = {
  chat: <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4A1.5 1.5 0 0 1 4 14.5z" />,
  tasks: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M3.5 6l1.2 1.2L7 5M3.5 12l1.2 1.2L7 11M3.5 18l1.2 1.2L7 17" />
    </>
  ),
  ops: <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />,
};

const TABS: { tab: Tab; label: string; href: string }[] = [
  { tab: "chat", label: "대화", href: "#/chat" },
  { tab: "tasks", label: "작업", href: "#/tasks" },
  { tab: "ops", label: "상태", href: "#/ops" },
];

function App() {
  const [s, dispatch] = useReducer(reducer, initial);
  const [conn, setConn] = useState<Connection | null>(null);
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [project, setProject] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<{ traceId: string; messageId?: string } | null>(null);
  const route = useRoute();

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

  const threadId = route.tab === "chat" && route.threadId !== NEW_THREAD ? route.threadId : null;

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
      const res = await conn.request<{ traceId: string }>("chat.send", { threadId: threadId ?? undefined, text, project: project || undefined, ...choice });
      if (!threadId) setPendingTrace(res.traceId);
    } catch (err: any) {
      notify(err.message);
    }
  };

  // One number, on 작업: delegations needing you plus other approval requests. 상태 only gets a dot when something is down.
  const needs = useMemo(
    () => workItems(s).filter((w) => toneOf(w.state) === "needs").length + Object.values(s.approvals).filter((a) => !isDelegationApproval(a)).length,
    [s.tasks, s.approvals, s.messages],
  );
  const down = useMemo(() => downCount(Object.values(s.checks), Object.values(s.plugins)), [s.checks, s.plugins]);
  const mark = (tab: Tab): { label: string; badge: ReactNode } | null => {
    if (tab === "tasks" && needs > 0)
      return {
        label: `확인 필요 ${needs}`,
        badge: (
          <span className="badge" aria-hidden="true">
            {needs}
          </span>
        ),
      };
    if (tab === "ops" && down > 0) return { label: "문제 있음", badge: <span className="badge-dot" aria-hidden="true" /> };
    return null;
  };

  return (
    <AppContext.Provider value={ctx}>
      <div className={`app${isDeep(route) ? " deep" : ""}`}>
        <a className="skip" href="#main" onClick={skipToMain}>
          본문으로 건너뛰기
        </a>
        <nav className="nav" aria-label="화면">
          <div className="brand" title={s.viewer ? `Tailscale로 접속: ${s.viewer.login}` : "이 Mac에서 접속"}>
            <span className="logo" aria-hidden="true">
              ◐
            </span>
            <span className="brand-name">me</span>
          </div>
          {TABS.map((t) => {
            const m = mark(t.tab);
            return (
              <a
                key={t.tab}
                className={`nav-item${route.tab === t.tab ? " on" : ""}`}
                href={t.href}
                aria-current={route.tab === t.tab ? "page" : undefined}
                aria-label={m ? `${t.label}, ${m.label}` : undefined}
              >
                <span className="nav-icon">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {ICONS[t.tab]}
                  </svg>
                  {m?.badge}
                </span>
                <span className="nav-label">{t.label}</span>
              </a>
            );
          })}
          {s.viewer && <div className="nav-viewer">{s.viewer.name}</div>}
        </nav>
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
            <Screen route={route} project={project} setProject={setProject} onSend={send} />
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

/** Hash routing owns location.hash, so the skip link moves focus itself instead of navigating to #main. */
function skipToMain(e: MouseEvent) {
  e.preventDefault();
  document.getElementById("main")?.focus();
}

function Screen({ route, ...chat }: { route: Route; project: string; setProject: (p: string) => void; onSend: (t: string, choice?: HeadChoice) => void }) {
  switch (route.tab) {
    case "chat":
      return <ChatScreen threadId={route.threadId} {...chat} />;
    case "tasks":
      return <TasksScreen taskId={route.taskId} project={route.project} />;
    case "ops":
      return route.view === "harness" ? <HarnessScreen fake={route.fake} /> : <OpsScreen />;
  }
}

// PWA links are added here, not in index.html: Bun's HTML bundler tries to resolve every <link href> at build time,
// while these paths are served by server.ts (src/pwa.ts).
for (const [rel, href] of [["manifest", "/manifest.webmanifest"], ["icon", "/icon.svg"], ["apple-touch-icon", "/icon.svg"]]) {
  const link = document.createElement("link");
  link.rel = rel!;
  link.href = href!;
  document.head.append(link);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
