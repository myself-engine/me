// Operational actions a check may declare (restart a service, run a command). Pure: no I/O, no clock reads.
// The argv of every action is fixed when the config is parsed; nothing a caller sends ever becomes part of it.
import type { Status } from "./check.ts";

export type Risk = "medium" | "high";

export interface ActionSpec {
  id: string;
  /** Korean button label, e.g. "다시 시작". */
  label: string;
  kind: "systemd-user-restart" | "launchd-restart" | "command";
  /** Exactly what runs, without a shell. */
  argv: string[];
  timeoutMs: number;
  /** Never below medium: every action changes something. */
  risk: Risk;
}

/** What the check record shows about an action, so a screen can offer it and say what it runs. */
export type ActionInfo = Pick<ActionSpec, "id" | "label" | "argv" | "risk">;

export type ActionState = "waiting" | "running" | "done" | "failed" | "rejected";

/** The last run of an action on a check, kept on the check record (`lastAction`). */
export interface ActionRun {
  actionId: string;
  label: string;
  argv: string[];
  machine: string;
  state: ActionState;
  requestedAt: string;
  finishedAt?: string;
  exitCode?: number;
  timedOut?: boolean;
  /** Tail of stdout and stderr, capped at OUTPUT_LIMIT. */
  output?: string;
  /** Why it was rejected or failed before running. */
  note?: string;
  /** The check run right after the action, as observed (before flap confirmation). */
  recheck?: { status: Status; detail: string; checkedAt: string };
}

export const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
export const MAX_ACTION_TIMEOUT_MS = 600_000;
export const OUTPUT_LIMIT = 2_000;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
/** systemd unit and launchd job names: no option-looking names, no paths, no whitespace. */
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$/;
const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

export function parseAction(raw: any, uid: number | null): ActionSpec {
  if (!raw || typeof raw !== "object") throw new Error("action must be an object");
  if (!str(raw.id) || !ID_RE.test(raw.id)) throw new Error("action id must be a non-empty string of letters, digits, _ . : -");
  if (!str(raw.label)) throw new Error(`action ${raw.id} needs a label`);
  if (raw.risk !== undefined && !["low", "medium", "high"].includes(raw.risk)) throw new Error(`action ${raw.id}: risk must be medium or high`);
  const t = typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0 ? Math.floor(raw.timeoutMs) : DEFAULT_ACTION_TIMEOUT_MS;
  const base = { id: raw.id, label: raw.label.trim(), timeoutMs: Math.min(t, MAX_ACTION_TIMEOUT_MS), risk: (raw.risk === "high" ? "high" : "medium") as Risk };
  switch (raw.kind) {
    case "systemd-user-restart":
      if (!str(raw.unit) || !NAME_RE.test(raw.unit)) throw new Error(`action ${raw.id} needs a systemd unit name`);
      return { ...base, kind: raw.kind, argv: ["systemctl", "--user", "restart", raw.unit] };
    case "launchd-restart":
      if (!str(raw.job) || !NAME_RE.test(raw.job)) throw new Error(`action ${raw.id} needs a launchd job label`);
      if (uid === null) throw new Error(`action ${raw.id}: launchd actions need a user id`);
      return { ...base, kind: raw.kind, argv: ["launchctl", "kickstart", "-k", `gui/${uid}/${raw.job}`] };
    case "command":
      if (!Array.isArray(raw.argv) || raw.argv.length === 0 || !raw.argv.every((a: unknown) => typeof a === "string") || !str(raw.argv[0])) {
        throw new Error(`action ${raw.id} needs argv: a non-empty array of strings`);
      }
      return { ...base, kind: raw.kind, argv: [...raw.argv] };
    default:
      throw new Error(`action ${raw.id}: unknown kind ${String(raw.kind)}`);
  }
}

/** Parses `raw.actions` of one check. Any bad action rejects the whole check, so a typo never hides silently. */
export function parseActions(raw: unknown, uid: number | null): ActionSpec[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("actions must be an array");
  const seen = new Set<string>();
  return raw.map((a) => {
    const spec = parseAction(a, uid);
    if (seen.has(spec.id)) throw new Error(`duplicate action id: ${spec.id}`);
    seen.add(spec.id);
    return spec;
  });
}

export const actionInfo = (a: ActionSpec): ActionInfo => ({ id: a.id, label: a.label, argv: a.argv, risk: a.risk });

/** Shows argv as JSON strings so spaces and empty arguments are unambiguous. */
export const showArgv = (argv: string[]) => argv.map((a) => JSON.stringify(a)).join(" ");

/** The approval summary: what runs, on which machine, for which check. */
export function approvalSummary(checkId: string, action: ActionSpec, machine: string): string {
  return `${machine}에서 실행: ${showArgv(action.argv)} — 점검 ${checkId}의 '${action.label}'`;
}

/** Keeps the end of the output, where errors usually are. */
export function captureOutput(stdout: string, stderr: string, limit = OUTPUT_LIMIT): string {
  const text = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return text.length <= limit ? text : `…${text.slice(text.length - limit + 1)}`;
}

/** The run after exec: done only on a clean exit with the expected code 0. */
export function finishRun(
  run: ActionRun,
  r: { code: number; stdout: string; stderr: string; timedOut: boolean; spawnError?: string },
  nowIso: string,
  timeoutMs: number,
): ActionRun {
  if (r.spawnError) return { ...run, state: "failed", finishedAt: nowIso, note: `실행하지 못했어요: ${r.spawnError.slice(0, 200)}` };
  const output = captureOutput(r.stdout, r.stderr);
  const base = { ...run, finishedAt: nowIso, exitCode: r.code, ...(output ? { output } : {}) };
  if (r.timedOut) return { ...base, state: "failed", timedOut: true, note: `${Math.round(timeoutMs / 1000)}초 안에 끝나지 않아 멈췄어요` };
  return { ...base, state: r.code === 0 ? "done" : "failed" };
}

/** A run left waiting or running by a previous process can no longer finish; close it on load. */
export function closeStale(run: ActionRun | null | undefined, nowIso: string): ActionRun | null {
  if (!run) return null;
  if (run.state === "waiting" || run.state === "running") return { ...run, state: "failed", finishedAt: nowIso, note: "ops가 다시 시작되어 결과를 알 수 없어요" };
  return run;
}
