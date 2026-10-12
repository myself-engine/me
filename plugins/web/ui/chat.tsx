// 대화: sidebar (conversation list) + the conversation itself + the composer.
// Phones show one screen at a time (<=760px CSS); desktop shows the split.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Message, Task, Thread } from "./api.ts";
import { AccessControl } from "./access.tsx";
import { ApprovalBar, ApprovalCard } from "./approvals.tsx";
import { useApp } from "./context.ts";
import { useDevView } from "./dev.ts";
import { diffTotals, parseDiffStat } from "./diff.ts";
import { chatHref, settingsHref, taskHref } from "./routes.ts";
import { Empty, Header, Markdown, StatusDot, elapsed, repoName, stateLabel, threadTime, timeAgo, toolName, useBusy, useFocusTrap, useNow } from "./shared.tsx";
import { effortLabel, HeadChip } from "./head.tsx";
import { ProjectButton } from "./picker.tsx";
import { TONE_LABEL, activeAlerts, taskTitle, threadApproval, threadPreview, threadTone, threadWait, toneOf, turnOp, unlinkedApprovals, type HeadChoice, type Live } from "./state.ts";
// One mapping source of truth for failure text: the head's describeFailure also
// runs over stored errors, so old messages saved with raw English render friendly.
import { describeFailure } from "../../gjc-head/src/domain/alerts.ts";

export function ChatScreen(props: { threadId: string | null; project: string; setProject: (p: string) => void; onSend: (text: string, choice?: HeadChoice) => void }) {
  const { s } = useApp();
  const open = props.threadId !== null;
  const inbox = unlinkedApprovals(s);
  const [inboxOpen, setInboxOpen] = useState(false);
  return (
    <div className={`split convo${open ? " has-detail" : ""}`}>
      <div className="list-pane">
        <Sidebar activeId={props.threadId} inboxCount={inbox.length} onInbox={() => setInboxOpen(true)} />
      </div>
      <div className="detail-pane">
        <Conversation {...props} threadId={props.threadId} />
      </div>
      {inboxOpen && <InboxSheet onClose={() => setInboxOpen(false)} />}
    </div>
  );
}

/** Left sidebar: new conversation button, conversation list (grouped by project when more than one), then the system status. */
function Sidebar({ activeId, inboxCount, onInbox }: { activeId: string | null; inboxCount: number; onInbox: () => void }) {
  const { s } = useApp();
  const threads = useMemo(() => Object.values(s.threads).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [s.threads]);
  const projects = useMemo(() => [...new Set(threads.map((t) => t.project).filter(Boolean))], [threads]);
  const grouped = projects.length > 1;
  return (
    <>
      <div className="side-top">
        <h1 className="side-title">대화</h1>
        <a className="btn primary new-chat" href={chatHref(null)}>
          + 새 대화
        </a>
      </div>
      <div className="pane-scroll">
        {inboxCount > 0 && (
          <button type="button" className="inbox-row" onClick={onInbox} aria-haspopup="dialog">
            <StatusDot tone="needs" label={`확인할 일 ${inboxCount}`} />
            <span className="chev" aria-hidden="true">
              ›
            </span>
          </button>
        )}
        {threads.length === 0 ? (
          <Empty title="아직 대화가 없어요">새 대화를 시작하면 여기에 쌓여요.</Empty>
        ) : grouped ? (
          projects.map((p) => (
            <section key={p} aria-label={repoName(p)}>
              <h2 className="section-label side-group">📁 {repoName(p)}</h2>
              <ul className="rows">
                {threads
                  .filter((t) => t.project === p)
                  .map((t) => (
                    <ThreadRow key={t.id} t={t} active={t.id === activeId} />
                  ))}
              </ul>
            </section>
          ))
        ) : (
          <ul className="rows">
            {threads.map((t) => (
              <ThreadRow key={t.id} t={t} active={t.id === activeId} />
            ))}
          </ul>
        )}
      </div>
      <SystemStatus />
    </>
  );
}

