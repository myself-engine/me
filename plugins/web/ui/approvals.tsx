// 승인: pending approvals with risk, requester, harness choice (amend.harness) and approve/reject.
import { useState } from "react";
import type { Approval } from "./api.ts";
import { useApp } from "./context.ts";
import { chatHref } from "./routes.ts";
import { Empty, Header, StatusDot, repoName, shortPath, toolName, useBusy } from "./shared.tsx";
import { isDelegationApproval } from "./state.ts";

const RISK_LABEL: Record<Approval["risk"], string> = { low: "위험 낮음", medium: "위험 보통", high: "위험 높음" };

export function ApprovalsScreen() {
  const { s } = useApp();
  const approvals = Object.values(s.approvals);
  return (
    <div className="page">
      <Header title="승인" />
      <div className="pane-scroll page-body">
        {approvals.length === 0 ? (
          <Empty title="기다리는 승인이 없어요">위임이나 위험한 작업이 승인을 요청하면 여기에 떠요.</Empty>
        ) : (
          <div className="stack">
            {approvals.map((a) => (
              <ApprovalCard key={a.approvalId} a={a} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** One pending approval. `inline` is the in-thread variant: the user's request is right above it, so it asks instead of restating. */
export function ApprovalCard({ a, inline = false }: { a: Approval; inline?: boolean }) {
  const { s, conn, notify } = useApp();
  const [busy, act] = useBusy(notify);
  const p = a.payload ?? {};
  const suggested: string | undefined = typeof p.harness === "string" ? p.harness : undefined;
  const harnesses: string[] = Array.isArray(p.harnesses) ? p.harnesses : suggested ? [suggested] : [];
  const [picked, setPicked] = useState<string | null>(null);
  const harness = picked ?? suggested;
  const delegation = isDelegationApproval(a);
  const message = delegation ? s.messages[p.messageId] : undefined;

  const decide = (decision: "approve" | "reject") =>
    act(async () => {
      if (!conn) return;
      await conn.request("approval.decide", {
        approvalId: a.approvalId,
        decision,
        ...(decision === "approve" && harness && harness !== suggested ? { amend: { harness } } : {}),
      });
    });

  return (
    <article className={`card approval${inline ? " inline" : ""}`} aria-label={inline ? "작업 맡기기 승인" : undefined}>
      <div className="card-head">
        <StatusDot tone="needs" label="승인 대기" />
        <span className={`risk risk-${a.risk}`}>{RISK_LABEL[a.risk] ?? a.risk}</span>
        {!inline && <span className="muted right">요청: {a.requester}</span>}
      </div>
      <p className="approval-summary">{inline && delegation ? "이 작업을 맡길까요?" : a.summary}</p>
      {p.project && <p className="chips"><span className="chip">📁 {repoName(p.project)}</span></p>}
      {(p.brief || p.criterion) && (
        <details className="fold">
          <summary>요청 내용{p.criterion ? " · 완료 조건" : ""}</summary>
          {p.brief && <p className="brief">{p.brief}</p>}
          {p.criterion && <p className="brief">완료 조건: {p.criterion}</p>}
          {p.project && <p className="brief muted">{shortPath(p.project)}</p>}
        </details>
      )}
      {harnesses.length > 0 && harness && (
        <label className="field">
          <span>실행 도구</span>
          <select value={harness} disabled={busy} onChange={(e) => setPicked(e.target.value)}>
            {(harnesses.includes(harness) ? harnesses : [harness, ...harnesses]).map((h) => (
              <option key={h} value={h}>
                {toolName(h)}
                {h === suggested ? " (추천)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {delegation && harness && <p className="result-note muted">승인하면 이 프로젝트에서 {toolName(harness)} 작업이 시작돼요.</p>}
      <div className="actions-row">
        <button className="primary" disabled={busy || !conn} onClick={() => decide("approve")}>
          {delegation ? "승인하고 시작" : "승인"}
        </button>
        <button className="quiet" disabled={busy || !conn} onClick={() => decide("reject")}>
          거절
        </button>
        {message && !inline && (
          <a className="link right" href={chatHref(message.threadId)}>
            대화 보기 ›
          </a>
        )}
      </div>
    </article>
  );
}
