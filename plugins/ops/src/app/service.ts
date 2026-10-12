// Use cases of the ops plugin, written against ports only. Checks only observe and report. An action changes
// something, so it runs only after the kernel approval gate says approve, and its argv comes only from config.
import { actionInfo, approvalSummary, closeStale, finishRun, type ActionRun, type ActionSpec } from "../domain/action.ts";
import { needsStore, observe, type CheckRecord, type CheckSpec, type CheckState, type OpsConfig } from "../domain/check.ts";
import type { Approvals, CheckStore, Clock, Events, Exec, Probe } from "../ports/index.ts";

export interface ServiceDeps {
  config: OpsConfig;
  probe: Probe;
  clock: Clock;
  store: CheckStore;
  events: Events;
  /** Runs approved actions. Without exec and approvals, actions.run refuses every action. */
  exec?: Exec;
  approvals?: Approvals;
  /** Named in every approval summary, e.g. "rapi-agent (ops-rapi)". */
  machine?: string;
  /** Wait between an action and its re-check, so a restarted service has a moment to come up. */
  actionSettleMs?: number;
  /** Results kept per check for checks.history. */
  historySize?: number;
  log?: (msg: string) => void;
}

export interface HistoryEntry {
  status: CheckRecord["status"];
  detail: string;
  latencyMs: number;
  checkedAt: string;
}

const DEFAULT_HISTORY = 200;
const MAX_HISTORY_LIMIT = 1000;
const DEFAULT_SETTLE_MS = 3_000;
/** An unanswered approval rejects itself after this long (kernel note "expired"). */
const APPROVAL_EXPIRY_SEC = 600;

/** The record without the parts the service adds, so observe() only ever sees check fields. */
const plain = ({ actions: _a, lastAction: _l, ...r }: CheckRecord): CheckRecord => r;

