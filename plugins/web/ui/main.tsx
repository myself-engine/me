import { StrictMode, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Connection, fetchBootstrap, type Approval, type Bootstrap, type Message, type OpsCheck, type PluginInfo, type ServerMsg, type Task, type Thread } from "./api.ts";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface Live {
  messageId?: string;
  threadId?: string;
  text: string;
  thoughts: string;
  tools: { id: string; name: string; intent?: string; ok?: boolean }[];
  done: boolean;
  error?: string;
}

interface State {
  ready: boolean;
  threads: Record<string, Thread>;
  messages: Record<string, Message>;
  tasks: Record<string, Task>;
  plugins: Record<string, PluginInfo>;
  checks: Record<string, OpsCheck>;
  approvals: Record<string, Approval>;
  live: Record<string, Live>; // by traceId
  config: Bootstrap["config"];
  viewer: Bootstrap["viewer"];
}

type Action =
  | { type: "bootstrap"; data: Bootstrap }
  | { type: "server"; msg: ServerMsg }
  | { type: "approvalGone"; approvalId: string };

const byId = <T,>(xs: T[], key: keyof T) => Object.fromEntries(xs.map((x) => [x[key] as string, x]));
const emptyLive = (): Live => ({ text: "", thoughts: "", tools: [], done: false });

function reducer(s: State, a: Action): State {
  if (a.type === "bootstrap") {
    return {
      ...s,
      ready: true,
      threads: byId(a.data.threads, "id"),
      messages: byId(a.data.messages, "id"),
      tasks: byId(a.data.tasks, "taskId"),
      plugins: byId(a.data.plugins, "id"),
      checks: Object.fromEntries((a.data.checks ?? []).map((c) => [`${c.source ?? "ops"}/${c.id}`, c])),
      approvals: byId(a.data.approvals, "approvalId"),
      config: a.data.config,
      viewer: a.data.viewer ?? null,
    };
  }
  if (a.type === "approvalGone") {
    const approvals = { ...s.approvals };
    delete approvals[a.approvalId];
    return { ...s, approvals };
  }
  const m = a.msg;
  switch (m.type) {
    case "entity": {
      if (m.kind === "gjc-head.thread") return { ...s, threads: { ...s.threads, [m.id]: m.data } };
      if (m.kind === "gjc-head.message") return { ...s, messages: { ...s.messages, [m.id]: m.data } };
      if (m.kind === "brgr.task") return { ...s, tasks: { ...s.tasks, [m.id]: m.data } };
      if (m.kind === "kernel.plugin") return { ...s, plugins: { ...s.plugins, [m.id]: m.data } };
      if (m.kind === "ops.check") return { ...s, checks: { ...s.checks, [m.id]: m.data } };
      return s;
    }
    case "approval": {
      const approvals = { ...s.approvals };
      if (m.event === "kernel.approval.pending") approvals[m.data.approvalId] = m.data;
      else delete approvals[m.data.approvalId];
      return { ...s, approvals };
    }
    case "op.update": {
      const cur = s.live[m.traceId] ?? emptyLive();
      const u = m.update;
      const next: Live = { ...cur, tools: cur.tools };
      if (u.kind === "text_delta") next.text += u.delta;
      else if (u.kind === "thought_delta") next.thoughts += u.delta;
      else if (u.kind === "message") next.messageId = u.messageId;
      else if (u.kind === "thread") next.threadId = u.threadId;
      else if (u.kind === "tool_call") next.tools = [...cur.tools, { id: u.toolCallId, name: u.toolName, intent: u.intent }];
      else if (u.kind === "tool_result") next.tools = cur.tools.map((t) => (t.id === u.toolCallId ? { ...t, ok: u.ok } : t));
      else if (u.kind === "error") next.error = u.message;
      return { ...s, live: { ...s.live, [m.traceId]: next } };
    }
    case "op.end": {
      const cur = s.live[m.traceId] ?? emptyLive();
      return { ...s, live: { ...s.live, [m.traceId]: { ...cur, done: true, error: m.error ?? cur.error } } };
    }
    default:
      return s;
  }
}

