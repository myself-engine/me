// Message and thread shapes owned by the head. Pure data: stored as entities
// gjc-head.thread / gjc-head.message and streamed to the UI unchanged.

export interface Thread {
  id: string;
  title: string;
  project: string;
  sessionId: string | null;
  /** The head's model and effort for this thread; unset means the defaults in HeadSettings. */
  model?: string | null;
  effort?: Effort | null;
  /** Access mode of this conversation; unset means the default in HeadSettings. */
  access?: AccessMode | null;
  createdAt: string;
  updatedAt: string;
}

/** How far the head may go on its own in one conversation. */
export type AccessMode = "read" | "project" | "full";

/** GJC's thinking levels, used as the head's effort. */
export type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** One model GJC can run; `efforts` is null when GJC does not say which levels it takes. */
export interface ModelInfo {
  id: string;
  efforts: Effort[] | null;
}

/** The head's settings, stored as one entity so every screen sees changes live. */
export interface HeadSettings {
  id: "default";
  /** Defaults for new threads and threads without their own choice. */
  model: string;
  effort: Effort;
  /** Default access mode for new threads; "project" means delegate at once, apply after review. */
  access: AccessMode;
  /** Ordered fallback models for direct replies; empty means fail as today. */
  fallbackModels: string[];
  /** How long a failed model stays out of rotation, in seconds. */
  cooldownSec: number;
  /** Models shown first in pickers: config favourites plus the user's own, plus the default model. */
  favorites: string[];
  /** Models the user starred in the picker; persisted here. */
  userFavorites: string[];
  /** Favourites from config; the picker offers them but never removes them. */
  configFavorites: string[];
  efforts: Effort[];
  /** Choices offered when approving a delegation (config): favourite models per harness and effort levels. */
  workers: { models: Record<string, string[]>; efforts: string[] };
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
  /** How the delegation was approved: by the conversation mode or by the user at the approval card. */
  approvedBy?: "mode:project" | "mode:full" | "user";
  /** Worker model and effort picked at approval; unset means the harness's own default. */
  model?: string;
  effort?: string;
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
  /** Set when a fallback model wrote the reply: the failed primary, the model that answered, and why. */
  fallback?: { from: string; to: string; reason: string };
  error?: string;
  status: "pending" | "streaming" | "done" | "error";
}