function ThreadRow({ t, active }: { t: Thread; active: boolean }) {
  const { s } = useApp();
  const tone = threadTone(s, t.id);
  const wait = threadWait(s, t.id);
  const preview = threadPreview(s, t.id);
  return (
    <li>
      <a className={`row-link${active ? " on" : ""}`} href={chatHref(t.id)}>
        <StatusDot tone={tone} hideLabel />
        <span className="row-main">
          <span className="row-title">{t.title || "(제목 없음)"}</span>
          {preview && <span className="row-preview">{preview}</span>}
          <span className="row-sub">
            {/* Waiting work takes the time's place; the project shows in the group header or the conversation bar. */}
            {wait ? (
              <span className={`tone-text tone-${wait === "실패" ? "failed" : wait === "답변" ? "running" : "needs"}`}>{wait}</span>
            ) : (
              <>
                {tone !== "none" && <span className={`tone-text tone-${tone}`}>{TONE_LABEL[tone]} · </span>}
                {threadTime(t.updatedAt)}
              </>
            )}
          </span>
        </span>
      </a>
    </li>
  );
}

/** Approvals not tied to a conversation, as one sheet listing their existing cards. */
function InboxSheet({ onClose }: { onClose: () => void }) {
  const { s } = useApp();
  const items = unlinkedApprovals(s);
  const panel = useFocusTrap(onClose);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="drawer inbox-sheet" role="dialog" aria-modal="true" aria-labelledby="inbox-title" ref={panel}>
        <header className="drawer-head">
          <div>
            <h2 className="drawer-title" id="inbox-title">
              확인할 일 {items.length}
            </h2>
            <div className="drawer-sub">대화에 묶이지 않은 요청이에요</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </header>
        <div className="drawer-body stack">
          {items.map((a) => (
            <ApprovalCard key={a.approvalId} a={a} />
          ))}
        </div>
      </div>
    </>
  );
}

/** One line at the sidebar bottom: "모두 정상" or the first problem, opening settings. */
function SystemStatus() {
  const { s } = useApp();
  const alerts = activeAlerts(s);
  const down = Object.values(s.checks).filter((c) => c.status === "down").length + Object.values(s.plugins).filter((p) => p.state === "stopped" || p.state === "quarantined").length;
  const problem = alerts[0]?.title ?? (down > 0 ? `점검이 필요해요 · ${down}곳` : null);
  return (
    <a className="sys-status" href={settingsHref()} aria-label={problem ? `시스템 상태: ${problem}. 설정에서 보기` : "시스템 상태: 모두 정상. 설정에서 보기"}>
      {problem ? (
        <>
          <StatusDot tone="failed" label={problem} />
        </>
      ) : (
        <StatusDot tone="done" label="모두 정상" />
      )}
      <span className="chev" aria-hidden="true">
        ›
      </span>
    </a>
  );
}

/** While something blocks replies or delegations: one slim line with the cause and where to fix it. */
function AlertBanner() {
  const { s } = useApp();
  const alerts = activeAlerts(s);
  if (alerts.length === 0) return null;
  const first = alerts[0]!;
  return (
    <div className="conn-banner alert-banner" role="status">
      <StatusDot tone="needs" label="막힘" /> {first.title} · {first.fix}
      {alerts.length > 1 && ` (+${alerts.length - 1})`} <a className="link" href={settingsHref()}>설정에서 보기 ›</a>
    </div>
  );
}

function Conversation(props: { threadId: string | null; project: string; setProject: (p: string) => void; onSend: (text: string, choice?: HeadChoice) => void }) {
  const { s, conn } = useApp();
  const { threadId } = props;
  const realId = threadId === "new" ? null : threadId;
  const messages = useMemo(
    () => Object.values(s.messages).filter((m) => m.threadId === realId).sort((a, b) => a.ts.localeCompare(b.ts) || (a.role === b.role ? 0 : a.role === "user" ? -1 : 1)),
    [s.messages, realId],
  );
  const endRef = useRef<HTMLDivElement>(null);
  const last = messages.at(-1);
  const lastLen = messages.length + (last ? (s.live[last.traceId]?.text.length ?? 0) + last.text.length : 0);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lastLen, realId]);
  const thread = realId ? s.threads[realId] : null;
  const projects = [...new Set([props.project, ...s.config.projects].filter(Boolean))];
  const pending = threadApproval(s, realId);
  const empty = messages.length === 0;

  return (
    <div className="chat">
      <Header title={thread?.title || "새 대화"} back={realId ? chatHref() : undefined}>
        {thread && (
          <span className="bar-meta" title={thread.project}>
            {repoName(thread.project)}
          </span>
        )}
      </Header>
      <AlertBanner />
      <div className="scroll" tabIndex={0} aria-label="대화 내용">
        {empty && (
          <div className="hello">
            <h2>무엇을 도와드릴까요?</h2>
          </div>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="msg user">
              <div className="bubble">{m.text}</div>
            </div>
          ) : (
            <AssistantMessage key={m.id} m={m} />
          ),
        )}
        <div ref={endRef} />
      </div>
      <TurnAnnouncer key={realId ?? "new"} m={messages.filter((x) => x.role === "assistant").at(-1)} />
      {pending ? (
        <ApprovalBar a={pending} />
      ) : (
        <Composer
          key={realId ?? "new"}
          thread={thread}
          onSend={props.onSend}
          disabled={!conn}
          project={thread?.project ?? props.project}
          projects={projects}
          lockProject={!!thread || messages.length > 0}
          setProject={props.setProject}
        />
      )}
    </div>
  );
}

