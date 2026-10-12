// One pending approval as a card: in the thread for delegations, in 작업 for other requests.
// Risk, requester, tool/model/effort choice (amend) and approve/reject.
import { useState } from "react";
import type { Approval } from "./api.ts";
import { useApp } from "./context.ts";
import { chatHref } from "./routes.ts";
import { StatusDot, repoName, toolName, useBusy } from "./shared.tsx";
import { effortLabel } from "./head.tsx";
import { isDelegationApproval } from "./state.ts";

const RISK_LABEL: Record<Approval["risk"], string> = { low: "위험 낮음", medium: "위험 보통", high: "위험 높음" };

/** One pending approval. `inline` is the in-thread variant: the user's request is right above it, so it asks instead of restating. */
export function ApprovalCard({ a, inline = false }: { a: Approval; inline?: boolean }) {
  const { s, conn, notify } = useApp();
  const [busy, act] = useBusy(notify);
  const p = a.payload ?? {};
  const suggested: string | undefined = typeof p.harness === "string" ? p.harness : undefined;
  const harnesses: string[] = Array.isArray(p.harnesses) ? p.harnesses : suggested ? [suggested] : [];
  const [picked, setPicked] = useState<string | null>(null);
  const harness = picked ?? suggested;
  // Worker model and effort; "" keeps the tool's own default. Models are config favourites per tool, or typed.
  const workers: { models: Record<string, string[]>; efforts: string[] } = p.workers ?? { models: {}, efforts: [] };
  const favorites = (harness && workers.models[harness]) || [];
  const [model, setModel] = useState("");
  const [typing, setTyping] = useState(false);
  const [effort, setEffort] = useState("");
  const delegation = isDelegationApproval(a);
  const message = delegation ? s.messages[p.messageId] : undefined;

  const decide = (decision: "approve" | "reject") =>
    act(async () => {
      if (!conn) return;
      const amend = {
        ...(harness && harness !== suggested ? { harness } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(effort ? { effort } : {}),
      };
      await conn.request("approval.decide", { approvalId: a.approvalId, decision, ...(decision === "approve" && Object.keys(amend).length ? { amend } : {}) });
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
          {p.project && <p className="brief muted path">{p.project}</p>}
        </details>
      )}
      {!delegation && harnesses.length > 0 && harness && (
        <label className="field">
          <span>실행 도구</span>
          <select
            value={harness}
            disabled={busy}
            onChange={(e) => {
              setPicked(e.target.value);
              setModel("");
              setTyping(false);
            }}
          >
            {(harnesses.includes(harness) ? harnesses : [harness, ...harnesses]).map((h) => (
              <option key={h} value={h}>
                {toolName(h)}
                {h === suggested ? " (추천)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {delegation && harness && (
        <details className="fold">
          <summary>다르게 맡기기</summary>
          {harnesses.length > 0 && (
            <label className="field">
              <span>실행 도구</span>
              <select
                value={harness}
                disabled={busy}
                onChange={(e) => {
                  setPicked(e.target.value);
                  setModel("");
                  setTyping(false);
                }}
              >
                {(harnesses.includes(harness) ? harnesses : [harness, ...harnesses]).map((h) => (
                  <option key={h} value={h}>
                    {toolName(h)}
                    {h === suggested ? " (추천)" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="field-row">
            <label className="field">
              <span>모델</span>
              {typing ? (
                <input className="field-input" value={model} disabled={busy} placeholder="모델 이름" aria-label="모델 이름" onChange={(e) => setModel(e.target.value)} />
              ) : (
                <select
                  value={model}
                  disabled={busy}
                  onChange={(e) => (e.target.value === "\u0000" ? (setTyping(true), setModel("")) : setModel(e.target.value))}
                >
                  <option value="">기본값</option>
                  {favorites.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                  <option value={"\u0000"}>직접 입력…</option>
                </select>
              )}
            </label>
            {workers.efforts.length > 0 && (
              <label className="field">
                <span>effort</span>
                <select value={effort} disabled={busy} onChange={(e) => setEffort(e.target.value)}>
                  <option value="">기본값</option>
                  {workers.efforts.map((e) => (
                    <option key={e} value={e}>
                      {effortLabel(e)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </details>
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
