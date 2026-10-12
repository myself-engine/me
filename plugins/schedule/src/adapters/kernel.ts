// Ports over the kernel SDK: gjc-head chat, messenger notify calls, entities and approvals.
import type { Plugin } from "@me/sdk";
import type { ChatResult, HeadMessage, ScheduleClock, ScheduleInvoker, ScheduleStore } from "../app/service.ts";
import type { Job, Run } from "../domain/schedule.ts";

/** Entity kinds for this instance: `schedule.job`, `schedule.run`, `schedule.state`. */
export const JOB = "schedule.job";
export const RUN = "schedule.run";
export const STATE = "schedule.state";

export const JOB_SCHEMA = {
  type: "object",
  required: ["id", "name", "prompt", "access", "when", "deliver", "enabled"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    access: { type: "string" },
    enabled: { type: "boolean" },
  },
};

export const RUN_SCHEMA = {
  type: "object",
  required: ["id", "jobId", "at", "state", "threadId"],
  properties: {
    id: { type: "string" },
    jobId: { type: "string" },
    at: { type: "string" },
    state: { type: "string" },
    threadId: { type: "string" },
  },
};

export const STATE_SCHEMA = {
  type: "object",
  required: ["id", "lastTick"],
  properties: { id: { type: "string" }, lastTick: { type: ["string", "null"] } },
};

export function kernelStore(plugin: Plugin): ScheduleStore & { getState(): Promise<{ lastTick: string | null }>; putState(lastTick: string): Promise<void> } {
  return {
    runtimeJobs: async () => (await plugin.entity.list<Job>({ kind: JOB, limit: 1000 })).map((d) => d.data),
    saveJob: async (job) => void (await plugin.entity.upsert(JOB, job.id, job)),
    runs: async (jobId, limit) => (await plugin.entity.list<Run>({ kind: RUN, where: { jobId }, limit })).map((d) => d.data),
    saveRun: async (run) => void (await plugin.entity.upsert(RUN, run.id, run)),
    getState: async () => (await plugin.entity.get<{ lastTick: string | null }>(STATE, "clock").catch(() => null))?.data ?? { lastTick: null },
    putState: async (lastTick) => void (await plugin.entity.upsert(STATE, "clock", { id: "clock", lastTick })),
  };
}

export function kernelInvoker(plugin: Plugin, chatTimeoutMs: number): ScheduleInvoker {
  return {
    chatSend: (p) => plugin.invoke<ChatResult>("gjc-head", "chat.send", p, { timeoutMs: chatTimeoutMs }),
    headMessage: async (id) => (await plugin.entity.get<HeadMessage>("gjc-head.message", id).catch(() => null))?.data ?? null,
    notifyDiscord: async (text) => void (await plugin.invoke("discord", "notify", { text }, { timeoutMs: 60_000 })),
    notifySlack: async (text) => void (await plugin.invoke("slack", "notify", { text }, { timeoutMs: 60_000 })),
    requestApproval: async (summary) => {
      const r = await plugin.approval.request({ summary, risk: "medium", expiresInSec: 600 });
      return { decision: r.decision };
    },
  };
}

export function systemClock(): ScheduleClock {
  return {
    now: () => Date.now(),
    every: (ms, fn) => {
      const t = setInterval(fn, ms);
      return () => clearInterval(t);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
