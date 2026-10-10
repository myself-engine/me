// Review of a delegated task's result: per-file summary, per-file diff, and the accept/reject bar.
import { useCallback, useEffect, useState } from "react";
import type { Task } from "./api.ts";
import { useApp } from "./context.ts";
import { parseDiffStat, splitDiff, type DiffStat, type FileDiff } from "./diff.ts";
import { Markdown, shortPath, useBusy } from "./shared.tsx";

/** States where the worker produced a diff worth looking at. */
export const REVIEWABLE = new Set(["sealed", "accepted", "applied", "apply-failed"]);

export function Review({ task }: { task: Task }) {
  const { conn, notify } = useApp();
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
      <h2 className="section-label">리뷰</h2>
      {task.commitSha && (
        <div className="outcome" title={task.project}>
          ✓ 커밋 <code>{task.commitSha.slice(0, 8)}</code> · {shortPath(task.project)}
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
                <button className="link file-link" onClick={() => document.getElementById(fileAnchor(f.path))?.scrollIntoView({ block: "start" })}>
                  {f.path}
                </button>
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
      {files?.map((f) => (
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
                수락 (적용+커밋)
              </button>
              <button className="quiet" disabled={busy} onClick={() => act(() => conn.request("task.reject", { taskId: task.taskId }))}>
                거절
              </button>
            </>
          ) : (
            <span className="muted">
              {task.commitSha ? `커밋 ${task.commitSha.slice(0, 8)}에 적용됐어요` : task.state === "apply-failed" ? "적용하지 못했어요 · 위 오류를 확인하세요" : "이미 결정된 작업이에요"}
            </span>
          )}
          <button className="quiet right" disabled={busy} onClick={() => act(load)}>
            diff 새로고침
          </button>
        </div>
      )}
    </section>
  );
}

const fileAnchor = (path: string) => `file-${path.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
