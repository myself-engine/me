// Use cases of the schedule plugin, written against ports only. A timer fires jobs
// whose next due time has passed; each run asks gjc-head chat.send on the job's own
// thread, and the reply is delivered to the job's messengers when it completes.
// Overlap, missed-on-startup and retry handling live here; wall-clock math is in domain/.
import { redactString } from "@me/redact";
import { duesBetween, nextDue, parseJob, summarize, type Job, type Run, type RunState, type ScheduleConfig } from "../domain/schedule.ts";

export interface ChatResult {
  threadId: string;
  messageId: string;
  route: string | null;
  status: string;
}

export interface HeadMessage {
  id: string;
  threadId: string;
  role: string;
  text: string;
  status: string;
  error?: string;
}

export interface ScheduleStore {
  runtimeJobs(): Promise<Job[]>;
  saveJob(job: Job): Promise<void>;
  runs(jobId: string, limit: number): Promise<Run[]>;
  saveRun(run: Run): Promise<void>;
}

export interface ScheduleInvoker {
  chatSend(p: { threadId: string; text: string; title?: string; project?: string; access: string }): Promise<ChatResult>;
  headMessage(id: string): Promise<HeadMessage | null>;
  notifyDiscord(text: string): Promise<void>;
  notifySlack(text: string): Promise<void>;
  requestApproval(summary: string): Promise<{ decision: "approve" | "reject" }>;
}

export interface ScheduleClock {
  now(): number;
  every(ms: number, fn: () => void): () => void;
  sleep(ms: number): Promise<void>;
}

export interface ServiceDeps {
  config: ScheduleConfig;
  store: ScheduleStore;
  invoker: ScheduleInvoker;
  clock: ScheduleClock;
  log?: (...args: unknown[]) => void;
  /** Called after every tick and catch-up so the host can persist the alive watermark. */
  onTick?: (nowMs: number) => void;
}

export interface JobView extends Job {
  nextRun: string | null;
  lastRun: { at: string; state: RunState } | null;
}

const errText = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 300);

