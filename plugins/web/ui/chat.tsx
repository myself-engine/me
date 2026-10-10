// 대화: thread list, the conversation itself, and the composer.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Message } from "./api.ts";
import { useApp } from "./context.ts";
import { chatHref, NEW_THREAD, taskHref } from "./routes.ts";
import { Empty, Header, Markdown, StatusDot, elapsed, repoName, shortHarness, shortPath, stateLabel, timeAgo, useNow } from "./shared.tsx";
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
            <p>간단한 건 바로 답하고, 작업이 필요하면 맞는 하네스에 위임할게요.</p>
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

  const routeLabel = m.judgement ? (m.route === "direct" ? "직접 답변" : "위임") : "기록";
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
            {m.judgement?.source === "fallback" && <span className="warn-dot" aria-label="대체 판정" />}
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

/** What the turn is doing right now (kernel phase label), never a blank wait. */
function PhaseLine({ m, live }: { m: Message; live?: Live }) {
  const { s, openTrace } = useApp();
  const now = useNow();
  const op = turnOp(s, m.traceId);
  const label = op?.phaseLabel ?? live?.phaseLabel ?? (m.status === "streaming" ? "답변 작성 중" : "요청 보내는 중");
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
      <span className="dl-harness">{shortHarness(task?.harness ?? d.harness)}</span>
      <span className="dl-goal">{task?.objective ?? d.brief}</span>
      <span className={`dl-state tone-text tone-${tone}`}>{stateLabel(state)}</span>
      <span className="dl-time">{time}</span>
    </>
  );
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
