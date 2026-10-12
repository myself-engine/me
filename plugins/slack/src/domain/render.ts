// What the bot posts besides plain replies: approval and task cards with their components.
// Text is Slack mrkdwn; rows are platform-neutral and blocks.ts turns them into Block Kit.
import { ids } from "./ids.ts";
import { escapeText, toMrkdwn } from "./mrkdwn.ts";
import { truncate } from "./split.ts";

/** Slack has two button colors (green primary, red danger) and the plain default. */
export type ButtonStyle = "primary" | "danger" | "default";
export type Button = { type: "button"; id: string; label: string; style: ButtonStyle };
export type Select = { type: "select"; id: string; placeholder: string; options: { value: string; label: string; selected: boolean }[] };
/** One actions block: a few buttons, or a single select menu. */
export type Row = Button[] | [Select];

export interface Card {
  text: string;
  rows: Row[];
}

export interface ApprovalView {
  approvalId: string;
  summary: string;
  risk: string;
  harness: string | null;
  harnesses: string[];
  brief: string | null;
}

/** Reads the fields the head puts in an approval payload (plugins/gjc-head/src/app/chat.ts). */
export function approvalView(a: { approvalId: string; summary?: string; risk?: string; payload?: Record<string, unknown> | null }): ApprovalView {
  const p = a.payload ?? {};
  const harness = typeof p.harness === "string" ? p.harness : null;
  const listed = Array.isArray(p.harnesses) ? p.harnesses.filter((h): h is string => typeof h === "string") : [];
  return {
    approvalId: a.approvalId,
    summary: a.summary ?? "",
    risk: a.risk ?? "low",
    harness,
    harnesses: harness && !listed.includes(harness) ? [harness, ...listed] : listed,
    brief: typeof p.brief === "string" ? p.brief : null,
  };
}

const RISK: Record<string, string> = { low: "낮음", medium: "중간", high: "높음" };

export function approvalCard(v: ApprovalView, chosen: string | null): Card {
  const harness = chosen ?? v.harness;
  const text = [
    `*승인 요청* · 위험도 ${RISK[v.risk] ?? v.risk}`,
    escapeText(truncate(v.summary, 600)),
    v.brief ? `> ${escapeText(truncate(v.brief, 900)).replaceAll("\n", "\n> ")}` : "",
    harness ? `하네스: \`${escapeText(harness)}\`` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const rows: Row[] = [
    [
      { type: "button", id: ids.approve(v.approvalId), label: "승인", style: "primary" },
      { type: "button", id: ids.reject(v.approvalId), label: "거절", style: "danger" },
    ],
  ];
  if (v.harnesses.length > 1) {
    rows.push([
      {
        type: "select",
        id: ids.harness(v.approvalId),
        placeholder: "하네스 선택",
        options: v.harnesses.slice(0, 100).map((h) => ({ value: h, label: h, selected: h === harness })),
      },
    ]);
  }
  return { text, rows };
}

export function approvalDecidedCard(v: ApprovalView, d: { decision: string; note?: string | null; amend?: Record<string, unknown> | null }): Card {
  const amended = typeof d.amend?.harness === "string" ? d.amend.harness : null;
  const outcome =
    d.decision === "approve"
      ? `✅ 승인함${amended ? ` · 하네스 \`${escapeText(amended)}\`` : ""}`
      : d.note === "expired"
        ? "⌛ 기한이 지나 거절됨"
        : "❌ 거절함";
  return { text: `${approvalCard(v, amended).text}\n\n${outcome}`, rows: [] };
}

export interface TaskView {
  taskId: string;
  harness: string;
  state: string;
  resultText: string | null;
}

export const TASK_RESULT_MAX = 1500;

export function taskCard(t: TaskView): Card {
  const head = `*위임 결과* · \`${escapeText(t.harness)}\` · \`${t.taskId.slice(0, 8)}\``;
  const body = t.resultText?.trim() ? truncate(toMrkdwn(t.resultText.trim()), TASK_RESULT_MAX) : "(결과 텍스트 없음)";
  return {
    text: `${head}\n${body}`,
    rows: [
      [
        { type: "button", id: ids.task(t.taskId, "accept"), label: "수락", style: "primary" },
        { type: "button", id: ids.task(t.taskId, "reject"), label: "거절", style: "danger" },
        { type: "button", id: ids.task(t.taskId, "diff"), label: "diff", style: "default" },
      ],
    ],
  };
}

const TASK_STATE: Record<string, string> = {
  accepted: "✅ 수락함",
  applied: "✅ 수락해서 반영함",
  "apply-failed": "⚠️ 반영 실패",
  rejected: "❌ 거절함",
  cancelled: "🚫 취소됨",
};

export function taskClosedCard(text: string, state: string): Card {
  return { text: `${text}\n\n${TASK_STATE[state] ?? state}`, rows: [] };
}
