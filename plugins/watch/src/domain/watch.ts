// Watch domain: pure mapping and stall rules over Herdr agent snapshots.
// No I/O here; polling, exec and the clock live in adapters/app.
export type AgentState = "working" | "waiting-input" | "idle" | "done" | "unknown";

export interface AgentSnapshot {
  pane: string;
  kind: string;
  cwd: string | null;
  project: string | null;
  state: AgentState;
  /** Monotonic screen/output marker from Herdr (revision or state_change_seq). */
  revision: number | null;
  /** When this state started (ISO), or null when unknown. */
  since: string | null;
}

export interface WatchAgent {
  pane: string;
  kind: string;
  cwd: string | null;
  project: string | null;
  state: AgentState;
  since: string;
  lastChangeAt: string;
  /** Set when the pane's output names a brgr task (brgr/task-<id>). */
  brgrTaskId: string | null;
  stalled: boolean;
  /** Short redacted excerpt kept only when a stall was flagged. */
  stallExcerpt: string | null;
  /** Why the stall was flagged: "idle-timeout" or "repeated-failure". */
  stallReason: string | null;
}

export interface TrackedAgent extends WatchAgent {
  /** Last seen screen marker; compared across polls to detect progress. */
  revision: number | null;
  /** Last N output lines (redacted), for the repeated-failure rule. */
  recentLines: string[];
  /** Failure signature that already raised a stall event (avoids repeats). */
  flaggedSignature: string | null;
}

/** Herdr agent_status values mapped to watch states. Unknown strings stay unknown. */
export function mapState(status: unknown): AgentState {
  switch (String(status ?? "").toLowerCase()) {
    case "working":
      return "working";
    case "waiting-input":
    case "waiting":
    case "awaiting-input":
    case "awaiting_input":
    case "blocked":
      return "waiting-input";
    case "idle":
      return "idle";
    case "done":
      return "done";
    default:
      return "unknown";
  }
}

/** One agent row from `herdr agent list` (parsed JSON, never layout-derived). */
export function snapshotOf(raw: unknown): AgentSnapshot | null {
  const row = raw as Record<string, unknown> | null;
  const pane = typeof row?.pane_id === "string" && row.pane_id ? row.pane_id : null;
  if (!pane) return null;
  const kind = typeof row?.agent === "string" && row.agent ? row.agent : "unknown";
  const cwd = typeof row?.cwd === "string" && row.cwd ? row.cwd : (typeof row?.foreground_cwd === "string" && row.foreground_cwd ? row.foreground_cwd : null);
  const revision = typeof row?.revision === "number" && Number.isFinite(row.revision)
    ? row.revision
    : (typeof row?.state_change_seq === "number" && Number.isFinite(row.state_change_seq) ? row.state_change_seq : null);
  const since = typeof row?.since === "string" ? row.since : typeof row?.state_since === "string" ? row.state_since : null;
  return { pane, kind, cwd, project: cwd, state: mapState(row?.agent_status), revision, since };
}

/** Herdr agent list emits an RPC envelope whose result contains agents. */
export function snapshotsOf(output: string): AgentSnapshot[] {
  const parsed: unknown = JSON.parse(output);
  const root = parsed as { result?: { agents?: unknown[] }; agents?: unknown[] };
  const rows = Array.isArray(root) ? root : root?.result?.agents ?? root?.agents;
  if (!Array.isArray(rows)) throw new Error("herdr agent list response has no agents array");
  return rows.map(snapshotOf).filter((row): row is AgentSnapshot => row !== null);
}

/** Maps a running brgr session pane to its task identity. */
export function brgrPanesOf(output: string): Map<string, string> {
  const parsed: unknown = JSON.parse(output);
  const root = parsed as { result?: unknown; tasks?: unknown[]; task?: unknown };
  const result = (root?.result ?? parsed) as { tasks?: unknown[]; task?: unknown };
  const tasks = Array.isArray(result?.tasks) ? result.tasks : result?.task ? [result.task] : [];
  const panes = new Map<string, string>();
  for (const value of tasks) {
    const task = value as Record<string, unknown>;
    const session = task.session as Record<string, unknown> | null;
    const pane = typeof session?.pane === "string" ? session.pane : null;
    const id = typeof task.taskId === "string" ? task.taskId : typeof task.task_id === "string" ? task.task_id : null;
    const state = String(task.state ?? "");
    if (pane && id && ["running", "awaiting-input", "awaiting_input"].includes(state)) panes.set(pane, id);
  }
  return panes;
}

/** Failure-looking lines: error words, non-zero exits, test failures. */
const FAILURE_RES = [/\berror\b/i, /\bfailed\b/i, /\bfailure\b/i, /exit (code )?[^0\s]/i, /Traceback /i, /FAIL/i];

/** Normalizes a line for repeat comparison: trims, drops counters and timings. */
export function failureKey(line: string): string | null {
  const t = line.trim().replace(/\s+/g, " ").slice(0, 200);
  if (t.length < 8) return null;
  if (!FAILURE_RES.some((re) => re.test(t))) return null;
  // Drop volatile tails: timings (12s, 3m 4s), counts (1/3), token numbers.
  return t.replace(/\(?\d[\d.,]*\s*(ms|s|sec|secs|m|min|mins)\)?/gi, "#").replace(/\b\d+\/\d+\b/g, "#").replace(/\b\d{4,}\b/g, "#").slice(0, 160);
}

/**
 * Same failure text 3 times in recent output => stalled.
 * Returns the repeated key, or null.
 */
export function repeatedFailure(lines: string[]): string | null {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const key = failureKey(line);
    if (!key) continue;
    const n = (counts.get(key) ?? 0) + 1;
    if (n >= 3) return key;
    counts.set(key, n);
  }
  return null;
}

/** New tracked entry for a first-seen pane. */
export function trackNew(snap: AgentSnapshot, nowIso: string, brgrTaskId: string | null): TrackedAgent {
  return {
    pane: snap.pane, kind: snap.kind, cwd: snap.cwd, project: snap.project, state: snap.state,
    since: snap.since ?? nowIso, lastChangeAt: nowIso, brgrTaskId, stalled: false, stallExcerpt: null, stallReason: null,
    revision: snap.revision, recentLines: [], flaggedSignature: null,
  };
}

/** Public view of a tracked agent (drops the internal line buffer). */
export function viewOf(t: TrackedAgent): WatchAgent {
  const { recentLines: _r, revision: _v, flaggedSignature: _f, ...view } = t;
  return view;
}

export interface StallCheck {
  stalled: boolean;
  reason: "idle-timeout" | "repeated-failure" | null;
  excerpt: string | null;
}

/**
 * Stall rules (notify only, never auto-cancel):
 * (a) no screen change for stallMs while working/waiting-input on a brgr task;
 * (b) the same failure text 3 times in recent output.
 */
export function checkStall(tracked: TrackedAgent, nowMs: number, stallMs: number, excerptLines: string[]): StallCheck {
  if (tracked.brgrTaskId) {
    if (nowMs - Date.parse(tracked.lastChangeAt) >= stallMs) {
      return { stalled: true, reason: "idle-timeout", excerpt: excerptLines.slice(-3).join("\n").slice(0, 500) || null };
    }
  }
  const key = repeatedFailure(tracked.recentLines);
  if (key && key !== tracked.flaggedSignature) {
    return { stalled: true, reason: "repeated-failure", excerpt: key.slice(0, 500) };
  }
  return { stalled: false, reason: null, excerpt: null };
}