const initial: State = {
  ready: false,
  threads: {},
  messages: {},
  tasks: {},
  plugins: {},
  checks: {},
  approvals: {},
  live: {},
  config: { projects: [], defaultProject: "", githubRepo: null },
  viewer: null,
};

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

const STATE_LABEL: Record<string, string> = {
  "awaiting-approval": "승인 대기",
  rejected: "거절됨",
  delegated: "위임됨",
  running: "작업 중",
  sealed: "결과 도착",
  accepted: "수락함",
  applied: "적용·커밋됨",
  "apply-failed": "적용 실패",
  failed: "실패",
  "awaiting-input": "입력 대기",
  cancelled: "취소됨",
  starting: "시작 중",
  stopped: "멈춤",
  quarantined: "격리됨",
};

const PLUGIN_LABEL: Record<string, string> = { running: "실행 중", starting: "시작 중", stopped: "멈춤", quarantined: "격리됨" };

function Pill({ state, plugin = false }: { state: string; plugin?: boolean }) {
  const label = (plugin ? PLUGIN_LABEL[state] : undefined) ?? STATE_LABEL[state] ?? state;
  return <span className={`pill pill-${state}${plugin && state === "running" ? " pill-sealed" : ""}`}>{label}</span>;
}

function shortPath(p: string) {
  const home = p.replace(/^\/Users\/[^/]+/, "~");
  const parts = home.split("/").filter(Boolean);
  return parts.length <= 2 ? home : `…/${parts.slice(-2).join("/")}`;
}

