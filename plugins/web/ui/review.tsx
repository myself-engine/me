// Review of a delegated task's result: per-file summary, per-file diff, and the accept/reject bar.
// 개발자 보기가 꺼져 있으면 raw diff는 숨기고 +N −N 요약과 적용 버튼만 둔다.
import { useCallback, useEffect, useState } from "react";
import type { Task } from "./api.ts";
import { useApp } from "./context.ts";
import { useDevView } from "./dev.ts";
import { parseDiffStat, splitDiff, type DiffStat, type FileDiff } from "./diff.ts";
import { Markdown, repoName, useBusy } from "./shared.tsx";

/** States where the worker produced a diff worth looking at. */
export const REVIEWABLE = new Set(["sealed", "accepted", "applied", "apply-failed"]);

export function Review({ task }: { task: Task }) {
  const { conn, notify } = useApp();
  const [dev] = useDevView();
  const [stat, setStat] = useState<DiffStat | null>(null);
  const [files, setFiles] = useState<FileDiff[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, act] = useBusy(notify);

  const load = useCallback(async () => {
    if (!conn) return;
    setLoadError(null);
    const [s, d] = await Promise.all([
      conn.request("task.diff", { taskId: task.taskId, stat: true }).catch(() => null),
      conn.request("task.diff", { taskId: task.taskId }),
    ]);
    if (d.error && !d.diff) setLoadError(d.error);
    setStat(s?.diff ? parseDiffStat(s.diff) : null);
    setFiles(splitDiff(d.diff ?? ""));
  }, [conn, task.taskId]);

  useEffect(() => {
    load().catch((err) => setLoadError(err.message));
  }, [load]);

  const statFiles =
    stat && stat.files.length > 0
      ? stat.files.map((f) => ({ path: f.path, added: f.plus, removed: f.minus, changes: f.changes }))
      : (files ?? []).map((f) => ({ path: f.path, added: f.added, removed: f.removed, changes: f.added + f.removed }));

  return (
    <section className="review">
      <h2 className="section-label">변경사항</h2>
      {task.commitSha && (
        <div className="outcome">
          ✓ 커밋 <code>{task.commitSha.slice(0, 8)}</code> · 📁 {repoName(task.project)}
        </div>
      )}
      {loadError && <div className="card error">⚠️ {loadError}</div>}
      {!files && !loadError && <p className="muted">변경 내용을 불러오는 중…</p>}
      {files && files.length === 0 && !loadError && <p className="muted">변경된 파일이 없어요.</p>}
      {statFiles.length > 0 && (
        <div className="stat">
          <div className="stat-summary">{stat?.summary ?? `${statFiles.length}개 파일 변경`}</div>
          <ul className="stat-files">
{statFiles.map((f) => (
              <li key={f.path}>
                {dev ? (
                  <button className="link file-link" onClick={() => document.getElementById(fileAnchor(f.path))?.scrollIntoView({ block: "start" })}>
                    {f.path}
                  </button>
                ) : (
                  <span className="file-path">{f.path}</span>
                )}
                <span className="stat-num">
                  {f.changes === null ? (
                    "바이너리"
                  ) : (
                    <>
                      <span className="plus">+{f.added}</span> <span className="minus">−{f.removed}</span>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
{dev &&
        files?.map((f) => (
          <details key={f.path || "diff"} className="file-diff" id={fileAnchor(f.path)} open={files.length <= 6}>
            <summary>
              <span className="file-path">{f.path || "diff"}</span>
              <span className="stat-num">
                <span className="plus">+{f.added}</span> <span className="minus">−{f.removed}</span>
              </span>
            </summary>
            <Markdown text={"```diff\n" + f.text + "\n```"} />
          </details>
        ))}

      {conn && (
        <div className="review-bar">
          {task.state === "sealed" ? (
            <>
              <button className="primary" disabled={busy} onClick={() => act(() => conn.request("task.accept", { taskId: task.taskId }))}>
                변경사항 적용
              </button>
              <button className="quiet" disabled={busy} onClick={() => act(() => conn.request("task.reject", { taskId: task.taskId }))}>
                거절
              </button>
              <span className="muted review-note">적용하면 프로젝트에 넣고 커밋해요</span>
            </>
          ) : (
            <span className="muted">
              {task.commitSha
                ? `커밋 ${task.commitSha.slice(0, 8)}에 적용했어요`
                : task.state === "accepted"
                  ? "변경사항을 적용하고 커밋하는 중이에요"
                  : task.state === "apply-failed"
                    ? "적용하지 못했어요 · 위 오류를 확인하세요"
                    : task.state === "reverted"
                      ? `되돌렸어요 · 커밋 ${task.revert?.commit.slice(0, 8) ?? task.commitSha?.slice(0, 8) ?? ""}`
                      : "이미 결정된 작업이에요"}
            </span>
          )}
          {/* Only while the diff can still change or be retried; an applied diff is final. */}
          {task.state !== "applied" && task.state !== "reverted" && (
            <button className="quiet right" disabled={busy} onClick={() => act(load)}>
              다시 불러오기
            </button>
          )}
        </div>
      )}
      <RevertControl task={task} />
    </section>
  );
}

const fileAnchor = (path: string) => `file-${path.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
/** Applied tasks can be undone: `git revert` of the applied commit, with a confirm step. Reverted tasks show the result text. */
export function RevertControl({ task }: { task: Task }) {
  const { conn, notify } = useApp();
  const [busy, act] = useBusy(notify);
  const [confirming, setConfirming] = useState(false);
  if (task.state === "reverted") {
    return (
      <div className="outcome">
        ✓ 되돌렸어요 · 커밋 <code>{task.revert?.commit.slice(0, 8) ?? task.commitSha?.slice(0, 8) ?? ""}</code>
      </div>
    );
  }
  if (task.state !== "applied" || !conn) return null;
  if (!confirming) {
    return (
      <div className="review-bar">
        <button type="button" className="quiet" disabled={busy} onClick={() => setConfirming(true)}>
          되돌리기
        </button>
        <span className="muted review-note">적용한 커밋을 되돌려요</span>
      </div>
    );
  }
  return (
    <div className="review-bar">
      <span className="proj-confirm" role="group" aria-label="되돌리기 확인">
        <span className="muted">적용한 커밋 {task.commitSha?.slice(0, 8) ?? ""}을 되돌릴까요?</span>
        <button
          type="button"
          className="quiet"
          disabled={busy}
          onClick={() => act(() => conn.request("task.revert", { taskId: task.taskId }).then(() => setConfirming(false)))}
        >
          되돌리기
        </button>
        <button type="button" className="quiet" onClick={() => setConfirming(false)}>
          취소
        </button>
      </span>
    </div>
  );
}
