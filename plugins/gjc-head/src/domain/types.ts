// Message and thread shapes owned by the head. Pure data: stored as entities
// gjc-head.thread / gjc-head.message and streamed to the UI unchanged.

export interface Thread {
  id: string;
  title: string;
  project: string;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DelegationState = "awaiting-approval" | "rejected" | "delegated" | "running" | "sealed" | "accepted" | "failed" | "awaiting-input" | "cancelled" | "applied" | "apply-failed";

export type Route = "direct" | "delegate";

export interface Understood {
  normalized: string;
  replaced: { from: string; to: string }[];
}

export interface Summary {
  summaryEn: string;
  brief: string;
  needsCodeChange: boolean;
  scope: string;
  harness: string;
  harnessReason: string;
  /** One observable English sentence saying when the work is done. */
  criterion?: string;
  role?: string;
}

export interface Judgement {
  simpleProb: number;
  confidence: number;
  /** "jev" | "fallback" from the jev plugin, "fast-path" from the head's own rule. */
  source: string;
  model: string;
}

export interface Delegation {
  state: DelegationState;
  /** The harness actually used: the decider's amend if any, else the summarizer's suggestion. */
  harness: string;
  /** The summarizer's suggestion, kept when the decider picked another harness. */
  suggestedHarness?: string;
  brief: string;
  criterion?: string;
  approvalId?: string;
  note?: string;
}

export interface Message {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  text: string;
  ts: string;
  traceId: string;
  understood?: Understood;
  summary?: Summary;
  judgement?: Judgement;
  route?: Route;
  /** Top-level so entity.list can find the message by task. */
  taskId?: string | null;
  delegation?: Delegation;
  error?: string;
  status: "pending" | "streaming" | "done" | "error";
}
