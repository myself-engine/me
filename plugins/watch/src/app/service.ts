import { redactString } from "@me/redact";
import { brgrPanesOf, checkStall, snapshotsOf, trackNew, viewOf, type AgentSnapshot, type TrackedAgent } from "../domain/watch.ts";
import type { AgentStore, Clock, HerdrAgent, WatchEvents, WatchStatus } from "../ports/index.ts";

const READ_LINES = 80;
const COMMAND_TIMEOUT_MS = 5_000;

export interface WatchConfig {
  intervalSec?: number;
  stallMinutes?: number;
}

export interface WatchDeps {
  herdr: HerdrAgent;
  brgr?: HerdrAgent;
  store: AgentStore;
  events: WatchEvents;
  clock: Clock;
  herdrEnv: boolean;
  config?: WatchConfig;
  log?: (message: string) => void;
}

function linesFromOutput(output: string): string[] {
  try {
    const parsed = JSON.parse(output) as { result?: { text?: unknown; output?: unknown }; text?: unknown; output?: unknown };
    const text = parsed.result?.text ?? parsed.result?.output ?? parsed.text ?? parsed.output;
    if (typeof text === "string") return text.split(/\r?\n/).slice(-READ_LINES).map(redactString);
  } catch {
    // Herdr versions that return a plain terminal buffer are also supported.
  }
  return output.split(/\r?\n/).slice(-READ_LINES).map(redactString);
}

function safeProject(snap: AgentSnapshot): string | null {
  if (!snap.project) return null;
  const name = snap.project.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1);
  return name || snap.project;
}

function configured(value: unknown, fallback: number, minimum: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= minimum ? n : fallback;
}

/** Read-only Herdr feed and stall detector. It never sends input to an agent. */
export function createWatchService(deps: WatchDeps) {
  const log = deps.log ?? ((message: string) => console.error(`[watch] ${message}`));
  const intervalMs = configured(deps.config?.intervalSec, 10, 2) * 1_000;
  const stallMs = configured(deps.config?.stallMinutes, 15, 1) * 60_000;
  const tracked = new Map<string, TrackedAgent>();
  let stopTimer: (() => void) | null = null;
  let activePoll: Promise<void> | null = null;

  const iso = () => new Date(deps.clock.now()).toISOString();

  async function problem(message: string) {
    const status: WatchStatus = { state: "problem", problem: redactString(message).slice(0, 300), checkedAt: iso() };
    await deps.store.putStatus(status);
  }

  async function read(args: string[]) {
    const result = await deps.herdr.exec(args, COMMAND_TIMEOUT_MS);
    if (result.code !== 0) throw new Error((result.stderr.trim() || `command exited ${result.code}`).slice(0, 300));
    return result.stdout;
  }

  async function update(snapshot: AgentSnapshot, brgrTaskId: string | null, now: number) {
    const previous = tracked.get(snapshot.pane);
    const rawLines = await deps.herdr.exec(["agent", "read", snapshot.pane, "--source", "recent-unwrapped", "--lines", String(READ_LINES)], COMMAND_TIMEOUT_MS).catch(() => null);
    const recentLines = rawLines?.code === 0 ? linesFromOutput(rawLines.stdout) : [];
    const detectedTaskId = brgrTaskId;
    const at = iso();
    const revisionChanged = previous?.revision !== null && previous?.revision !== undefined && snapshot.revision !== null && previous.revision !== snapshot.revision;
    const changed = !previous || previous.state !== snapshot.state || revisionChanged;
    let next: TrackedAgent;
    if (!previous) {
      next = trackNew(snapshot, snapshot.since ?? at, detectedTaskId);
      next.recentLines = recentLines;
    } else {
      next = {
        ...previous,
        kind: snapshot.kind,
        cwd: snapshot.cwd,
        project: safeProject(snapshot),
        state: snapshot.state,
        since: previous.state !== snapshot.state ? snapshot.since ?? at : previous.since,
        lastChangeAt: changed ? at : previous.lastChangeAt,
        brgrTaskId: detectedTaskId,
        revision: snapshot.revision,
        recentLines,
        ...(changed ? { stalled: false, stallExcerpt: null, stallReason: null, flaggedSignature: null } : {}),
      };
    }
    next.project = safeProject(snapshot);
    const stall = checkStall(next, now, stallMs, recentLines);
    if (stall.stalled && !next.stalled) {
      next = { ...next, stalled: true, stallExcerpt: stall.excerpt ? redactString(stall.excerpt).slice(0, 500) : null, stallReason: stall.reason };
      if (stall.reason === "repeated-failure") next.flaggedSignature = stall.excerpt;
      await deps.events.emit("stalled", {
        pane: next.pane,
        kind: next.kind,
        project: next.project,
        state: next.state,
        since: next.since,
        lastChangeAt: next.lastChangeAt,
        brgrTaskId: next.brgrTaskId,
        reason: stall.reason,
        excerpt: next.stallExcerpt,
      });
    }
    tracked.set(snapshot.pane, next);
    await deps.store.put(viewOf(next));
  }

  async function pollOnce() {
    if (!deps.herdrEnv) {
      await problem("Herdr 환경에서 실행되지 않아 에이전트 상태를 읽을 수 없어요");
      return;
    }
    try {
      // This Herdr CLI returns a JSON RPC envelope by default; its current
      // version rejects a trailing --json flag.
      const agentOutput = await read(["agent", "list"]);
      const snapshots = snapshotsOf(agentOutput);
      let brgrPanes = new Map<string, string>();
      try {
        if (!deps.brgr) throw new Error("brgr status is unavailable");
        const status = await deps.brgr.exec(["status", "--json"], COMMAND_TIMEOUT_MS);
        if (status.code !== 0) throw new Error(status.stderr.trim() || `brgr exited ${status.code}`);
        const output = status.stdout;
        brgrPanes = brgrPanesOf(output);
      } catch {
        // Herdr remains useful if brgr is unavailable or has no visible tasks.
      }
      const live = new Set(snapshots.map((snapshot) => snapshot.pane));
      for (const pane of tracked.keys()) {
        if (!live.has(pane)) {
          tracked.delete(pane);
          await deps.store.remove(pane);
        }
      }
      const now = deps.clock.now();
      for (const snapshot of snapshots) await update(snapshot, brgrPanes.get(snapshot.pane) ?? null, now);
      await deps.store.putStatus({ state: "ok", problem: null, checkedAt: iso() });
    } catch (error) {
      log(`poll failed (${error instanceof Error ? error.name : "unknown error"})`);
      await problem("Herdr 상태를 읽을 수 없어요");
    }
  }

  function poll() {
    if (!activePoll) activePoll = pollOnce().finally(() => (activePoll = null));
    return activePoll;
  }

  return {
    async start() {
      for (const agent of await deps.store.list()) {
        tracked.set(agent.pane, { ...agent, revision: null, recentLines: [], flaggedSignature: null });
      }
      await poll();
      if (!stopTimer) stopTimer = deps.clock.every(intervalMs, () => void poll().catch((error) => log(String(error))));
    },
    stop() {
      stopTimer?.();
      stopTimer = null;
    },
    poll,
    async list() {
      const [agents, status] = await Promise.all([deps.store.list(), deps.store.getStatus()]);
      return { agents, problem: status?.problem ?? null, checkedAt: status?.checkedAt ?? null };
    },
    async get(pane: string) {
      return (await deps.store.list()).find((agent) => agent.pane === pane) ?? null;
    },
  };
}