export function createScheduleService(deps: ServiceDeps) {
  const { config, store, invoker, clock } = deps;
  const log = deps.log ?? ((...a: unknown[]) => console.error("[schedule]", ...a));
  const tz = config.timezone;
  const graceMs = config.missGraceSec * 1000;

  const runtime = new Map<string, Job>();
  /** Next due instant per job, recomputed after every fire and every job change. */
  const next = new Map<string, number | null>();
  /** Jobs with a run in flight. A tick that finds one records "skipped". */
  const running = new Set<string>();
  /** Runs waiting for their reply message to complete, keyed by thread id. */
  const pending = new Map<string, { jobId: string; runId: string; messageId: string }>();
  /** Messengers already warned about, so a missing plugin logs once. */
  const warned = new Set<string>();
  let stopTimer: (() => void) | null = null;
  let lastTick = 0;

  const iso = (ms: number) => new Date(ms).toISOString();
  const allJobs = (): Job[] => [...config.jobs, ...runtime.values()];
  const findJob = (id: string): Job | undefined => config.jobs.find((j) => j.id === id) ?? runtime.get(id);

  function refreshNext(job: Job, fromMs: number) {
    try {
      next.set(job.id, nextDue(job.when, fromMs, tz));
    } catch (err) {
      log(`next due for ${job.id} failed:`, errText(err));
      next.set(job.id, null);
    }
  }

  async function runsOf(jobId: string): Promise<Run[]> {
    return store.runs(jobId, 200).catch(() => [] as Run[]);
  }

  function threadIdFor(job: Job): string {
    return job.threadId ?? `sched-${job.id}`;
  }

  // ---- delivery ------------------------------------------------------------

  async function deliver(job: Job, text: string) {
    const body = redactString(text);
    for (const target of job.deliver) {
      if (target === "web") continue; // The web result stays in the thread and the run entity.
      try {
        if (target === "discord") await invoker.notifyDiscord(body);
        else await invoker.notifySlack(body);
      } catch (err) {
        if (!warned.has(target)) {
          warned.add(target);
          log(`${target} 알림을 건너뜁니다 (웹 결과는 유지): ${errText(err)}`);
        }
      }
    }
  }

  // ---- firing ---------------------------------------------------------------

  /** Runs one job now. Overlap records "skipped" instead of starting. */
  async function fire(job: Job, atMs: number): Promise<Run> {
    const at = iso(atMs);
    if (running.has(job.id)) {
      const skipped: Run = { id: crypto.randomUUID(), jobId: job.id, at, state: "skipped", threadId: threadIdFor(job) };
      await store.saveRun(skipped).catch((err) => log("saveRun failed:", errText(err)));
      return skipped;
    }
    running.add(job.id);
    let started = false;
    try {
      if (job.access !== "read" && !config.allowUnattendedWrite) {
        const { decision } = await invoker.requestApproval(`예약 실행 '${job.name}' (접근: ${job.access}): ${job.prompt.slice(0, 200)}`);
        if (decision !== "approve") {
          const rejected: Run = { id: crypto.randomUUID(), jobId: job.id, at, state: "failed", threadId: threadIdFor(job), error: "승인이 거절됐어요" };
          await store.saveRun(rejected).catch((err) => log("saveRun failed:", errText(err)));
          return rejected;
        }
      }
      const threadId = threadIdFor(job);
      let res: ChatResult | null = null;
      let startError: unknown = null;
      for (let attempt = 0; attempt <= config.retryDelaysMs.length; attempt++) {
        try {
          res = await invoker.chatSend({ threadId, text: job.prompt, title: `⏱ ${job.name}`, ...(job.project ? { project: job.project } : {}), access: job.access });
          startError = null;
          break;
        } catch (err) {
          startError = err;
          if (attempt < config.retryDelaysMs.length) await clock.sleep(config.retryDelaysMs[attempt]!);
        }
      }
      if (!res) {
        const failed: Run = { id: crypto.randomUUID(), jobId: job.id, at, state: "failed", threadId, error: errText(startError) };
        await store.saveRun(failed).catch((err) => log("saveRun failed:", errText(err)));
        return failed;
      }
      if (job.threadId !== res.threadId && !job.fromConfig) {
        job = { ...job, threadId: res.threadId, updatedAt: iso(clock.now()) };
        runtime.set(job.id, job);
        await store.saveJob(job).catch((err) => log("saveJob failed:", errText(err)));
      }
      const run: Run = { id: crypto.randomUUID(), jobId: job.id, at, state: "started", threadId: res.threadId, messageId: res.messageId };
      await store.saveRun(run).catch((err) => log("saveRun failed:", errText(err)));
      pending.set(res.threadId, { jobId: job.id, runId: run.id, messageId: res.messageId });
      started = true;
      return run;
    } finally {
      // running clears when the reply completes (onMessageChanged); a start that
      // never produced a pending reply releases the job right away.
      if (!started) running.delete(job.id);
    }
  }

  // ---- ticks ------------------------------------------------------------------

  /** Fires every job whose next due time has passed. */
  async function tick(nowMs = clock.now()) {
    for (const job of allJobs()) {
      if (!job.enabled) continue;
      let due = next.get(job.id);
      if (due === undefined) {
        refreshNext(job, lastTick || nowMs);
        due = next.get(job.id) ?? null;
      }
      if (due === null || due > nowMs) continue;
      await fire(job, due);
      refreshNext(findJob(job.id) ?? job, due);
    }
    lastTick = nowMs;
    deps.onTick?.(nowMs);
  }

  /** On start-up: dues in (previousTick, now] older than the grace are "missed" once; recent ones run. */
  async function catchUp(previousTick: number, nowMs: number) {
    for (const job of allJobs()) {
      if (!job.enabled) continue;
      let dues: number[] = [];
      try {
        dues = duesBetween(job.when, previousTick, nowMs, tz);
      } catch (err) {
        log(`dues for ${job.id} failed:`, errText(err));
        continue;
      }
      const seen = new Set((await runsOf(job.id)).map((r) => r.at));
      for (const d of dues) {
        const at = iso(d);
        if (seen.has(at)) continue; // Recorded already: a missed run is written once.
        seen.add(at);
        if (nowMs - d > graceMs) {
          await store.saveRun({ id: crypto.randomUUID(), jobId: job.id, at, state: "missed", threadId: threadIdFor(job) }).catch((err) => log("saveRun failed:", errText(err)));
        } else {
          await fire(job, d);
        }
      }
      refreshNext(findJob(job.id) ?? job, nowMs);
    }
    lastTick = nowMs;
    deps.onTick?.(nowMs);
  }

  // ---- reply completion ---------------------------------------------------------

  async function onMessageChanged(data: { id?: unknown; threadId?: unknown }) {
    const threadId = typeof data.threadId === "string" ? data.threadId : null;
    const id = typeof data.id === "string" ? data.id : null;
    if (!threadId || !id) return;
    const p = pending.get(threadId);
    if (!p || p.messageId !== id) return;
    let msg: HeadMessage | null = null;
    try {
      msg = await invoker.headMessage(id);
    } catch (err) {
      log("headMessage failed:", errText(err));
      return;
    }
    if (!msg || msg.status === "pending" || msg.status === "streaming") return;
    pending.delete(threadId);
    running.delete(p.jobId);
    const job = findJob(p.jobId);
    // Keep the run's original due instant: catchUp matches runs to dues by `at`.
    const at = (await runsOf(p.jobId)).find((r) => r.id === p.runId)?.at ?? iso(clock.now());
    if (msg.status === "done") {
      await store.saveRun({ id: p.runId, jobId: p.jobId, at, state: "done", threadId, messageId: id, delivered: true }).catch((err) => log("saveRun failed:", errText(err)));
      if (job) await deliver(job, `⏱ ${job.name}\n${summarize(msg.text)}`);
    } else {
      const error = msg.error ?? msg.text ?? "알 수 없는 오류";
      await store.saveRun({ id: p.runId, jobId: p.jobId, at, state: "failed", threadId, messageId: id, error: error.slice(0, 300) }).catch((err) => log("saveRun failed:", errText(err)));
      if (job) await deliver(job, `⏱ ${job.name} 실패: ${error.slice(0, 300)}`);
    }
  }

  // ---- methods ---------------------------------------------------------------------

  function requireRuntime(id: string): Job {
    const job = runtime.get(id);
    if (!job) {
      if (config.jobs.some((j) => j.id === id)) throw new Error(`설정의 job(${id})은 읽기 전용이라 바꿀 수 없어요`);
      throw new Error(`모르는 job이에요: ${id}`);
    }
    return job;
  }

  return {
    async load(state: { lastTick: string | null }) {
      for (const j of await store.runtimeJobs().catch(() => [] as Job[])) {
        if (!j.fromConfig && !(j as Job & { deleted?: boolean }).deleted) runtime.set(j.id, j);
      }
      const nowMs = clock.now();
      const prev = state.lastTick ? Date.parse(state.lastTick) : NaN;
      if (Number.isFinite(prev) && nowMs > prev) {
        await catchUp(prev, nowMs);
      } else {
        for (const job of allJobs()) {
          if (job.enabled) refreshNext(job, nowMs);
        }
        lastTick = nowMs;
      }
    },

    start() {
      stopTimer = clock.every(config.tickSec * 1000, () => void tick().catch((err) => log("tick failed:", errText(err))));
    },

    stop() {
      stopTimer?.();
      stopTimer = null;
    },

    tick,
    onMessageChanged,

    async add(p: Record<string, unknown>): Promise<Job> {
      const id = typeof p.id === "string" && p.id ? p.id : crypto.randomUUID();
      if (findJob(id)) throw new Error(`job id가 겹쳐요: ${id}`);
      const now = iso(clock.now());
      const job = parseJob({ ...p, id, createdAt: now, updatedAt: now }, { fromConfig: false });
      runtime.set(id, job);
      await store.saveJob(job);
      refreshNext(job, clock.now());
      return job;
    },

    async update(p: { id: string } & Record<string, unknown>): Promise<Job> {
      const cur = requireRuntime(p.id);
      const job = parseJob({ ...cur, ...p, id: cur.id, createdAt: cur.createdAt, updatedAt: iso(clock.now()) }, { fromConfig: false });
      runtime.set(job.id, job);
      await store.saveJob(job);
      refreshNext(job, clock.now());
      return job;
    },

    async remove(p: { id: string }): Promise<{ removed: string }> {
      const cur = requireRuntime(p.id);
      // The kernel has no entity delete, so removal is a tombstone that load() skips.
      await store.saveJob({ ...cur, enabled: false, updatedAt: iso(clock.now()), deleted: true } as Job);
      runtime.delete(p.id);
      next.delete(p.id);
      running.delete(p.id);
      return { removed: p.id };
    },

    async list(): Promise<{ jobs: JobView[] }> {
      const jobs: JobView[] = [];
      for (const job of allJobs()) {
        let due = next.get(job.id);
        if (due === undefined) {
          refreshNext(job, clock.now());
          due = next.get(job.id) ?? null;
        }
        const runs = await runsOf(job.id);
        let last: Run | null = null;
        for (const r of runs) {
          if (!last || r.at > last.at) last = r;
        }
        jobs.push({ ...job, nextRun: job.enabled && due != null ? iso(due) : null, lastRun: last ? { at: last.at, state: last.state } : null });
      }
      return { jobs };
    },

    async runNow(p: { id: string }): Promise<Run> {
      const job = findJob(p.id);
      if (!job) throw new Error(`모르는 job이에요: ${p.id}`);
      const run = await fire(job, clock.now());
      refreshNext(findJob(job.id) ?? job, clock.now());
      return run;
    },
  };
}

export type ScheduleService = ReturnType<typeof createScheduleService>;
