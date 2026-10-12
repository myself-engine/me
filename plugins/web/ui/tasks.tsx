// 작업 상세: #/task/<id> opens as a right-side panel (sheet) over the conversation,
// full screen on phones. Alerts and links use it.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Task } from "./api.ts";
import { useApp } from "./context.ts";
import { useDevView } from "./dev.ts";
import { effortLabel } from "./head.tsx";
import { Review, REVIEWABLE } from "./review.tsx";
import { chatHref } from "./routes.ts";
import { Empty, Header, Markdown, StatusDot, elapsed, repoName, stateLabel, toolName, useFocusTrap, useNow } from "./shared.tsx";
import { taskTitle, toneOf, type Tone } from "./state.ts";

const RUNNING = new Set(["running", "queued", "delegated", "awaiting-input", "awaiting-approval"]);

export interface VerifyCommand {
  cmd: string;
  exitCode: number;
  ms: number;
  tail: string;
}

export interface VerifyResult {
  state: "passed" | "failed" | "skipped" | "error";
  commands: VerifyCommand[];
}

type TaskEx = Task & { verify?: VerifyResult | null };

/** The verify gate's result for a sealed diff; null until the gate runs. */
export const verifyOf = (t: Task): VerifyResult | null => (t as TaskEx).verify ?? null;

/** Dot-plus-text for the panel: 검사 통과, 검사 실패 · <cmd>, 검사 없음, 검사 오류. */
export function verifyLabel(v: VerifyResult): string {
  if (v.state === "passed") return "검사 통과";
  if (v.state === "skipped") return "검사 없음";
  if (v.state === "error") return "검사 오류";
  return `검사 실패 · ${v.commands.find((c) => c.exitCode !== 0)?.cmd ?? "검사"}`;
}

export const verifyTone = (v: VerifyResult): Tone => (v.state === "passed" ? "done" : v.state === "skipped" ? "muted" : "failed");

/** How many queued delegations started waiting earlier; the panel shows "대기 중 · 앞에 N개". */
export function queueAhead(tasks: Record<string, Task>, task: Task): number {
  return Object.values(tasks).filter(
    (t) => t.state === "queued" && (t.createdAt < task.createdAt || (t.createdAt === task.createdAt && t.taskId < task.taskId)),
  ).length;
}

export const queueLabel = (ahead: number): string => (ahead > 0 ? `대기 중 · 앞에 ${ahead}개` : "대기 중");

/** Overlay shell: Esc closes, focus stays inside while open. */
export function TaskPanel({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const panel = useFocusTrap(onClose);
  const closeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <>
      <div className="scrim task-scrim" onClick={onClose} />
      <div className="task-panel" role="dialog" aria-modal="true" aria-label="작업 상세" ref={panel}>
        <div ref={closeRef} />
        <TaskDetail taskId={taskId} onClose={onClose} />
      </div>
    </>
  );
}

function TaskDetail({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { s } = useApp();
  const [dev] = useDevView();
  const now = useNow(5000);
  const task = s.tasks[taskId];
  const message = useMemo(() => Object.values(s.messages).find((m) => m.taskId === taskId), [s.messages, taskId]);
  const back = message ? chatHref(message.threadId) : chatHref();
  if (!task)
    return (
      <div className="detail">
        <Header title="작업" back={back} />
        <Empty title="작업을 찾지 못했어요">지워졌거나 아직 불러오지 못한 작업이에요.</Empty>
      </div>
    );
  const tone = toneOf(task.state);
  const queued = task.state === "queued";
  const ahead = queued ? queueAhead(s.tasks, task) : 0;
  const criterion = task.criterion || message?.delegation?.criterion;
  return (
    <div className="detail">
      <Header title={taskTitle(s, { taskId: task.taskId, objective: task.objective })} back={back}>
        <button className="icon-btn" onClick={onClose} aria-label="닫기">
          ✕
        </button>
      </Header>
      <div className="pane-scroll detail-body" tabIndex={0} aria-label="작업 상세 내용">
        <div className="task-head">
          <StatusDot tone={tone} label={queued ? queueLabel(ahead) : stateLabel(task.state)} />
          <span className="muted">
{dev ? <>{[toolName(task.harness), task.model, task.effort && effortLabel(task.effort)].filter(Boolean).join(" · ")} · </> : null}
            {elapsed(task.createdAt, RUNNING.has(task.state) ? null : task.updatedAt, now)}
          </span>
          {message && (
            <a className="link right" href={chatHref(message.threadId)}>
              대화 보기 ›
            </a>
          )}
        </div>

        {task.error && <div className="card error">⚠️ {task.error}</div>}

        <VerifyStatus task={task} />

        {/* Result first: what the tool reported, then the changes and the decision; the request and facts are folded below. */}
        {task.resultText ? (
          <WorkerReport text={task.resultText} />
        ) : queued ? (
          <p className="muted">{queueLabel(ahead)} — 순서가 되면 자동으로 시작해요.</p>
        ) : (
          RUNNING.has(task.state) && <p className="muted">실행 도구가 아직 결과를 보내지 않았어요.</p>
        )}

        {REVIEWABLE.has(task.state) && <Review task={task} />}

        <details className="fold">
          <summary>요청 내용{criterion ? " · 완료 조건" : ""} · 정보</summary>
          <p className="brief">{task.objective}</p>
          {criterion && <p className="brief">완료 조건: {criterion}</p>}
          <dl className="facts">
            {dev && (
              <div>
                <dt>실행 도구</dt>
                <dd>{toolName(task.harness)}</dd>
              </div>
            )}
            {dev && task.model && (
              <div>
                <dt>모델</dt>
                <dd>{task.model}</dd>
              </div>
            )}
            <div>
              <dt>프로젝트</dt>
              <dd className="path">{task.project}</dd>
            </div>
            <div>
              <dt>시작</dt>
              <dd>{new Date(task.createdAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</dd>
            </div>
          </dl>
        </details>
      </div>
    </div>
  );
}

/** The verify gate's dot-plus-text; the failing command's tail stays in the developer view. */
function VerifyStatus({ task }: { task: Task }) {
  const v = verifyOf(task);
  const [dev] = useDevView();
  if (!v) return null;
  const failing = v.commands.find((c) => c.exitCode !== 0);
  return (
    <div className="outcome">
      <StatusDot tone={verifyTone(v)} label={verifyLabel(v)} />
      {dev && failing && (
        <details className="fold">
          <summary>{failing.cmd} 출력 끝부분</summary>
          <Markdown text={"```\n" + failing.tail + "\n```"} />
        </details>
      )}
    </div>
  );
}
/** The worker's own words, collapsible; a trailing unfenced diff is left to the review section. */
function WorkerReport({ text }: { text: string }) {
  const at = text.search(/\n?diff --git /);
  const prose = at >= 0 && !text.slice(0, at).includes("```") ? text.slice(0, at).trim() : text;
  const long = prose.length > 600;
  const [open, setOpen] = useState(!long);
  return (
    <section className="report">
      <h2 className="section-label">작업 결과</h2>
      <div className={open ? "" : "clamp"}>
        <Markdown text={prose} />
      </div>
      {long && (
        <button className="link" onClick={() => setOpen((v) => !v)}>
          {open ? "접기" : "더 보기"}
        </button>
      )}
    </section>
  );
}