export function createService(deps: ServiceDeps) {
  const { config, probe, clock, store, events } = deps;
  const machine = deps.machine ?? "this machine";
  const settleMs = deps.actionSettleMs ?? DEFAULT_SETTLE_MS;
  const historySize = deps.historySize ?? DEFAULT_HISTORY;
  const log = deps.log ?? ((m: string) => console.error(`[ops] ${m}`));
  const specs = new Map(config.checks.map((c) => [c.id, c]));
  const states = new Map<string, CheckState>(config.checks.map((c) => [c.id, { record: null, pending: null }]));
  const history = new Map<string, HistoryEntry[]>(config.checks.map((c) => [c.id, []]));
  const inflight = new Map<string, Promise<CheckRecord>>();
  /** The last record written to the store per check, and when (clock ms). */
  const stored = new Map<string, { record: CheckRecord; at: number }>();
  /** The last action run per check, shown on its record as `lastAction`. */
  const lastActions = new Map<string, ActionRun>();
  /** At most one action per check is waiting or running. */
  const actionInflight = new Map<string, Promise<void>>();
  let stopTimer: (() => void) | null = null;

  const iso = () => new Date(clock.now()).toISOString();

  /** Seeds state from stored records so a restart keeps `since` and does not re-announce known statuses. */
  async function load() {
    for (const r of await store.list()) {
      const spec = specs.get(r.id);
      if (spec && spec.kind === r.kind) {
        states.set(r.id, { record: plain(r), pending: null });
        stored.set(r.id, { record: r, at: Date.parse(r.checkedAt) || 0 });
        const last = closeStale(r.lastAction, iso());
        if (last) lastActions.set(r.id, last);
      }
    }
  }

  function remember(id: string, r: CheckRecord) {
    const ring = history.get(id)!;
    ring.push({ status: r.status, detail: r.detail, latencyMs: r.latencyMs, checkedAt: r.checkedAt });
    if (ring.length > historySize) ring.splice(0, ring.length - historySize);
  }

  /** The record as stored and listed: the check's own fields plus its actions and last action run. */
  function decorate(spec: CheckSpec, record: CheckRecord): CheckRecord {
    const actions = (spec.actions ?? []).map(actionInfo);
    const last = lastActions.get(spec.id);
    return { ...plain(record), ...(actions.length ? { actions } : {}), ...(last ? { lastAction: last } : {}) };
  }

  /** Writes the record unless needsStore says nothing worth storing changed. */
  async function persist(spec: CheckSpec, record: CheckRecord) {
    const now = clock.now();
    if (!needsStore(stored.get(spec.id) ?? null, record, now, config.heartbeatSec * 1000)) return;
    try {
      await store.put(record);
      stored.set(spec.id, { record, at: now });
    } catch (err) {
      log(`store ${spec.id} failed: ${(err as Error).message}`);
    }
  }

  async function runOne(spec: CheckSpec): Promise<CheckRecord> {
    const obs = await probe(spec);
    const t = observe(states.get(spec.id)!, spec, obs, iso(), config.confirm);
    states.set(spec.id, t.state);
    const record = decorate(spec, t.state.record!);
    remember(spec.id, { ...record, status: obs.status, detail: obs.detail, latencyMs: Math.round(obs.latencyMs) });
    // Steady checks are written only on a summary change or a heartbeat; checks.list still shows every run.
    await persist(spec, record);
    if (t.changed) {
      const data = { id: spec.id, kind: spec.kind, from: t.changed.from, to: t.changed.to, detail: record.detail, since: record.since };
      try {
        await events.emit("check.changed", data);
        if (t.changed.to === "down") await events.emit("check.down", data);
      } catch (err) {
        log(`emit for ${spec.id} failed: ${(err as Error).message}`);
      }
    }
    return record;
  }

  /** Runs a check unless a run of it is already in flight, in which case that run's result is shared. */
  function runSpec(spec: CheckSpec): Promise<CheckRecord> {
    const cur = inflight.get(spec.id);
    if (cur) return cur;
    const p = runOne(spec).finally(() => inflight.delete(spec.id));
    inflight.set(spec.id, p);
    return p;
  }

  function requireSpec(id: unknown, field = "id"): CheckSpec {
    if (typeof id !== "string" || !id) throw new Error(`${field} is required`);
    const spec = specs.get(id);
    if (!spec) throw new Error(`unknown check: ${id}`);
    return spec;
  }

  async function runAll() {
    return Promise.all(config.checks.map(runSpec));
  }

  /** Records an action run on the check and stores it right away, so screens see each step. */
  async function setAction(spec: CheckSpec, run: ActionRun) {
    lastActions.set(spec.id, run);
    const record = states.get(spec.id)?.record;
    // A check that never ran has no record yet; the re-check after the action creates one.
    if (record) await persist(spec, decorate(spec, record));
  }

  function settle(): Promise<void> {
    if (settleMs <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const stop = clock.every(settleMs, () => {
        stop();
        resolve();
      });
    });
  }

  /** Approval, then exec, then a fresh run of the check. Never throws; every outcome lands in lastAction. */
  async function perform(spec: CheckSpec, action: ActionSpec, waiting: ActionRun, exec: Exec, approvals: Approvals) {
    await setAction(spec, waiting);
    let decision: { decision: "approve" | "reject"; note?: string };
    try {
      decision = await approvals.request({
        summary: approvalSummary(spec.id, action, machine),
        risk: action.risk,
        payload: { kind: "ops.action", machine, checkId: spec.id, actionId: action.id, label: action.label, argv: action.argv },
        expiresInSec: APPROVAL_EXPIRY_SEC,
      });
    } catch (err) {
      await finish(spec, { ...waiting, state: "failed", finishedAt: iso(), note: `승인을 요청하지 못했어요: ${(err as Error).message}` });
      return;
    }
    if (decision.decision !== "approve") {
      const note = decision.note === "expired" ? "승인 요청이 만료됐어요" : decision.note ? `거절됨: ${decision.note}` : "거절됨";
      await finish(spec, { ...waiting, state: "rejected", finishedAt: iso(), note });
      return;
    }
    const running: ActionRun = { ...waiting, state: "running" };
    await setAction(spec, running);
    let ran: ActionRun;
    try {
      ran = finishRun(running, await exec.run(action.argv, action.timeoutMs), iso(), action.timeoutMs);
    } catch (err) {
      ran = { ...running, state: "failed", finishedAt: iso(), note: `실행 중 오류: ${(err as Error).message}` };
    }
    lastActions.set(spec.id, ran);
    await settle();
    // A run that started before the action would describe the old state; wait it out, then check again.
    await inflight.get(spec.id)?.catch(() => {});
    await runSpec(spec).catch((err) => log(`re-check ${spec.id} failed: ${(err as Error).message}`));
    const seen = history.get(spec.id)!.at(-1);
    await finish(spec, seen ? { ...ran, recheck: { status: seen.status, detail: seen.detail, checkedAt: seen.checkedAt } } : ran);
  }

  async function finish(spec: CheckSpec, run: ActionRun) {
    await setAction(spec, run);
    try {
      await events.emit("action.finished", { id: spec.id, actionId: run.actionId, machine, state: run.state, exitCode: run.exitCode ?? null, recheck: run.recheck?.status ?? null });
    } catch (err) {
      log(`emit for ${spec.id} failed: ${(err as Error).message}`);
    }
  }

  return {
    load,
    runAll,

    /** checks.run: one check by id, or all of them. */
    async run(p?: { id?: string }) {
      if (p?.id !== undefined) return { checks: [await runSpec(requireSpec(p.id))] };
      return { checks: await runAll() };
    },

    /**
     * actions.run: asks for approval to run one configured action and returns at once with state "waiting".
     * The rest (approval, exec, re-check) shows up in the check's `lastAction` as it happens.
     */
    runAction(p: { checkId?: unknown; actionId?: unknown }) {
      const spec = requireSpec(p?.checkId, "checkId");
      if (typeof p.actionId !== "string" || !p.actionId) throw new Error("actionId is required");
      const action = spec.actions?.find((a) => a.id === p.actionId);
      if (!action) throw new Error(`unknown action on ${spec.id}: ${p.actionId}`);
      const { exec, approvals } = deps;
      if (!exec || !approvals) throw new Error("actions are not available in this ops instance");
      if (actionInflight.has(spec.id)) throw new Error(`an action on ${spec.id} is already waiting or running`);
      const waiting: ActionRun = { actionId: action.id, label: action.label, argv: action.argv, machine, state: "waiting", requestedAt: iso() };
      lastActions.set(spec.id, waiting);
      const done = perform(spec, action, waiting, exec, approvals)
        .catch((err) => log(`action ${spec.id}/${action.id} failed: ${(err as Error).message}`))
        .finally(() => actionInflight.delete(spec.id));
      actionInflight.set(spec.id, done);
      return { checkId: spec.id, actionId: action.id, state: waiting.state, summary: approvalSummary(spec.id, action, machine) };
    },

    /** checks.list: the latest record of every configured check (null until its first run), plus config errors. */
    list() {
      return {
        intervalSec: config.intervalSec,
        checks: config.checks.map((c) => {
          const r = states.get(c.id)?.record;
          if (r) return decorate(c, r);
          const actions = (c.actions ?? []).map(actionInfo);
          const last = lastActions.get(c.id);
          return { id: c.id, kind: c.kind, status: "unknown", pending: true, ...(actions.length ? { actions } : {}), ...(last ? { lastAction: last } : {}) };
        }),
        errors: config.errors,
      };
    },

    /** checks.history: newest first, from the in-memory ring buffer. */
    history(p: { id: string; limit?: number }) {
      const spec = requireSpec(p?.id);
      const limit = Math.min(Math.max(Math.floor(Number(p.limit ?? 50)) || 50, 1), MAX_HISTORY_LIMIT);
      return { id: spec.id, entries: history.get(spec.id)!.slice(-limit).reverse() };
    },

    /** Runs everything after startDelaySec (immediately when 0), then every intervalSec. */
    start() {
      if (stopTimer) return;
      const run = () => void runAll().catch((err) => log(`run failed: ${(err as Error).message}`));
      const loop = () => clock.every(config.intervalSec * 1000, run);
      if (config.startDelaySec <= 0) {
        run();
        stopTimer = loop();
        return;
      }
      // One-shot delay built from the clock port so tests can drive it with the fake clock.
      let stopLoop: (() => void) | null = null;
      const stopDelay = clock.every(config.startDelaySec * 1000, () => {
        stopDelay();
        run();
        stopLoop = loop();
      });
      stopTimer = () => {
        stopDelay();
        stopLoop?.();
      };
    },

    stop() {
      stopTimer?.();
      stopTimer = null;
    },

    /** Resolves when every in-flight run and action has finished (for tests and shutdown). */
    async idle() {
      while (inflight.size > 0 || actionInflight.size > 0) await Promise.allSettled([...inflight.values(), ...actionInflight.values()]);
    },
  };
}

export type OpsService = ReturnType<typeof createService>;
