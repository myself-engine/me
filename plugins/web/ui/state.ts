// Client state: one reducer fed by the bootstrap snapshot and the server's WebSocket pushes.
import type { Access, Approval, Bootstrap, Effort, HeadAlert, HeadSettings, Message, Op, OpsCheck, PluginInfo, ServerMsg, Task, Thread } from "./api.ts";

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
  /** The latest blocking problem per cause; only active ones block. */
  alerts: Record<string, HeadAlert>;
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
      alerts: byId(a.data.alerts ?? [], "id"),
      config: { addedProjects: [], ...a.data.config },
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
      if (m.kind === "gjc-head.alert") return { ...s, alerts: { ...s.alerts, [m.id]: m.data } };
      if (m.kind === "kernel.plugin") return { ...s, plugins: { ...s.plugins, [m.id]: m.data } };
      if (m.kind === "kernel.op") return { ...s, ops: { ...s.ops, [m.id]: m.data } };
      if (m.kind === "ops.check") return { ...s, checks: { ...s.checks, [m.id]: m.data } };
      if (m.kind === "web.settings") {
        const addedProjects = (m.data.projects as string[]) ?? [];
        const base = s.config.projects.filter((p) => !(s.config.addedProjects ?? []).includes(p));
        return { ...s, config: { ...s.config, addedProjects, projects: [...new Set([...base, ...addedProjects])] } };
      }
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
  alerts: {},
  live: {},
  config: { projects: [], addedProjects: [], defaultProject: "", githubRepo: null },
  viewer: null,
};

/** Blocking problems that still need the user: active alerts, oldest first. */
export const activeAlerts = (s: State): HeadAlert[] =>
  Object.values(s.alerts)
    .filter((a) => a.active)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

/** A head choice for a thread or a new-thread draft; unset fields follow the defaults. */
export interface HeadChoice {
  model?: string | null;
  effort?: Effort | null;
  access?: Access | null;
}

/** The default access mode for new threads; older settings predate access modes. */
export const DEFAULT_ACCESS: Access = "project";
export const accessOf = (t: Thread | HeadChoice | null | undefined, d: HeadSettings | null): Access =>
  (t?.access as Access | null | undefined) || d?.access || DEFAULT_ACCESS;

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
    case "queued":
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
  /** The user's own words that started it, else the first line of the English brief. */
  title: string;
  objective: string;
  project: string;
  startedAt: string;
  updatedAt: string;
  task?: Task;
  approval?: Approval;
}

/** Delegation approvals carry the asking message id; other approvals are not work items. */
export const isDelegationApproval = (a: Approval) => typeof a.payload?.messageId === "string";

/**
 * The user's request behind an assistant message: the latest user message before it in the same thread.
 * Briefs are written in English for workers; people recognise their own words.
 */
export function requestText(s: State, messageId: string | undefined): string | null {
  const m = messageId ? s.messages[messageId] : undefined;
  if (!m) return null;
  let best: Message | null = null;
  for (const x of Object.values(s.messages))
    if (x.threadId === m.threadId && x.role === "user" && x.ts <= m.ts && (!best || x.ts > best.ts)) best = x;
  return best?.text.trim() || null;
}

/** A work title for lists and headers: the user's words (one line, 40 characters), else the brief's first line. */
export function taskTitle(s: State, p: { taskId?: string; messageId?: string; objective: string }): string {
  const messageId = p.messageId ?? Object.values(s.messages).find((m) => p.taskId && m.taskId === p.taskId)?.id;
  const text = requestText(s, messageId) ?? p.objective;
  const line = text.split("\n")[0]!.trim();
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

export function workItems(s: State): WorkItem[] {
  const items: WorkItem[] = Object.values(s.tasks).map((t) => ({
    id: t.taskId,
    state: t.state,
    harness: t.harness,
    title: taskTitle(s, { taskId: t.taskId, objective: t.objective }),
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
      title: taskTitle(s, { messageId: a.payload.messageId, objective: a.payload.brief ?? a.summary }),
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

/** Sidebar waiting word for a thread: 승인 (approval) · 검토 (result to review) · 답변 (head answering) · 실패. Null when idle. */
export function threadWait(s: State, threadId: string): "승인" | "검토" | "답변" | "실패" | null {
  let review = false;
  let answering = false;
  let failed = false;
  for (const m of Object.values(s.messages)) {
    if (m.threadId !== threadId || m.role !== "assistant") continue;
    if (Object.values(s.approvals).some((a) => a.payload?.messageId === m.id)) return "승인";
    const task = m.taskId ? s.tasks[m.taskId] : undefined;
    if (task && (task.state === "sealed" || task.state === "accepted" || task.state === "apply-failed")) review = true;
    else if (task && task.state === "failed") failed = true;
    else if (!task && (m.status === "pending" || m.status === "streaming")) answering = true;
    else if (task && (task.state === "running" || task.state === "queued" || task.state === "delegated")) answering = true;
  }
  if (review) return "검토";
  if (answering) return "답변";
  if (failed) return "실패";
  if (threadTone(s, threadId) === "failed") return "실패";
  return null;
}
/**
 * Sidebar preview: the latest reply's first line, markdown marks dropped and
 * capped at 80 characters. Null when no reply text exists yet (a failed reply
 * shows its 실패 wait word instead of raw error text).
 */
export function threadPreview(s: State, threadId: string): string | null {
  let best: Message | null = null;
  for (const m of Object.values(s.messages)) {
    if (m.threadId !== threadId || m.role !== "assistant" || !m.text.trim()) continue;
    if (!best || m.ts > best.ts) best = m;
  }
  if (!best) return null;
  const lines = best.text.split("\n").map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => !l.startsWith("#") && !l.startsWith("```")) ?? lines[0];
  const clean = line?.replace(/^[#>*\-\s]+/, "").replace(/[`*_]/g, "").trim() ?? "";
  return clean ? clean.slice(0, 80) : null;
}

/** Approvals not tied to a conversation (harness settings apply, ops actions): one sidebar entry opens them as a sheet. */
export const unlinkedApprovals = (s: State): Approval[] =>
  Object.values(s.approvals)
    .filter((a) => !isDelegationApproval(a))
    .sort((a, b) => String(a.approvalId).localeCompare(String(b.approvalId)));

/** The pending delegation approval for one thread, oldest first. */
export function threadApproval(s: State, threadId: string | null): Approval | undefined {
  if (!threadId) return undefined;
  return Object.values(s.approvals)
    .filter((a) => isDelegationApproval(a) && s.messages[a.payload?.messageId]?.threadId === threadId)
    .sort((a, b) => String(a.approvalId).localeCompare(String(b.approvalId)))[0];
}

export const activeOps = (s: State) =>
  Object.values(s.ops)
    .filter((o) => o.state === "running" || o.state === "waiting")
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
