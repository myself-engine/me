// What the head's use case needs from the outside world. Adapters implement these over
// the kernel SDK and the runners; the use case and domain never import either directly.
import type { HeadHarness, RunnerUpdate } from "@me/runner";
import type { AlertCause, HeadAlert } from "../domain/alerts.ts";
import type { Effort, HeadSettings, Judgement, Message, ModelInfo, Summary, Thread, Understood } from "../domain/types.ts";

/** Streamed output of the head's own reply; kinds match the chat.send op.update contract. */
export type BrainUpdate = RunnerUpdate;

export interface BrainReply {
  text: string;
  sessionId: string | null;
  /** Set when the model tried to run a tool; the run was aborted. */
  violation: { toolName: string } | null;
}

/** A brain already started for one thread, waiting for its prompt. */
export interface WarmBrain {
  reply(p: { prompt: string; signal: AbortSignal; onUpdate: (u: BrainUpdate) => void }): Promise<BrainReply>;
  cancel(): void;
}

/** Which harness and model the head replies with, and how hard it thinks. */
export interface BrainChoice {
  harness: HeadHarness;
  model: string;
  effort: Effort;
}

export interface Brain {
  /** Generates a direct reply, resuming the thread's conversation when sessionId is set. Routing by `harness` happens above; each adapter serves one harness. */
  reply(p: { prompt: string; sessionId: string | null; signal: AbortSignal; onUpdate: (u: BrainUpdate) => void } & BrainChoice): Promise<BrainReply>;
  /** Optional: start early so startup overlaps with judging; used only if the answer is direct. */
  prepare?(p: { sessionId: string | null } & BrainChoice): WarmBrain;
}

/** The models each head harness could run. */
export interface ModelCatalog {
  list(harness: HeadHarness): Promise<ModelInfo[]>;
}

export interface Normalizer {
  normalize(text: string): Promise<Understood>;
}

export interface Summarizer {
  summarize(p: { original: string; normalized: string; harnesses: string[]; project: string }): Promise<Summary>;
}

export interface Judge {
  /** `request` is the normalized user text; Jev judges Korean directly (10/10 on a live sample, 2026-10-11). */
  judge(p: { request: string; needsCodeChange?: boolean; scope?: string }): Promise<Judgement>;
}

export interface ApprovalOutcome {
  approvalId: string;
  decision: "approve" | "reject";
  note?: string;
  amend?: Record<string, unknown>;
}

export interface Approvals {
  /** Resolves once the user decides or the request expires. */
  request(p: { summary: string; risk: "low" | "medium" | "high"; payload: Record<string, unknown>; expiresInSec: number }): Promise<ApprovalOutcome>;
}

export interface Delegator {
  delegate(p: { harness: string; model?: string; effort?: string; objective: string; criterion?: string; project: string; origin: Record<string, unknown>; autoApply?: boolean }): Promise<{ taskId: string }>;
}

export interface Store {
  registerKinds(): Promise<void>;
  getThread(id: string): Promise<Thread | null>;
  saveThread(t: Thread): Promise<void>;
  saveMessage(m: Message): Promise<void>;
  messagesByTask(taskId: string): Promise<Message[]>;
  getSettings(): Promise<HeadSettings | null>;
  saveSettings(s: HeadSettings): Promise<void>;
  listAlerts(): Promise<HeadAlert[]>;
  saveAlert(a: HeadAlert): Promise<void>;
  clearAlert(cause: AlertCause): Promise<void>;
}

export interface Events {
  messageChanged(m: Message): Promise<void>;
  guardViolation(p: { messageId: string; toolName: string }): Promise<void>;
}

/** One chat.send call: where its op.updates go and how it is cancelled. */
export interface Turn {
  update(u: Record<string, unknown> & { kind: string }): void;
  /** Standard progress phase recorded by the kernel on the op (see PROTOCOL §15). */
  phase?(phase: string, label?: string, progress?: number): void;
  signal: AbortSignal;
  traceId: string;
}