function timeAgo(iso: string) {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return "방금";
  if (d < 3600) return `${Math.floor(d / 60)}분 전`;
  if (d < 86400) return `${Math.floor(d / 3600)}시간 전`;
  return `${Math.floor(d / 86400)}일 전`;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  const [s, dispatch] = useReducer(reducer, initial);
  const [conn, setConn] = useState<Connection | null>(null);
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const [view, setView] = useState<"chat" | "overview">("chat");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [project, setProject] = useState<string>("");
  const [toast, setToast] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchBootstrap().then((data) => {
      if (!alive) return;
      dispatch({ type: "bootstrap", data });
      setProject(data.config.defaultProject || data.config.projects[0] || "");
      const c = new Connection(data.token);
      c.onStatus = setStatus;
      c.onMessage = (msg) => dispatch({ type: "server", msg });
      c.connect();
      setConn(c);
    });
    return () => {
      alive = false;
    };
  }, []);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 6000);
  }, []);

  const threads = useMemo(() => Object.values(s.threads).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [s.threads]);
  const pendingCount = Object.keys(s.approvals).length;

  const send = async (text: string) => {
    if (!conn) return;
    try {
      const res = await conn.request<{ traceId: string }>("chat.send", { threadId: threadId ?? undefined, text, project: project || undefined });
      if (!threadId) setPendingTrace(res.traceId);
    } catch (err: any) {
      notify(err.message);
    }
  };

  // A new thread's id arrives in the first op update of its first message.
  const [pendingTrace, setPendingTrace] = useState<string | null>(null);
  useEffect(() => {
    const id = pendingTrace ? s.live[pendingTrace]?.threadId : undefined;
    if (id) {
      setThreadId(id);
      setPendingTrace(null);
    }
  }, [pendingTrace, s.live]);

  return (
    <div className={`app ${navOpen ? "nav-open" : ""}`} onKeyDown={(e) => e.key === "Escape" && setNavOpen(false)}>
      {navOpen && <div className="scrim" onClick={() => setNavOpen(false)} />}
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">◐</span> me
          {s.viewer && (
            <span className="viewer" title={`Tailscale로 접속: ${s.viewer.login}`}>
              {s.viewer.name}
            </span>
          )}
          <span className={`conn conn-${status}`} title={status} />
        </div>
        <nav className="tabs">
          <button
            className={view === "chat" ? "on" : ""}
            onClick={() => {
              setView("chat");
              setNavOpen(false);
            }}
          >
            채팅
          </button>
          <button
            className={view === "overview" ? "on" : ""}
            onClick={() => {
              setView("overview");
              setNavOpen(false);
            }}
          >
            한눈에 보기 {pendingCount > 0 && <span className="count">{pendingCount}</span>}
          </button>
        </nav>
        <button
          className="new-thread"
          onClick={() => {
            setThreadId(null);
            setView("chat");
            setNavOpen(false);
          }}
        >
          + 새 대화
        </button>
        <ul className="threads">
          {threads.map((t) => (
            <li key={t.id}>
              <button
                className={t.id === threadId ? "on" : ""}
                onClick={() => {
                  setThreadId(t.id);
                  setView("chat");
                  setNavOpen(false);
                }}
              >
                <span className="t-title">{t.title || "(제목 없음)"}</span>
                <span className="t-meta">
                  {shortPath(t.project).split("/").pop()} · {timeAgo(t.updatedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="hamburger" onClick={() => setNavOpen((v) => !v)} aria-label="메뉴">
            ☰
          </button>
          <span className="top-title">{view === "overview" ? "한눈에 보기" : threadId ? s.threads[threadId]?.title : "새 대화"}</span>
        </header>
        {!s.ready ? (
          <div className="empty">불러오는 중…</div>
        ) : view === "overview" ? (
          <Overview s={s} conn={conn} notify={notify} />
        ) : (
          <Chat
            s={s}
            threadId={threadId}
            conn={conn}
            notify={notify}
            onSend={send}
            project={project}
            setProject={setProject}
          />
        )}
      </main>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

function Chat(props: {
  s: State;
  threadId: string | null;
  conn: Connection | null;
  notify: (m: string) => void;
  onSend: (text: string) => void;
  project: string;
  setProject: (p: string) => void;
}) {
  const { s, threadId } = props;
  const messages = useMemo(
    () => Object.values(s.messages).filter((m) => m.threadId === threadId).sort((a, b) => a.ts.localeCompare(b.ts)),
    [s.messages, threadId],
  );
  const endRef = useRef<HTMLDivElement>(null);
  const lastLen = messages.length + (messages.at(-1) ? (s.live[messages.at(-1)!.traceId]?.text.length ?? 0) : 0);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lastLen]);
  const thread = threadId ? s.threads[threadId] : null;
  const projects = [...new Set([props.project, ...s.config.projects].filter(Boolean))];

  return (
    <div className="chat">
      <div className="scroll">
        {messages.length === 0 && (
          <div className="hello">
            <h2>무엇을 할까요?</h2>
            <p>간단한 건 바로 답하고, 작업이 필요하면 맞는 하네스에 위임할게요.</p>
          </div>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="msg user">
              <div className="bubble">{m.text}</div>
            </div>
          ) : (
            <AssistantMessage key={m.id} m={m} s={s} conn={props.conn} notify={props.notify} />
          ),
        )}
        <div ref={endRef} />
      </div>
      <Composer
        onSend={props.onSend}
        disabled={!props.conn}
        project={thread?.project ?? props.project}
        projects={projects}
        lockProject={!!thread}
        setProject={props.setProject}
      />
    </div>
  );
}

function AssistantMessage({ m, s, conn, notify }: { m: Message; s: State; conn: Connection | null; notify: (x: string) => void }) {
  const live = s.live[m.traceId];
  const text = m.text || live?.text || "";
  const streaming = m.status === "pending" || m.status === "streaming";
  const approval = Object.values(s.approvals).find((a) => a.payload?.messageId === m.id);
  const task = m.taskId ? s.tasks[m.taskId] : undefined;
  const [showThoughts, setShowThoughts] = useState(false);

  const fileIssue = async () => {
    const note = prompt("무엇이 이상했나요? (한 줄)");
    if (note === null || !conn) return;
    try {
      const r = await conn.request("issue.create", { traceId: m.traceId, messageId: m.id, note });
      notify(r.url ? `이슈를 만들었어요: ${r.url}` : "저장소가 설정되지 않아 이슈 내용만 만들었어요");
    } catch (err: any) {
      notify(err.message);
    }
  };

  return (
    <div className="msg assistant">
      <div className="meta-row">
        {m.understood && m.understood.replaced.length > 0 && (
          <span className="chip soft" title={m.understood.replaced.map((r) => `${r.from}→${r.to}`).join(", ")}>
            이렇게 이해했어요: {m.understood.normalized}
          </span>
        )}
        {m.judgement && (
          <span
            className={`chip route ${m.route === "direct" ? "direct" : "delegate"}`}
            title={`간단함 ${Math.round(m.judgement.simpleProb * 100)}% · ${
              m.judgement.source === "fast-path" ? "빠른 답변" : m.judgement.source === "fallback" ? "대체 판정" : "Jev"
            } · ${m.judgement.model}`}
          >
            {m.route === "direct" ? "직접 답변" : "위임"}
            {m.judgement.source === "fallback" && <span className="warn-dot" aria-label="대체 판정" />}
          </span>
        )}
        {streaming && !m.judgement && <span className="chip soft pulse">판단 중…</span>}
      </div>

      {live && live.thoughts && (
        <button className="link" onClick={() => setShowThoughts((v) => !v)}>
          {showThoughts ? "생각 접기" : "생각 보기"}
        </button>
      )}
      {showThoughts && live?.thoughts && <pre className="thoughts">{live.thoughts}</pre>}

      {live?.tools.map((t) => (
        <details key={t.id} className="card tool">
          <summary>
            🔧 {t.name} {t.intent ? `— ${t.intent}` : ""} {t.ok === false ? "⚠️" : ""}
          </summary>
        </details>
      ))}

      {text && (
        <div className="bubble">
          <Markdown text={text} />
          {m.status === "streaming" && <span className="caret" />}
        </div>
      )}

      {m.delegation && <DelegationCard m={m} approval={approval} task={task} conn={conn} notify={notify} />}

      {(m.error || live?.error) && <div className="card error">⚠️ {m.error ?? live?.error}</div>}

      <div className="actions">
        <button className="link" onClick={fileIssue} title="이 대화의 기록을 붙여 GitHub 이슈로 올려요">
          문제 신고
        </button>
      </div>
    </div>
  );
}

/** The worker's own words, labeled and collapsible; a trailing unfenced diff is rendered as a diff block. */
function WorkerReport({ text }: { text: string }) {
  const at = text.search(/\n?diff --git /);
  const prose = at >= 0 ? text.slice(0, at).trim() : text;
  const diff = at >= 0 && !text.slice(0, at).includes("```") ? text.slice(at).trim() : null;
  const long = text.length > 600;
  const [open, setOpen] = useState(!long);
  return (
    <div className="result">
      <div className="result-label">워커 보고</div>
      <div className={open ? "" : "clamp"}>
        <Markdown text={prose} />
        {diff && <Markdown text={"```diff\n" + diff + "\n```"} />}
      </div>
      {long && (
        <button className="link" onClick={() => setOpen((v) => !v)}>
          {open ? "접기" : "더 보기"}
        </button>
      )}
    </div>
  );
}

function DelegationCard({ m, approval, task, conn, notify }: { m: Message; approval?: Approval; task?: Task; conn: Connection | null; notify: (x: string) => void }) {
  const d = m.delegation!;
  const [diff, setDiff] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err: any) {
      notify(err.message);
    } finally {
      setBusy(false);
    }
  };
  const state = task?.state ?? d.state;
  const suggested: string = approval?.payload?.harness ?? d.harness;
  const harnesses: string[] = Array.isArray(approval?.payload?.harnesses) ? approval.payload.harnesses : [suggested];
  const [picked, setPicked] = useState<string | null>(null);
  const harness = picked ?? suggested;
  const short = (h: string) => h.replace(/^local\./, "");

  return (
    <div className="card delegation">
      <div className="card-head">
        {approval && conn ? (
          <select className="harness" value={harness} disabled={busy} onChange={(e) => setPicked(e.target.value)} title="위임할 하네스">
            {(harnesses.includes(harness) ? harnesses : [harness, ...harnesses]).map((h) => (
              <option key={h} value={h}>
                {short(h)}
                {h === suggested ? " (추천)" : ""}
              </option>
            ))}
          </select>
        ) : (
          <span className="harness" title={d.suggestedHarness ? `추천: ${short(d.suggestedHarness)}` : undefined}>
            {short(d.harness)}
            {d.suggestedHarness ? " · 직접 선택" : ""}
          </span>
        )}
        <Pill state={state} />
      </div>
      <details>
        <summary>지시 내용</summary>
        <p className="brief">{d.brief}</p>
        {d.criterion && <p className="brief">완료 기준: {d.criterion}</p>}
      </details>

      {approval && conn && (
        <div className="row">
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              act(() =>
                conn.request("approval.decide", {
                  approvalId: approval.approvalId,
                  decision: "approve",
                  ...(harness !== suggested ? { amend: { harness } } : {}),
                }),
              )
            }
          >
            승인하고 위임
          </button>
          <button disabled={busy} onClick={() => act(() => conn.request("approval.decide", { approvalId: approval.approvalId, decision: "reject" }))}>
            거절
          </button>
        </div>
      )}

      {task?.resultText && <WorkerReport text={task.resultText} />}
      {task?.error && <div className="card error">⚠️ {task.error}</div>}
      {task?.commitSha && (
        <div className="outcome" title={task.project}>
          ✓ 커밋 {task.commitSha.slice(0, 8)} · {shortPath(task.project)}
        </div>
      )}

      {task && conn && (
        <div className="row">
          <button
            disabled={busy}
            onClick={() =>
              act(async () => {
                if (diff !== null) return setDiff(null);
                const r = await conn.request("task.diff", { taskId: task.taskId });
                setDiff(r.diff || r.error || "(변경 없음)");
              })
            }
          >
            {diff !== null ? "diff 닫기" : "diff 보기"}
          </button>
          {task.state === "sealed" && (
            <>
              <button className="primary" disabled={busy} onClick={() => act(() => conn.request("task.accept", { taskId: task.taskId }))}>
                수락
              </button>
              <button disabled={busy} onClick={() => act(() => conn.request("task.reject", { taskId: task.taskId }))}>
                거절
              </button>
            </>
          )}
        </div>
      )}
      {diff !== null && <Markdown text={"```diff\n" + diff + "\n```"} />}
    </div>
  );
}

