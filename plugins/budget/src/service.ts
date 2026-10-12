// Budget service: counts delegations from brgr task events and gates new ones on caps plus meter quota.
// Wired to the kernel in main.ts; tests inject fake exec, store and clock here.

import {
  capReason,
  evaluateQuota,
  harnessProvider,
  localDay,
  parseMeterOutput,
  usagesFor,
  type BudgetConfig,
  type MeterSnapshot,
} from "./budget.ts";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

export interface Exec {
  run(argv: string[], timeoutMs: number): Promise<ExecResult>;
}

export interface DayRecord {
  id: string;
  date: string;
  delegations: number;
  autoApplied: number;
  updatedAt: string;
}

export interface MeterSummary {
  provider: string;
  bucket: string;
  remainingPercent: number;
  resetAt?: string;
}

export interface SummaryRecord {
  id: string;
  date: string;
  delegations: number;
  dailyCap: number;
  autoApplied: number;
  autoApplyCap: number;
  meters: MeterSummary[];
  problem: string | null;
  updatedAt: string;
}

export interface BudgetStore {
  getDay(id: string): Promise<DayRecord | null>;
  putDay(d: DayRecord): Promise<void>;
  getTask(taskId: string): Promise<{ autoApply?: boolean } | null>;
  putSummary(s: SummaryRecord): Promise<void>;
}

export interface CheckParams {
  harness?: string;
  project?: string;
  autoApply?: boolean;
  model?: string;
}

export interface CheckResult {
  ok: boolean;
  needsApproval?: true;
  reason?: string;
}

export type StatusResult = Omit<SummaryRecord, "id">;

export function createBudgetService(deps: { config: BudgetConfig; exec: Exec; store: BudgetStore; now?: () => number }) {
  const now = deps.now ?? Date.now;
  let cached: { at: number; snapshots: MeterSnapshot[] } | null = null;
  let problem: string | null = null;
  // Event bumps are read-modify-write; serialize them so concurrent events cannot lose a count.
  let tail: Promise<void> = Promise.resolve();

  const iso = () => new Date(now()).toISOString();

  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function getDay(id: string): Promise<DayRecord> {
    const d = await deps.store.getDay(id);
    return d ?? { id, date: id, delegations: 0, autoApplied: 0, updatedAt: iso() };
  }

  /** Meter is best-effort: missing or broken output never blocks, it only sets the status problem. */
  async function readMeter(): Promise<MeterSnapshot[] | null> {
    if (cached && now() - cached.at < deps.config.cacheSec * 1000) return cached.snapshots;
    let r: ExecResult;
    try {
      r = await deps.exec.run(deps.config.meterCmd, deps.config.meterTimeoutMs);
    } catch (err) {
      problem = `meter를 실행하지 못했어요(${String((err as Error)?.message ?? err).slice(0, 120)}) · 한도 확인 없이 진행해요`;
      return null;
    }
    if (r.timedOut || r.spawnError || r.code !== 0) {
      const cause = (r.spawnError || r.stderr.trim() || `종료 코드 ${r.code}`).slice(0, 120);
      problem = `meter 상태를 읽지 못했어요(${cause}) · 한도 확인 없이 진행해요`;
      return null;
    }
    try {
      const snapshots = parseMeterOutput(r.stdout);
      cached = { at: now(), snapshots };
      problem = null;
      return snapshots;
    } catch {
      problem = "meter 답을 이해하지 못했어요 · 한도 확인 없이 진행해요";
      return null;
    }
  }

  /** Called by brgr before each delegation. Reads counts and quota; writes nothing. */
  async function check(p: CheckParams = {}): Promise<CheckResult> {
    const day = await getDay(localDay(now()));
    if (day.delegations >= deps.config.dailyCap)
      return { ok: false, reason: capReason("delegations", day.delegations, deps.config.dailyCap) };
    if (p.autoApply && day.autoApplied >= deps.config.autoApplyCap)
      return { ok: false, reason: capReason("auto", day.autoApplied, deps.config.autoApplyCap) };
    const provider = harnessProvider(p.harness, p.model, deps.config);
    if (!provider) return { ok: true };
    const snapshots = await readMeter();
    if (!snapshots) return { ok: true };
    const v = evaluateQuota(usagesFor(snapshots, provider), deps.config);
    if (!v.ok) return { ok: false, reason: v.reason };
    if (v.needsApproval) return { ok: true, needsApproval: true, reason: v.reason };
    return { ok: true };
  }

  /** Today's counts, caps, last meter summary and any problem; persists the day and summary entities. */
  async function status(): Promise<StatusResult> {
    const date = localDay(now());
    const day = await getDay(date);
    const snapshots = await readMeter();
    const meters: MeterSummary[] = [];
    if (snapshots) {
      // Only providers a configured harness can use; unmapped quota (e.g. an idle plan elsewhere) is not our budget.
      const wanted = new Set([...Object.values(deps.config.providers), deps.config.opencodeProvider]);
      const providers = [...new Set(snapshots.map((s) => s.provider))].filter((p) => wanted.has(p)).sort();
      for (const provider of providers) {
        const usages = usagesFor(snapshots, provider);
        if (usages.length === 0) continue;
        let worst = usages[0] as NonNullable<(typeof usages)[number]>;
        for (const u of usages) {
          if (u.remainingPercent < worst.remainingPercent) worst = u;
        }
        meters.push({
          provider,
          bucket: worst.bucket,
          remainingPercent: Math.round(worst.remainingPercent * 10) / 10,
          ...(worst.resetAt ? { resetAt: worst.resetAt } : {}),
        });
      }
    }
    const result: StatusResult = {
      date,
      delegations: day.delegations,
      dailyCap: deps.config.dailyCap,
      autoApplied: day.autoApplied,
      autoApplyCap: deps.config.autoApplyCap,
      meters,
      problem,
      updatedAt: iso(),
    };
    await deps.store.putDay({ ...day, updatedAt: result.updatedAt });
    await deps.store.putSummary({ id: "current", ...result });
    return result;
  }

  /** Counts delegations (running) and auto-applied ones (applied with autoApply) per local day. */
  async function onEvent(name: string, data: unknown): Promise<void> {
    if (name === "brgr.task.running") {
      await serialize(async () => {
        const d = await getDay(localDay(now()));
        d.delegations += 1;
        d.updatedAt = iso();
        await deps.store.putDay(d);
      });
      return;
    }
    if (name === "brgr.task.applied") {
      const taskId = (data as { taskId?: unknown } | null)?.taskId;
      if (typeof taskId !== "string" || !taskId) return;
      const task = await deps.store.getTask(taskId).catch(() => null);
      if (!task?.autoApply) return;
      await serialize(async () => {
        const d = await getDay(localDay(now()));
        d.autoApplied += 1;
        d.updatedAt = iso();
        await deps.store.putDay(d);
      });
    }
  }

  return { check, status, onEvent };
}

export type BudgetService = ReturnType<typeof createBudgetService>;
