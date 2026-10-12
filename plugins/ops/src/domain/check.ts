// Check specs and status transitions. Pure: no I/O, no clock reads.
import { parseActions, type ActionInfo, type ActionRun, type ActionSpec } from "./action.ts";

export type Status = "up" | "down" | "unknown";

export type CheckSpec = (
  | { id: string; kind: "http"; url: string; expectStatus: number; timeoutMs: number; contains?: string }
  | { id: string; kind: "tcp"; host: string; port: number; timeoutMs: number }
  | { id: string; kind: "process"; match: string }
  | { id: string; kind: "launchd"; label: string }
  | { id: string; kind: "herdr-pane"; paneId: string }
  | { id: string; kind: "command"; argv: string[]; expectExit: number; timeoutMs: number }
) & {
  /** Operational actions offered on this check; each runs only after the user approves it. */
  actions?: ActionSpec[];
};

export type CheckKind = CheckSpec["kind"];

/** What one probe run observed. */
export interface Observation {
  status: Status;
  detail: string;
  latencyMs: number;
}

/** The stored record (entity kind `ops.check`). */
export interface CheckRecord {
  id: string;
  kind: CheckKind;
  ok: boolean;
  status: Status;
  detail: string;
  latencyMs: number;
  checkedAt: string;
  /** When the current status started. */
  since: string;
  /** Actions offered on this check (set by the service, not by observe). */
  actions?: ActionInfo[];
  /** The last action run on this check, if any. */
  lastAction?: ActionRun | null;
}

/** In-memory state per check: the confirmed record plus a candidate status that has not been confirmed yet. */
export interface CheckState {
  record: CheckRecord | null;
  pending: { status: Status; count: number } | null;
}

export interface Transition {
  state: CheckState;
  /** Set when the confirmed status changed on this observation. */
  changed: { from: Status | null; to: Status } | null;
}

export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_INTERVAL_SEC = 60;
/** Consecutive identical observations needed before a known status flips. */
export const DEFAULT_CONFIRM = 2;
/** A stored record whose summary has not changed is rewritten at most this often, so checkedAt stays recent. */
export const DEFAULT_HEARTBEAT_SEC = 600;

/**
 * Whether a new record must be stored: its summary (status, since, detail) differs from the last stored one,
 * or the last store is at least `heartbeatMs` old. checkedAt and latencyMs alone do not count as changes.
 */
export function needsStore(stored: { record: CheckRecord; at: number } | null, next: CheckRecord, now: number, heartbeatMs: number): boolean {
  if (!stored) return true;
  const a = stored.record;
  if (a.status !== next.status || a.ok !== next.ok || a.since !== next.since || a.detail !== next.detail || a.kind !== next.kind) return true;
  if (JSON.stringify(a.actions ?? []) !== JSON.stringify(next.actions ?? [])) return true;
  if (JSON.stringify(a.lastAction ?? null) !== JSON.stringify(next.lastAction ?? null)) return true;
  return now - stored.at >= heartbeatMs;
}

/**
 * Applies one observation. The first observation of a check is taken as-is. After that, a different status
 * must be seen `confirm` times in a row before it replaces the current one, so a single blip does not flap.
 * While unconfirmed, the record keeps its status but its detail, latency and checkedAt reflect the latest run.
 */
export function observe(prev: CheckState, spec: Pick<CheckSpec, "id" | "kind">, obs: Observation, nowIso: string, confirm = DEFAULT_CONFIRM): Transition {
  const base = { id: spec.id, kind: spec.kind, detail: obs.detail, latencyMs: Math.round(obs.latencyMs), checkedAt: nowIso };
  const cur = prev.record;
  if (!cur) {
    const record = { ...base, ok: obs.status === "up", status: obs.status, since: nowIso };
    return { state: { record, pending: null }, changed: { from: null, to: obs.status } };
  }
  if (obs.status === cur.status) {
    return { state: { record: { ...cur, ...base }, pending: null }, changed: null };
  }
  const count = prev.pending?.status === obs.status ? prev.pending.count + 1 : 1;
  if (count < Math.max(1, confirm)) {
    const detail = `${obs.status} ${count}/${confirm}: ${obs.detail}`;
    return { state: { record: { ...cur, ...base, detail }, pending: { status: obs.status, count } }, changed: null };
  }
  const record = { ...base, ok: obs.status === "up", status: obs.status, since: nowIso };
  return { state: { record, pending: null }, changed: { from: cur.status, to: obs.status } };
}

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

