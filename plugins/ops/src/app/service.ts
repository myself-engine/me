// Use cases of the ops plugin, written against ports only. Read-only: it observes and reports, never acts.
import { needsStore, observe, type CheckRecord, type CheckSpec, type CheckState, type OpsConfig } from "../domain/check.ts";
import type { CheckStore, Clock, Events, Probe } from "../ports/index.ts";

export interface ServiceDeps {
  config: OpsConfig;
  probe: Probe;
  clock: Clock;
  store: CheckStore;
  events: Events;
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

export function createService(deps: ServiceDeps) {
  const { config, probe, clock, store, events } = deps;
  const historySize = deps.historySize ?? DEFAULT_HISTORY;
  const log = deps.log ?? ((m: string) => console.error(`[ops] ${m}`));
  const specs = new Map(config.checks.map((c) => [c.id, c]));
  const states = new Map<string, CheckState>(config.checks.map((c) => [c.id, { record: null, pending: null }]));
  const history = new Map<string, HistoryEntry[]>(config.checks.map((c) => [c.id, []]));
  const inflight = new Map<string, Promise<CheckRecord>>();
  /** The last record written to the store per check, and when (clock ms). */
  const stored = new Map<string, { record: CheckRecord; at: number }>();
  let stopTimer: (() => void) | null = null;

  const iso = () => new Date(clock.now()).toISOString();

  /** Seeds state from stored records so a restart keeps `since` and does not re-announce known statuses. */
  async function load() {
    for (const r of await store.list()) {
      const spec = specs.get(r.id);
      if (spec && spec.kind === r.kind) {
        states.set(r.id, { record: r, pending: null });
        stored.set(r.id, { record: r, at: Date.parse(r.checkedAt) || 0 });
      }
    }
  }

  function remember(id: string, r: CheckRecord) {
    const ring = history.get(id)!;
    ring.push({ status: r.status, detail: r.detail, latencyMs: r.latencyMs, checkedAt: r.checkedAt });
    if (ring.length > historySize) ring.splice(0, ring.length - historySize);
  }

  async function runOne(spec: CheckSpec): Promise<CheckRecord> {
    const obs = await probe(spec);
    const t = observe(states.get(spec.id)!, spec, obs, iso(), config.confirm);
    states.set(spec.id, t.state);
    const record = t.state.record!;
    remember(spec.id, { ...record, status: obs.status, detail: obs.detail, latencyMs: Math.round(obs.latencyMs) });
    // Steady checks are written only on a summary change or a heartbeat; checks.list still shows every run.
    const now = clock.now();
    if (needsStore(stored.get(spec.id) ?? null, record, now, config.heartbeatSec * 1000)) {
      try {
        await store.put(record);
        stored.set(spec.id, { record, at: now });
      } catch (err) {
        log(`store ${spec.id} failed: ${(err as Error).message}`);
      }
    }
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

  function requireSpec(id: unknown): CheckSpec {
    if (typeof id !== "string" || !id) throw new Error("id is required");
    const spec = specs.get(id);
    if (!spec) throw new Error(`unknown check: ${id}`);
    return spec;
  }

  async function runAll() {
    return Promise.all(config.checks.map(runSpec));
  }

  return {
    load,
    runAll,

    /** checks.run: one check by id, or all of them. */
    async run(p?: { id?: string }) {
      if (p?.id !== undefined) return { checks: [await runSpec(requireSpec(p.id))] };
      return { checks: await runAll() };
    },

    /** checks.list: the latest record of every configured check (null until its first run), plus config errors. */
    list() {
      return {
        intervalSec: config.intervalSec,
        checks: config.checks.map((c) => states.get(c.id)?.record ?? { id: c.id, kind: c.kind, status: "unknown", pending: true }),
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

    /** Resolves when every in-flight run has finished (for tests and shutdown). */
    async idle() {
      while (inflight.size > 0) await Promise.allSettled([...inflight.values()]);
    },
  };
}

export type OpsService = ReturnType<typeof createService>;