function AssistantMessage({ m }: { m: Message }) {
  const { s, openTrace } = useApp();
  const [dev] = useDevView();
  const live = s.live[m.traceId];
  const text = m.text || live?.text || "";
  const working = m.status === "pending" || m.status === "streaming";
  const [showThoughts, setShowThoughts] = useState(false);
  const error = m.error ?? live?.error;
  // Old messages were stored with raw English; run them through the same mapping so they read friendly too.
  const failure = error ? describeFailure(error) : null;
  const friendly = error ? (failure ? `${failure.title} · ${failure.fix}` : error) : null;

  const routeLabel = m.judgement ? (m.route === "direct" ? "직접 답변" : "작업 맡기기") : "기록";
  const routeTitle = m.judgement
    ? `간단함 ${Math.round(m.judgement.simpleProb * 100)}% · ${
        m.judgement.source === "fast-path" ? "빠른 답변" : m.judgement.source === "fallback" ? "대체 판정" : "Jev"
      } · ${m.judgement.model} — 눌러서 타임라인 보기`
    : "타임라인 보기";

  return (
    <div className="msg assistant">
      <div className="meta-row">
        {/* A failed reply is a 실패, never a 직접 답변; the developer view keeps the timeline chip. */}
        {error && <StatusDot tone="failed" label="실패" />}
        {dev ? (
          (m.judgement || !working) && (
            <button className={`chip route ${m.route ?? ""}`} onClick={() => openTrace(m.traceId, m.id)} title={routeTitle}>
              {routeLabel}
              {m.judgement?.source === "fallback" && (
                <>
                  <span className="warn-dot" aria-hidden="true" />
                  <span className="sr">대체 판정</span>
                </>
              )}
              <span className="chip-chev" aria-hidden="true">
                ›
              </span>
            </button>
          )
        ) : (
          !error && m.judgement && <span className="chip route plain">{routeLabel}</span>
        )}
        {m.understood && m.understood.replaced.length > 0 && (
          <span className="chip soft" title={m.understood.replaced.map((r) => `${r.from}→${r.to}`).join(", ")}>
            이렇게 이해했어요: {m.understood.normalized}
          </span>
        )}
      </div>

      {dev && live?.thoughts && (
        <button className="link" onClick={() => setShowThoughts((v) => !v)}>
          {showThoughts ? "생각 접기" : "생각 보기"}
        </button>
      )}
      {dev && showThoughts && live?.thoughts && <pre className="thoughts">{live.thoughts}</pre>}

      {dev && live && live.tools.length > 0 && (
        <ul className="tools">
          {live.tools.map((t) => (
            <li key={t.id} className={`tool${t.ok === false ? " bad" : ""}`}>
              <span className="tool-icon" aria-hidden="true">
                {t.ok === undefined ? "›" : t.ok ? "✓" : "!"}
              </span>
              <span className="tool-name">{t.name}</span>
              {t.intent && <span className="tool-intent">{t.intent}</span>}
            </li>
          ))}
        </ul>
      )}

      {text && (
        <div className="bubble">
          <Markdown text={text} />
          {m.status === "streaming" && <span className="caret" />}
        </div>
      )}

      {working && !text && !m.delegation && <PhaseLine m={m} live={live} />}

      {m.delegation && <DelegationLine m={m} />}

      {friendly && (
        <div className="card error" role="alert">
          ⚠️ {friendly}
        </div>
      )}
      {dev && error && friendly !== error && <pre className="thoughts">{error}</pre>}
    </div>
  );
}

