// Client state: one reducer fed by the bootstrap snapshot and the server's WebSocket pushes.
import type { Approval, Bootstrap, Effort, HeadSettings, Message, Op, OpsCheck, PluginInfo, ServerMsg, Task, Thread } from "./api.ts";

/** What has streamed in for one request (by traceId) before the message entity catches up. */
export interface Live {
  messageId?: string;
  threadId?: string;
  text: string;
  thoughts: string;
  tools: { id: string; name: string; intent?: string; ok?: boolean }[];
  phaseLabel?: string;
  done: boolean;
  error?: string;
}

export interface State {
  ready: boolean;
  threads: Record<string, Thread>;
  messages: Record<string, Message>;
  tasks: Record<string, Task>;
  plugins: Record<string, PluginInfo>;
  ops: Record<string, Op>;
  checks: Record<string, OpsCheck>;
  approvals: Record<string, Approval>;
  /** The head's defaults and pickers; null until gjc-head has stored them. */
  headSettings: HeadSettings | null;
  live: Record<string, Live>;
  config: Bootstrap["config"];
  viewer: Bootstrap["viewer"];
}

export type Action = { type: "bootstrap"; data: Bootstrap } | { type: "server"; msg: ServerMsg };

const byId = <T,>(xs: T[], key: keyof T) => Object.fromEntries(xs.map((x) => [x[key] as string, x]));
const emptyLive = (): Live => ({ text: "", thoughts: "", tools: [], done: false });

export function reducer(s: State, a: Action): State {
  if (a.type === "bootstrap") {
    return {
      ...s,
      ready: true,
      threads: byId(a.data.threads, "id"),
      messages: byId(a.data.messages, "id"),
      tasks: byId(a.data.tasks, "taskId"),
      plugins: byId(a.data.plugins, "id"),
      ops: byId(a.data.ops ?? [], "opId"),
      checks: Object.fromEntries((a.data.checks ?? []).map((c) => [`${c.source ?? "ops"}/${c.id}`, c])),
      approvals: byId(a.data.approvals, "approvalId"),
      headSettings: a.data.headSettings ?? null,
      config: a.data.config,
      viewer: a.data.viewer ?? null,
    };
  }
  const m = a.msg;
  switch (m.type) {
    case "entity": {
      if (m.kind === "gjc-head.thread") return { ...s, threads: { ...s.threads, [m.id]: m.data } };
      if (m.kind === "gjc-head.message") return { ...s, messages: { ...s.messages, [m.id]: m.data } };
      if (m.kind === "brgr.task") return { ...s, tasks: { ...s.tasks, [m.id]: m.data } };
      if (m.kind === "gjc-head.settings") return { ...s, headSettings: m.data };
      if (m.kind === "kernel.plugin") return { ...s, plugins: { ...s.plugins, [m.id]: m.data } };
      if (m.kind === "kernel.op") return { ...s, ops: { ...s.ops, [m.id]: m.data } };
      if (m.kind === "ops.check") return { ...s, checks: { ...s.checks, [m.id]: m.data } };
      return s;
    }
    case "approval": {
      const approvals = { ...s.approvals };
      if (m.event === "kernel.approval.pending") approvals[m.data.approvalId] = m.data;
      else delete approvals[m.data.approvalId];
      return { ...s, approvals };
    }
    case "op.update": {
      const cur = s.live[m.traceId] ?? emptyLive();
      const u = m.update;
      const next: Live = { ...cur, tools: cur.tools };
      if (u.kind === "text_delta") next.text += u.delta;
      else if (u.kind === "thought_delta") next.thoughts += u.delta;
      else if (u.kind === "message") next.messageId = u.messageId;
      else if (u.kind === "thread") next.threadId = u.threadId;
      else if (u.kind === "phase") next.phaseLabel = u.label ?? u.phase;
      else if (u.kind === "tool_call") next.tools = [...cur.tools, { id: u.toolCallId, name: u.toolName, intent: u.intent }];
      else if (u.kind === "tool_result") next.tools = cur.tools.map((t) => (t.id === u.toolCallId ? { ...t, ok: u.ok } : t));
      else if (u.kind === "error") next.error = u.message;
      return { ...s, live: { ...s.live, [m.traceId]: next } };
    }
    case "op.end": {
      const cur = s.live[m.traceId] ?? emptyLive();
      return { ...s, live: { ...s.live, [m.traceId]: { ...cur, done: true, error: m.error ?? cur.error } } };
    }
    default:
      return s;
  }
}

