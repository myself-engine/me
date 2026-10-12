// 작업: delegated work by status bucket, and one task's detail with its review.
import { useMemo, useState } from "react";
import { useApp } from "./context.ts";
import { ApprovalCard } from "./approvals.tsx";
import { effortLabel } from "./head.tsx";
import { Review, REVIEWABLE } from "./review.tsx";
import { chatHref, go, taskHref } from "./routes.ts";
import { Empty, Header, Markdown, Section, StatusDot, elapsed, repoName, stateLabel, toolName, useNow } from "./shared.tsx";
import { isDelegationApproval, taskTitle, toneOf, workItems, type Tone, type WorkItem } from "./state.ts";

const BUCKETS: { tone: Tone; label: string }[] = [
  { tone: "needs", label: "확인 필요" },
  { tone: "running", label: "진행 중" },
  { tone: "done", label: "완료" },
  { tone: "failed", label: "실패" },
];

const RUNNING = new Set(["running", "delegated", "awaiting-input", "awaiting-approval"]);

/** The 12px line under a row: what happened last, in words. */
function describe(w: WorkItem): string {
  const t = w.task;
  if (!t) return "승인해 주세요 · 대화에서 바로 승인할 수 있어요";
  if (t.error) return t.error;
  switch (t.state) {
    case "running":
      return "실행 도구가 작업 중이에요";
    case "awaiting-input":
      return "실행 도구가 입력을 기다려요";
    case "sealed":
      return "변경사항을 검토해 주세요";
    case "applied":
      return t.commitSha ? `커밋 ${t.commitSha.slice(0, 8)}에 적용됐어요` : "적용됐어요";
    case "accepted":
      return "변경사항을 적용하고 커밋하는 중이에요";
    case "rejected":
      return t.decisionReason ? `거절함 · ${t.decisionReason}` : "거절했어요";
    case "cancelled":
      return "취소됐어요";
    case "failed":
      return "실행 도구가 실패했어요";
    default:
      return stateLabel(t.state);
  }
}

export function TasksScreen({ taskId, project }: { taskId: string | null; project: string | null }) {
  return (
    <div className={`split${taskId ? " has-detail" : ""}`}>
      <div className="list-pane">
        <TaskList activeId={taskId} project={project} />
      </div>
      <div className="detail-pane">
        {taskId ? <TaskDetail taskId={taskId} project={project} /> : <Empty title="작업을 고르세요">왼쪽 목록에서 작업을 누르면 지시 내용과 결과를 볼 수 있어요.</Empty>}
      </div>
    </div>
  );
}

function TaskList({ activeId, project }: { activeId: string | null; project: string | null }) {
  const { s } = useApp();
  const now = useNow(10_000);
  const [showHidden, setShowHidden] = useState(false);
  const all = useMemo(() => workItems(s), [s.tasks, s.approvals, s.messages]);
  const projects = useMemo(() => [...new Set(all.map((w) => w.project).filter(Boolean))].sort(), [all]);
  const items = project ? all.filter((w) => w.project === project) : all;
  const hidden = items.filter((w) => toneOf(w.state) === "muted");
  // Approval requests that are not delegations (e.g. a rule asking before a command) have no thread card; they live here.
  const requests = Object.values(s.approvals).filter((a) => !isDelegationApproval(a));

  return (
    <>
      <Header title="작업">
        {projects.length > 1 || project ? (
          <select className="filter" value={project ?? ""} onChange={(e) => go(taskHref(null, e.target.value || null))} aria-label="프로젝트 필터">
            <option value="">모든 프로젝트</option>
            {[...new Set([...(project ? [project] : []), ...projects])].map((p) => (
              <option key={p} value={p}>
                {repoName(p)}
              </option>
            ))}
          </select>
        ) : null}
      </Header>
      <div className="pane-scroll">
        {requests.length > 0 && (
          <Section label="승인 요청" count={requests.length} tone="needs">
            <div className="stack pad">
              {requests.map((a) => (
                <ApprovalCard key={a.approvalId} a={a} />
              ))}
            </div>
          </Section>
        )}
        {items.length === 0 && requests.length === 0 && <Empty title="지금 확인할 일이 없어요">대화에서 일을 맡기면 여기에서 상태를 볼 수 있어요.</Empty>}
        {BUCKETS.map(({ tone, label }) => {
          const list = items.filter((w) => toneOf(w.state) === tone);
          if (list.length === 0) return null;
          return (
            <Section key={tone} label={label} count={list.length} tone={tone}>
              <ul className="rows">
                {list.map((w) => (
                  <WorkRow key={w.id} w={w} on={w.id === activeId} project={project} now={now} />
                ))}
              </ul>
            </Section>
          );
        })}
        {hidden.length > 0 && (
          <Section label="숨김" count={hidden.length}>
            <button className="link pad" onClick={() => setShowHidden((v) => !v)}>
              {showHidden ? "거절·취소한 작업 접기" : `거절·취소한 작업 ${hidden.length}개 보기`}
            </button>
            {showHidden && (
              <ul className="rows">
                {hidden.map((w) => (
                  <WorkRow key={w.id} w={w} on={w.id === activeId} project={project} now={now} />
                ))}
              </ul>
            )}
          </Section>
        )}
      </div>
    </>
  );
}

function WorkRow({ w, on, project, now }: { w: WorkItem; on: boolean; project: string | null; now: number }) {
  const { s } = useApp();
  const tone = toneOf(w.state);
  // A delegation waiting for approval is decided on its card in the conversation.
  const thread = w.approval ? s.messages[w.approval.payload?.messageId]?.threadId : undefined;
  const href = w.task ? taskHref(w.id, project) : thread ? chatHref(thread) : taskHref(null, project);
  return (
    <li>
      <a className={`row-link${on ? " on" : ""}`} href={href}>
        <StatusDot tone={tone} hideLabel />
        <span className="row-main">
          <span className="row-title">{w.title}</span>
          <span className="row-sub">
            <span className={`tone-text tone-${tone}`}>{stateLabel(w.state)}</span> · {toolName(w.harness)} · {repoName(w.project)} ·{" "}
            {elapsed(w.startedAt, RUNNING.has(w.state) ? null : w.updatedAt, now)}
          </span>
          <span className={`row-note${w.task?.error ? " bad" : ""}`}>{describe(w)}</span>
        </span>
      </a>
    </li>
  );
}

function TaskDetail({ taskId, project }: { taskId: string; project: string | null }) {
  const { s } = useApp();
  const now = useNow(5000);
  const task = s.tasks[taskId];
  const message = useMemo(() => Object.values(s.messages).find((m) => m.taskId === taskId), [s.messages, taskId]);
  const back = taskHref(null, project);
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
      <Header title={taskTitle(s, { taskId: task.taskId, objective: task.objective })} back={back} />
      <div className="pane-scroll detail-body">
        <div className="task-head">
          <StatusDot tone={tone} label={stateLabel(task.state)} />
          <span className="muted">
            {[toolName(task.harness), task.model, task.effort && effortLabel(task.effort)].filter(Boolean).join(" · ")} ·{" "}
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
            <div>
              <dt>실행 도구</dt>
              <dd>{toolName(task.harness)}</dd>
            </div>
            {task.model && (
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