const phaseLabel = (s: ReturnType<typeof useApp>["s"], m: Message, live?: Live) =>
  turnOp(s, m.traceId)?.phaseLabel ?? live?.phaseLabel ?? (m.status === "streaming" ? "답변 작성 중" : "요청 보내는 중");

/**
 * Screen-reader narration of the latest turn: phase changes while it works, then one line when it ends.
 * Streamed tokens are never announced one by one; the finished answer is read from the page.
 */
function TurnAnnouncer({ m }: { m?: Message }) {
  const { s } = useApp();
  let text = "";
  if (m) {
    const live = s.live[m.traceId];
    const error = m.error ?? live?.error;
    if (error) text = "답변하지 못했어요";
    else if (m.status === "pending" || m.status === "streaming") text = m.text || live?.text ? "답변 작성 중" : phaseLabel(s, m, live);
    else if (m.delegation) text = "작업을 맡겼어요";
    else text = "답변을 마쳤어요";
  }
  // Only turns that move while the page is open are worth saying; an old finished thread stays quiet.
  const [said, setSaid] = useState<string | null>(null);
  const prev = useRef(text);
  useEffect(() => {
    if (prev.current === text) return;
    prev.current = text;
    setSaid(text);
  }, [text]);
  return (
    <div className="sr" role="status" aria-live="polite" aria-atomic="true">
      {said}
    </div>
  );
}

/** What the turn is doing right now (kernel phase label), never a blank wait. */
function PhaseLine({ m, live }: { m: Message; live?: Live }) {
  const { s, openTrace } = useApp();
  const [dev] = useDevView();
  const now = useNow();
  const op = turnOp(s, m.traceId);
  const label = phaseLabel(s, m, live);
  const since = new Date(op?.startedAt ?? m.ts).getTime();
  if (!dev)
    return (
      <p className="phase plain">
        <span>{label}</span>
        {now - since > 3000 && <span className="phase-time">{elapsed(op?.startedAt ?? m.ts, null, now)}</span>}
      </p>
    );
  return (
    <button className="phase" onClick={() => openTrace(m.traceId, m.id)} title="타임라인 보기">
      <span className="dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>{label}</span>
      {now - since > 3000 && <span className="phase-time">{elapsed(op?.startedAt ?? m.ts, null, now)}</span>}
    </button>
  );
}

const SETTLED = new Set(["sealed", "applied", "accepted", "apply-failed", "failed", "rejected", "cancelled"]);

/** A delegation as one line: [status][goal][state][wait] → task panel. Worker tool labels show in 개발자 보기 only. */
function DelegationLine({ m }: { m: Message }) {
  const { s } = useApp();
  const [dev] = useDevView();
  const now = useNow(5000);
  const d = m.delegation!;
  const task = m.taskId ? s.tasks[m.taskId] : undefined;
  const approval = Object.values(s.approvals).find((a) => a.payload?.messageId === m.id);
  const state = approval ? "awaiting-approval" : (task?.state ?? d.state);
  const tone = toneOf(state);
  const time = task ? elapsed(task.createdAt, SETTLED.has(task.state) ? task.updatedAt : null, now) : timeAgo(m.ts, now);
  const body = (
    <>
      <StatusDot tone={tone} hideLabel />
      {dev && <span className="dl-harness">{workerLabel(task ?? d)}</span>}
      <span className="dl-goal">{taskTitle(s, { messageId: m.id, objective: task?.objective ?? d.brief })}</span>
      <span className={`dl-state tone-text tone-${tone}`}>{stateLabel(state)}</span>
      <span className="dl-time">{time}</span>
    </>
  );
  // The open conversation decides in the composer bar below; the line stays as context.
  if (approval && !task)
    return (
      <div className="dline">
        {body}
        <span className="muted"> · 아래에서 시작해 주세요</span>
      </div>
    );
  if (task && RESULT_STATES.has(task.state)) return <ResultCard task={task} time={time} />;
  if (task)
    return (
      <a className="dline" href={taskHref(task.taskId)}>
        {body}
        <span className="chev" aria-hidden="true">
          ›
        </span>
      </a>
    );
  return <div className="dline">{body}</div>;
}

/** "Codex · gpt-6.1-sol · 높음": the tool, plus the model and effort when they were picked at approval. Developer view only. */
const workerLabel = (w: { harness: string; model?: string; effort?: string }) =>
  [toolName(w.harness), w.model, w.effort && effortLabel(w.effort)].filter(Boolean).join(" · ");