export const initial: State = {
  ready: false,
  threads: {},
  messages: {},
  tasks: {},
  plugins: {},
  ops: {},
  checks: {},
  approvals: {},
  headSettings: null,
  live: {},
  config: { projects: [], defaultProject: "", githubRepo: null },
  viewer: null,
};

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

/** A head choice for a thread or a new-thread draft; unset fields follow the defaults. */
export interface HeadChoice {
  model?: string | null;
  effort?: Effort | null;
}

/** The model and effort a thread (or a draft) will reply with, and whether that is the default. */
export function headChoice(own: HeadChoice | null | undefined, d: HeadSettings | null): { model: string; effort: Effort; isDefault: boolean } | null {
  if (!d) return null;
  return { model: own?.model || d.model, effort: own?.effort ?? d.effort, isDefault: !own?.model && !own?.effort };
}

/** A model id without its provider, for chips: openai-codex/gpt-6.1-sol → gpt-6.1-sol. */
export const shortModel = (id: string) => id.slice(id.lastIndexOf("/") + 1);

/** Status tone: the only place colour carries meaning (Needs You / running / done / failed / muted). */
export type Tone = "needs" | "running" | "done" | "failed" | "muted" | "none";

export const TONE_LABEL: Record<Tone, string> = {
  needs: "확인 필요",
  running: "진행 중",
  done: "완료",
  failed: "실패",
  muted: "숨김",
  none: "",
};

export function toneOf(state: string): Tone {
  switch (state) {
    case "sealed":
    case "awaiting-input":
    case "apply-failed":
    case "awaiting-approval":
      return "needs";
    case "running":
    case "delegated":
    case "starting":
    case "accepted":
      return "running";
    case "applied":
      return "done";
    case "failed":
    case "quarantined":
    case "stopped":
      return "failed";
    case "rejected":
    case "cancelled":
      return "muted";
    default:
      return "none";
  }
}

/** A row on the tasks screen: a brgr task, or a delegation still waiting for approval (no task yet). */
export interface WorkItem {
  id: string;
  state: string;
  harness: string;
  objective: string;
  project: string;
  startedAt: string;
  updatedAt: string;
  task?: Task;
  approval?: Approval;
}

/** Delegation approvals carry the asking message id; other approvals are not work items. */
export const isDelegationApproval = (a: Approval) => typeof a.payload?.messageId === "string";

export function workItems(s: State): WorkItem[] {
  const items: WorkItem[] = Object.values(s.tasks).map((t) => ({
    id: t.taskId,
    state: t.state,
    harness: t.harness,
    objective: t.objective,
    project: t.project,
    startedAt: t.createdAt,
    updatedAt: t.updatedAt,
    task: t,
  }));
  for (const a of Object.values(s.approvals)) {
    if (!isDelegationApproval(a)) continue;
    const m = s.messages[a.payload.messageId];
    const at = m?.ts ?? new Date().toISOString();
    items.push({
      id: `approval:${a.approvalId}`,
      state: "awaiting-approval",
      harness: a.payload.harness ?? "",
      objective: a.payload.brief ?? a.summary,
      project: a.payload.project ?? "",
      startedAt: at,
      updatedAt: at,
      approval: a,
    });
  }
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

const TONE_RANK: Record<Tone, number> = { needs: 0, running: 1, failed: 2, done: 3, muted: 4, none: 5 };

/** A thread's representative status: Needs You > running > failed > done > nothing. Rejected and cancelled work stays quiet. */
export function threadTone(s: State, threadId: string): Tone {
  let best: Tone = "none";
  for (const m of Object.values(s.messages)) {
    if (m.threadId !== threadId || m.role !== "assistant") continue;
    let t: Tone = "none";
    const task = m.taskId ? s.tasks[m.taskId] : undefined;
    const waiting = Object.values(s.approvals).some((a) => a.payload?.messageId === m.id);
    if (waiting) t = "needs";
    else if (task) t = toneOf(task.state);
    else if (m.status === "pending" || m.status === "streaming") t = "running";
    if (t === "muted") t = "none";
    if (TONE_RANK[t] < TONE_RANK[best]) best = t;
  }
  return best;
}

/** The op serving a chat turn, while it is still running: its phase label is what the user is waiting on. */
export function turnOp(s: State, traceId: string): Op | undefined {
  return Object.values(s.ops).find((o) => o.traceId === traceId && o.callee === "gjc-head" && (o.state === "running" || o.state === "waiting"));
}

export const activeOps = (s: State) =>
  Object.values(s.ops)
    .filter((o) => o.state === "running" || o.state === "waiting")
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