function Composer(props: {
  onSend: (t: string) => void;
  disabled: boolean;
  project: string;
  projects: string[];
  lockProject: boolean;
  setProject: (p: string) => void;
}) {
  const [text, setText] = useState("");
  const submit = () => {
    const t = text.trim();
    if (!t || props.disabled) return;
    props.onSend(t);
    setText("");
  };
  return (
    <div className="composer">
      <div className="composer-top">
        {props.lockProject ? (
          <span className="project" title={props.project}>📁 {shortPath(props.project)}</span>
        ) : (
          <select value={props.project} onChange={(e) => props.setProject(e.target.value)} aria-label="프로젝트">
            {props.projects.map((p) => (
              <option key={p} value={p}>
                📁 {shortPath(p)}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="composer-box">
        <textarea
          value={text}
          placeholder="메시지 (Enter 전송, Shift+Enter 줄바꿈)"
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button className="primary send" onClick={submit} disabled={props.disabled || !text.trim()}>
          보내기
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

const CHECK_LABEL: Record<OpsCheck["status"], string> = { up: "정상", down: "응답 없음", unknown: "알 수 없음" };
const CHECK_ORDER: Record<OpsCheck["status"], number> = { down: 0, unknown: 1, up: 2 };

const machineOf = (source?: string) => (!source || source === "ops" ? "이 Mac" : source.replace(/^ops-/, ""));

function OpsChecks({ checks }: { checks: OpsCheck[] }) {
  if (checks.length === 0) return null;
  const down = checks.filter((c) => c.status === "down").length;
  // One group per machine; machines with something down come first.
  const groups = new Map<string, OpsCheck[]>();
  for (const c of checks) groups.set(machineOf(c.source), [...(groups.get(machineOf(c.source)) ?? []), c]);
  const ordered = [...groups.entries()].sort(
    ([a, xs], [b, ys]) =>
      Math.min(...xs.map((c) => CHECK_ORDER[c.status])) - Math.min(...ys.map((c) => CHECK_ORDER[c.status])) || a.localeCompare(b),
  );
  return (
    <section>
      <h3>
        운영 상태 {down > 0 && <span className="count bad">{down}</span>}
      </h3>
      {ordered.map(([machine, list]) => (
        <div key={machine} className="machine">
          {groups.size > 1 && (
            <div className="machine-label">
              {machine} · {list.filter((c) => c.status === "up").length}/{list.length} 정상
            </div>
          )}
          {list.some((c) => c.status === "up") && (
            <div className="up-chips" aria-label="정상">
              {list
                .filter((c) => c.status === "up")
                .sort((a, b) => a.id.localeCompare(b.id))
                .map((c) => (
                  <span key={`${c.source ?? "ops"}/${c.id}`} className="up-chip" title={`${c.kind} · ${c.latencyMs}ms · ${c.detail}`}>
                    <span className="dot dot-up" />
                    {c.id}
                  </span>
                ))}
            </div>
          )}
          {[...list]
            .filter((c) => c.status !== "up")
            .sort((a, b) => CHECK_ORDER[a.status] - CHECK_ORDER[b.status] || a.id.localeCompare(b.id))
            .map((c) => (
              <div key={`${c.source ?? "ops"}/${c.id}`} className={`card check check-${c.status}`}>
                <div className="card-head">
                  <span className={`dot dot-${c.status}`} title={CHECK_LABEL[c.status]} />
                  <strong>{c.id}</strong>
                  <span className="harness">{c.kind}</span>
                  <span className={`pill pill-check-${c.status}`}>{CHECK_LABEL[c.status]}</span>
                  <span className="sub right" title={`마지막 확인 ${new Date(c.checkedAt).toLocaleString()}`}>
                    {c.status === "up" && `${c.latencyMs}ms · `}
                    {timeAgo(c.since) === "방금" ? "방금 전부터" : `${timeAgo(c.since)}부터`}
                  </span>
                </div>
                <div className="sub check-detail">{c.detail}</div>
              </div>
            ))}
        </div>
      ))}
    </section>
  );
}

function Overview({ s, conn, notify }: { s: State; conn: Connection | null; notify: (m: string) => void }) {
  const plugins = Object.values(s.plugins).sort((a, b) => a.id.localeCompare(b.id));
  const tasks = Object.values(s.tasks).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const approvals = Object.values(s.approvals);
  const decide = async (a: Approval, decision: "approve" | "reject") => {
    try {
      await conn?.request("approval.decide", { approvalId: a.approvalId, decision });
    } catch (err: any) {
      notify(err.message);
    }
  };
  return (
    <div className="overview">
      <OpsChecks checks={Object.values(s.checks)} />

      {approvals.length > 0 && (
        <section>
          <h3>승인 대기</h3>
          {approvals.map((a) => (
            <div key={a.approvalId} className="card approval">
              <div className="card-head">
                <span>{a.summary}</span>
                <span className={`risk risk-${a.risk}`}>{a.risk}</span>
              </div>
              <div className="row">
                <button className="primary" onClick={() => decide(a, "approve")}>
                  승인
                </button>
                <button onClick={() => decide(a, "reject")}>거절</button>
              </div>
            </div>
          ))}
        </section>
      )}

      <section>
        <h3>플러그인</h3>
        <div className="grid">
          {plugins.map((p) => (
            <div key={p.id} className="card plugin">
              <div className="card-head">
                <span className={`dot dot-${p.state}`} />
                <strong>{p.id}</strong>
                {p.state !== "running" && <Pill state={p.state} plugin />}
              </div>
              <div className="sub">
                v{p.version} · pid {p.pid ?? "-"} · 재시작 {p.restarts}
              </div>
              <div className="perms">
                {p.permissions.length ? p.permissions.map((perm) => <span key={perm}>{perm}</span>) : <span>권한 없음</span>}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3>위임 작업</h3>
        {tasks.length === 0 && <p className="sub">아직 없어요.</p>}
        {tasks.map((t) => (
          <div key={t.taskId} className="card task">
            <div className="card-head">
              <span className="harness">{t.harness.replace(/^local\./, "")}</span>
              <Pill state={t.state} />
              <span className="sub right">{timeAgo(t.updatedAt)}</span>
            </div>
            <div className="sub">{shortPath(t.project)}</div>
            <p className="brief">{t.objective}</p>
          </div>
        ))}
      </section>
    </div>
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