/** States where a delegation's result sits in the thread as a card instead of a line. */
const RESULT_STATES = new Set(["sealed", "accepted", "applied", "apply-failed"]);

/** First sentence of the worker's report for the card: body text over headings, markdown marks dropped. */
const firstLine = (text: string | null) => {
  const lines = (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => !l.startsWith("#") && !l.startsWith("```")) ?? lines[0];
  return line?.replace(/^[#>*\-\s]+/, "").replace(/[`*_]/g, "").trim() || null;
};

/** A delegation whose result arrived: what changed, and apply or reject without leaving the thread. */
function ResultCard({ task, time }: { task: Task; time: string }) {
  const { conn, notify } = useApp();
  const [dev] = useDevView();
  const [busy, act] = useBusy(notify);
  const [totals, setTotals] = useState<ReturnType<typeof diffTotals> | null>(null);
  useEffect(() => {
    if (!conn) return;
    let live = true;
    conn
      .request("task.diff", { taskId: task.taskId, stat: true })
      .then((r) => live && r?.diff && setTotals(diffTotals(parseDiffStat(r.diff))))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [conn, task.taskId, task.state]);
  const tone = toneOf(task.state);
  const summary = firstLine(task.resultText);
  return (
    <article className="card result inline" aria-label="작업 결과">
      <div className="card-head">
        <StatusDot tone={tone} label={stateLabel(task.state)} />
        {dev && <span className="muted">{workerLabel(task)}</span>}
        <span className="muted right">{time}</span>
      </div>
      {summary && <p className="approval-summary">{summary}</p>}
      <p className="result-stat">
        {totals ? (
          <>
            <span className="plus">+{totals.added}</span> <span className="minus">−{totals.removed}</span> · 파일 {totals.files}개
          </>
        ) : (
          <span className="muted">변경 내용을 불러오는 중…</span>
        )}
        {dev && (
          <a className="link right" href={taskHref(task.taskId)}>
            전체 diff ›
          </a>
        )}
      </p>
      {task.state === "sealed" && (
        <>
          <div className="actions-row">
            <button className="primary" disabled={busy || !conn} onClick={() => act(() => conn!.request("task.accept", { taskId: task.taskId }))}>
              변경사항 적용
            </button>
            <button className="quiet" disabled={busy || !conn} onClick={() => act(() => conn!.request("task.reject", { taskId: task.taskId }))}>
              거절
            </button>
          </div>
          <p className="result-note muted">적용하면 이 작업의 변경사항을 프로젝트에 넣고 커밋해요. 수정할 점은 아래 메시지로 보내 주세요.</p>
        </>
      )}
      {task.state === "accepted" && <p className="result-note muted">변경사항을 적용하고 커밋하는 중이에요.</p>}
      {task.state === "applied" && <p className="result-note">{task.commitSha ? <>커밋 <code>{task.commitSha.slice(0, 8)}</code>에 적용했어요.</> : "적용했어요."}</p>}
      {task.state === "apply-failed" && <div className="card error">⚠️ {task.error ?? "적용하지 못했어요. 전체 diff에서 확인해 주세요."}</div>}
    </article>
  );
}

function Composer(props: {
  thread: Thread | null;
  onSend: (t: string, choice?: HeadChoice) => void;
  disabled: boolean;
  project: string;
  projects: string[];
  lockProject: boolean;
  setProject: (p: string) => void;
}) {
  const [text, setText] = useState("");
  // A new thread's model, effort and access, sent with its first message; an existing thread stores its own.
  const [draft, setDraft] = useState<HeadChoice>({});
  const submit = () => {
    const t = text.trim();
    if (!t || props.disabled) return;
    props.onSend(t, props.thread ? undefined : draft);
    setText("");
  };
  return (
    <div className="composer">
      <div className="composer-top">
        {props.lockProject ? (
          props.project && <span className="project">📁 {repoName(props.project)}</span>
        ) : (
          <ProjectButton project={props.project} projects={props.projects} setProject={props.setProject} />
        )}
        <HeadChip thread={props.thread} draft={draft} setDraft={setDraft} />
        <AccessControl thread={props.thread} draft={draft} setDraft={setDraft} />
      </div>
      <div className="composer-box">
        <textarea
          value={text}
          placeholder="무엇을 할까요?"
          aria-label="메시지"
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
