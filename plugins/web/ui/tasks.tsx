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
import { taskTitle, toneOf } from "./state.ts";

const RUNNING = new Set(["running", "delegated", "awaiting-input", "awaiting-approval"]);

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
          <StatusDot tone={tone} label={stateLabel(task.state)} />
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

        {/* Result first: what the tool reported, then the changes and the decision; the request and facts are folded below. */}
        {task.resultText ? <WorkerReport text={task.resultText} /> : RUNNING.has(task.state) && <p className="muted">실행 도구가 아직 결과를 보내지 않았어요.</p>}

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
