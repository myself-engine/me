// Timeline drawer: one request's call tree (kernel trace.get), refreshed while its ops are still moving.
import { useEffect, useMemo, useState } from "react";
import type { TraceNode, TraceResult } from "./api.ts";
import { useApp } from "./context.ts";
import { StatusDot, duration, elapsed, useBusy, useFocusTrap, useNow } from "./shared.tsx";
import type { Tone } from "./state.ts";

const TARGET_LABEL: Record<string, string> = {
  "gjc-head": "대화 처리",
  slang: "줄임말 풀기",
  jev: "판정",
  summarize: "지시서 작성",
  kernel: "승인 대기",
};

const BRGR_LABEL: Record<string, string> = {
  "task.delegate": "워커에게 위임",
  "task.diff": "변경 내용 읽기",
  "task.accept": "적용하고 커밋",
  "task.reject": "거절 기록",
};

export function nodeLabel(n: TraceNode): string {
  if (n.type === "approval") return "승인 대기";
  if (n.target === "brgr") return BRGR_LABEL[n.method] ?? "워커 작업";
  return TARGET_LABEL[n.target] ?? `${n.target} 호출`;
}

const NODE_TONE: Record<TraceNode["status"], [Tone, string]> = {
  running: ["running", "진행 중"],
  waiting: ["needs", "대기"],
  ok: ["done", "완료"],
  error: ["failed", "실패"],
  cancelled: ["muted", "취소"],
};

const PHASE_LABEL: Record<string, string> = { approve: "승인됨", reject: "거절됨", waiting: "승인 대기" };

export function TraceDrawer({ traceId, messageId, onClose }: { traceId: string; messageId?: string; onClose: () => void }) {
  const { s, conn, notify } = useApp();
  const [trace, setTrace] = useState<TraceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, act] = useBusy(notify);
  const now = useNow();

  // Every kernel.op change for this request (phase, end) is a reason to refetch.
  const opsKey = useMemo(
    () =>
      Object.values(s.ops)
        .filter((o) => o.traceId === traceId)
        .map((o) => `${o.opId}:${o.updatedAt}:${o.state}`)
        .sort()
        .join(","),
    [s.ops, traceId],
  );
  useEffect(() => {
    if (!conn) return;
    let alive = true;
    const t = setTimeout(() => {
      conn
        .request<TraceResult>("trace.get", { traceId })
        .then((r) => alive && (setTrace(r), setError(null)))
        .catch((err) => alive && setError(err.message));
    }, trace ? 300 : 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [conn, traceId, opsKey]);

  const panel = useFocusTrap(onClose);

  const fileIssue = () =>
    act(async () => {
      const note = prompt("무엇이 이상했나요? (한 줄)");
      if (note === null || !conn) return;
      const r = await conn.request("issue.create", { traceId, messageId, note });
      notify(r.url ? `이슈를 만들었어요: ${r.url}` : "저장소가 설정되지 않아 이슈 내용만 만들었어요");
    });

  const total = trace?.startedAt ? elapsed(trace.startedAt, trace.endedAt, now) : null;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" ref={panel}>
        <header className="drawer-head">
          <div>
            <h2 className="drawer-title" id="drawer-title">
              요청 타임라인
            </h2>
            {total && <div className="drawer-sub">{trace?.endedAt ? `총 ${total}` : `${total}째 진행 중`}</div>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </header>
        <div className="drawer-body">
          {error && <div className="card error">⚠️ {error}</div>}
          {!trace && !error && <p className="muted">불러오는 중…</p>}
          {trace && trace.nodes.length === 0 && <p className="muted">기록된 단계가 아직 없어요.</p>}
          {trace && trace.nodes.length > 0 && (
            <ol className="trace">
              {trace.nodes.map((n) => (
                <TraceItem key={n.seq} n={n} now={now} />
              ))}
            </ol>
          )}
        </div>
        <footer className="drawer-foot">
          <button className="quiet" disabled={busy || !conn} onClick={fileIssue} title="이 요청의 기록을 붙여 GitHub 이슈로 올려요">
            문제 신고
          </button>
        </footer>
      </div>
    </>
  );
}


function TraceItem({ n, now }: { n: TraceNode; now: number }) {
  const [tone, label] = NODE_TONE[n.status];
  const took = n.durationMs !== null ? duration(n.durationMs) : elapsed(n.startedAt, null, now);
  const start = new Date(n.startedAt).getTime();
  return (
    <li className="trace-node">
      <div className="trace-row">
        <StatusDot tone={tone} label={label} hideLabel />
        <span className="trace-label">{nodeLabel(n)}</span>
        <span className={`trace-state tone-text tone-${tone}`}>{label}</span>
        <span className="trace-time">{took}</span>
      </div>
      <div className="trace-method">
        {n.type === "approval" ? `${n.caller} → 승인` : `${n.target} · ${n.method}`}
      </div>
      {n.phases.length > 0 && (
        <ul className="trace-phases">
          {n.phases.map((p, i) => (
            <li key={i}>
              <span>{p.label ?? PHASE_LABEL[p.phase] ?? p.phase}</span>
              <span className="trace-time">+{duration(Math.max(0, new Date(p.at).getTime() - start))}</span>
            </li>
          ))}
        </ul>
      )}
      {n.error && <div className="trace-error">{n.error}</div>}
      {n.children.length > 0 && (
        <ol className="trace">
          {n.children.map((c) => (
            <TraceItem key={c.seq} n={c} now={now} />
          ))}
        </ol>
      )}
    </li>
  );
}