export interface OpsConfig {
  checks: CheckSpec[];
  intervalSec: number;
  /** Delay before the first run, so checks of things started alongside me don't report down at boot. */
  startDelaySec: number;
  confirm: number;
  /** Unchanged records are rewritten at most this often; see needsStore. */
  heartbeatSec: number;
  /** Checks that were rejected, with the reason; they are reported but never run. */
  errors: { index: number; id: string | null; error: string }[];
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const posInt = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback);
const int = (v: unknown, fallback: number) => (typeof v === "number" && Number.isInteger(v) ? v : fallback);

function parseCheck(raw: any, uid: number | null): CheckSpec {
  const spec = parseProbe(raw);
  const actions = parseActions(raw.actions, uid);
  return actions.length ? { ...spec, actions } : spec;
}

function parseProbe(raw: any): CheckSpec {
  if (!raw || typeof raw !== "object") throw new Error("check must be an object");
  const id = raw.id;
  if (!str(id) || !ID_RE.test(id)) throw new Error("id must be a non-empty string of letters, digits, _ . : -");
  const timeoutMs = posInt(raw.timeoutMs, DEFAULT_TIMEOUT_MS);
  switch (raw.kind) {
    case "http": {
      if (!str(raw.url) || !/^https?:\/\//.test(raw.url)) throw new Error("http check needs an http(s) url");
      return { id, kind: "http", url: raw.url, expectStatus: int(raw.expectStatus, 200), timeoutMs, ...(str(raw.contains) ? { contains: raw.contains } : {}) };
    }
    case "tcp": {
      if (!str(raw.host)) throw new Error("tcp check needs a host");
      if (!Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) throw new Error("tcp check needs a port 1-65535");
      return { id, kind: "tcp", host: raw.host, port: raw.port, timeoutMs };
    }
    case "process":
      if (!str(raw.match)) throw new Error("process check needs a match string");
      return { id, kind: "process", match: raw.match };
    case "launchd":
      if (!str(raw.label) || /[/\s]/.test(raw.label)) throw new Error("launchd check needs a label without slashes or spaces");
      return { id, kind: "launchd", label: raw.label };
    case "herdr-pane":
      if (!str(raw.paneId) || raw.paneId.startsWith("-")) throw new Error("herdr-pane check needs a paneId");
      return { id, kind: "herdr-pane", paneId: raw.paneId };
    case "command":
      if (!Array.isArray(raw.argv) || raw.argv.length === 0 || !raw.argv.every((a: unknown) => typeof a === "string") || !str(raw.argv[0])) {
        throw new Error("command check needs argv: a non-empty array of strings");
      }
      return { id, kind: "command", argv: [...raw.argv], expectExit: int(raw.expectExit, 0), timeoutMs };
    default:
      throw new Error(`unknown check kind: ${String(raw.kind)}`);
  }
}

/** `uid` resolves launchd action targets (`gui/<uid>/<job>`); without it launchd actions are rejected. */
export function parseConfig(config: Record<string, unknown> | undefined, opts: { uid?: number | null } = {}): OpsConfig {
  const rawChecks = Array.isArray(config?.checks) ? (config!.checks as unknown[]) : [];
  const checks: CheckSpec[] = [];
  const errors: OpsConfig["errors"] = [];
  const seen = new Set<string>();
  rawChecks.forEach((raw: any, index) => {
    const id = typeof raw?.id === "string" ? raw.id : null;
    try {
      const spec = parseCheck(raw, opts.uid ?? null);
      if (seen.has(spec.id)) throw new Error(`duplicate id: ${spec.id}`);
      seen.add(spec.id);
      checks.push(spec);
    } catch (err) {
      errors.push({ index, id, error: (err as Error).message });
    }
  });
  return {
    checks,
    intervalSec: posInt(config?.intervalSec, DEFAULT_INTERVAL_SEC),
    startDelaySec: typeof config?.startDelaySec === "number" && config.startDelaySec >= 0 ? config.startDelaySec : 0,
    confirm: posInt(config?.confirm, DEFAULT_CONFIRM),
    heartbeatSec: posInt(config?.heartbeatSec, DEFAULT_HEARTBEAT_SEC),
    errors,
  };
}
