// 대화: thread list, the conversation itself, and the composer.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Message, Task } from "./api.ts";
import { ApprovalCard } from "./approvals.tsx";
import { useApp } from "./context.ts";
import { diffTotals, parseDiffStat } from "./diff.ts";
import { chatHref, NEW_THREAD, taskHref } from "./routes.ts";
import { Empty, Header, Markdown, StatusDot, elapsed, repoName, shortPath, stateLabel, timeAgo, toolName, useBusy, useNow } from "./shared.tsx";
import { TONE_LABEL, threadTone, toneOf, turnOp, type Live } from "./state.ts";

export function ChatScreen(props: { threadId: string | null; project: string; setProject: (p: string) => void; onSend: (text: string) => void }) {
  const open = props.threadId !== null;
  return (
    <div className={`split${open ? " has-detail" : ""}`}>
      <div className="list-pane">
        <ThreadList activeId={props.threadId} />
      </div>
      <div className="detail-pane">
        <Conversation {...props} threadId={props.threadId === NEW_THREAD ? null : props.threadId} />
      </div>
    </div>
  );
}

function ThreadList({ activeId }: { activeId: string | null }) {
  const { s } = useApp();
  const threads = useMemo(() => Object.values(s.threads).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [s.threads]);
  return (
    <>
      <Header title="대화">
        <a className="btn quiet" href={chatHref(NEW_THREAD)}>
          + 새 대화
        </a>
      </Header>
      <div className="pane-scroll">
        {threads.length === 0 ? (
          <Empty title="아직 대화가 없어요">새 대화를 시작하면 여기에 쌓여요.</Empty>
        ) : (
          <ul className="rows">
            {threads.map((t) => {
              const tone = threadTone(s, t.id);
              return (
                <li key={t.id}>
                  <a className={`row-link${t.id === activeId ? " on" : ""}`} href={chatHref(t.id)}>
                    <StatusDot tone={tone} hideLabel />
                    <span className="row-main">
                      <span className="row-title">{t.title || "(제목 없음)"}</span>
                      <span className="row-sub">
                        {tone !== "none" && <span className={`tone-text tone-${tone}`}>{TONE_LABEL[tone]} · </span>}
                        {repoName(t.project)} · {timeAgo(t.updatedAt)}
                      </span>
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

function Conversation(props: { threadId: string | null; project: string; setProject: (p: string) => void; onSend: (text: string) => void }) {
  const { s, conn } = useApp();
  const { threadId } = props;
  const messages = useMemo(
    () => Object.values(s.messages).filter((m) => m.threadId === threadId).sort((a, b) => a.ts.localeCompare(b.ts) || (a.role === b.role ? 0 : a.role === "user" ? -1 : 1)),
    [s.messages, threadId],
  );
  const endRef = useRef<HTMLDivElement>(null);
  const last = messages.at(-1);
  const lastLen = messages.length + (last ? (s.live[last.traceId]?.text.length ?? 0) + last.text.length : 0);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lastLen, threadId]);
  const thread = threadId ? s.threads[threadId] : null;
  const projects = [...new Set([props.project, ...s.config.projects].filter(Boolean))];

  return (
    <div className="chat">
      <Header title={thread?.title || "새 대화"} back={chatHref()}>
        {thread && (
          <span className="bar-meta" title={thread.project}>
            {repoName(thread.project)}
          </span>
        )}
      </Header>
      <div className="scroll">
        {messages.length === 0 && (
          <div className="hello">
            <h2>무엇을 할까요?</h2>
            <p>간단한 건 바로 답하고, 작업이 필요하면 맞는 실행 도구에 맡길게요.</p>
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
      <TurnAnnouncer key={threadId ?? NEW_THREAD} m={messages.filter((x) => x.role === "assistant").at(-1)} />
      <Composer
        onSend={props.onSend}
        disabled={!conn}
        project={thread?.project ?? props.project}
        projects={projects}
        lockProject={!!thread}
        setProject={props.setProject}
      />
    </div>
  );
}

function AssistantMessage({ m }: { m: Message }) {
  const { s, openTrace } = useApp();
  const live = s.live[m.traceId];
  const text = m.text || live?.text || "";
  const working = m.status === "pending" || m.status === "streaming";
  const [showThoughts, setShowThoughts] = useState(false);
  const error = m.error ?? live?.error;

  const routeLabel = m.judgement ? (m.route === "direct" ? "직접 답변" : "작업 맡기기") : "기록";
  const routeTitle = m.judgement
    ? `간단함 ${Math.round(m.judgement.simpleProb * 100)}% · ${
        m.judgement.source === "fast-path" ? "빠른 답변" : m.judgement.source === "fallback" ? "대체 판정" : "Jev"
      } · ${m.judgement.model} — 눌러서 타임라인 보기`
    : "타임라인 보기";

  return (
    <div className="msg assistant">
      <div className="meta-row">
        {/* While the turn is still working without a verdict, the phase line below opens the timeline instead. */}
        {(m.judgement || !working) && (
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
        )}
        {m.understood && m.understood.replaced.length > 0 && (
          <span className="chip soft" title={m.understood.replaced.map((r) => `${r.from}→${r.to}`).join(", ")}>
            이렇게 이해했어요: {m.understood.normalized}
          </span>
        )}
      </div>

      {live?.thoughts && (
        <button className="link" onClick={() => setShowThoughts((v) => !v)}>
          {showThoughts ? "생각 접기" : "생각 보기"}
        </button>
      )}
      {showThoughts && live?.thoughts && <pre className="thoughts">{live.thoughts}</pre>}

      {live && live.tools.length > 0 && (
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

      {error && <div className="card error">⚠️ {error}</div>}
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
  const now = useNow();
  const op = turnOp(s, m.traceId);
  const label = phaseLabel(s, m, live);
  const since = new Date(op?.startedAt ?? m.ts).getTime();
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

/** A delegation as one line: [status][harness][goal][state][elapsed] → task detail. */
function DelegationLine({ m }: { m: Message }) {
  const { s } = useApp();
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
      <span className="dl-harness">{toolName(task?.harness ?? d.harness)}</span>
      <span className="dl-goal">{task?.objective ?? d.brief}</span>
      <span className={`dl-state tone-text tone-${tone}`}>{stateLabel(state)}</span>
      <span className="dl-time">{time}</span>
    </>
  );
  if (approval && !task) return <ApprovalCard a={approval} inline />;
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
  return (
    <div className="dline">
      {body}
      {approval && (
        <a className="btn primary small" href="#/approvals">
          승인하기
        </a>
      )}
    </div>
  );
}

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
        <span className="muted">{toolName(task.harness)}</span>
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
        <a className="link right" href={taskHref(task.taskId)}>
          전체 diff ›
        </a>
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
      {task.state === "applied" && (
        <p className="result-note">{task.commitSha ? <>커밋 <code>{task.commitSha.slice(0, 8)}</code>에 적용했어요.</> : "적용했어요."}</p>
      )}
      {task.state === "apply-failed" && <div className="card error">⚠️ {task.error ?? "적용하지 못했어요. 전체 diff에서 확인해 주세요."}</div>}
    </article>
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
          <span className="project" title={props.project}>
            📁 {shortPath(props.project)}
          </span>
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
