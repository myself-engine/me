// Runner behavior with a fake clock and a fake kernel: firing, overlap skip,
// missed-on-startup, retry, approval, and delivery routing.
import { describe, expect, test } from "bun:test";
import { createScheduleService, type ChatResult, type HeadMessage, type ScheduleInvoker, type ScheduleStore } from "./service.ts";
import { parseScheduleConfig, type Job, type Run, type ScheduleConfig } from "../domain/schedule.ts";

const SEOUL = "Asia/Seoul";
const MON_07 = Date.UTC(2026, 9, 11, 22, 0); // Mon 07:00 KST
const MON_09 = Date.UTC(2026, 9, 12, 0, 0); // Mon 09:00 KST

const dailyJob: Job = {
  id: "morning",
  name: "아침 브리핑",
  prompt: "오늘 일정 요약해줘",
  access: "read",
  when: { kind: "daily", time: "09:00" },
  deliver: ["web", "discord"],
  enabled: true,
  createdAt: new Date(MON_07).toISOString(),
  updatedAt: new Date(MON_07).toISOString(),
};

function testConfig(over: Partial<ScheduleConfig> = {}): ScheduleConfig {
  return { ...parseScheduleConfig({ timezone: SEOUL }), retryDelaysMs: [10, 20], ...over };
}

class FakeStore implements ScheduleStore {
  jobs = new Map<string, Job>();
  saved: Run[] = [];
  async runtimeJobs() {
    return [...this.jobs.values()];
  }
  async saveJob(job: Job) {
    this.jobs.set(job.id, job);
  }
  async runsList(jobId: string) {
    return this.saved.filter((r) => r.jobId === jobId);
  }
  async runs(jobId: string, _limit: number) {
    return this.runsList(jobId);
  }
  async saveRun(run: Run) {
    const i = this.saved.findIndex((r) => r.id === run.id);
    if (i >= 0) this.saved[i] = run;
    else this.saved.push(run);
  }
}

class FakeInvoker implements ScheduleInvoker {
  chats: { threadId: string; text: string }[] = [];
  chatBehavior: () => Promise<ChatResult> = async () => ({ threadId: "sched-morning", messageId: "m1", route: "direct", status: "done" });
  messages = new Map<string, HeadMessage>();
  discord: string[] = [];
  slack: string[] = [];
  discordFails = false;
  approvals: { decision: "approve" | "reject" }[] = [];
  approvalDecision: "approve" | "reject" = "approve";
  async chatSend(p: { threadId: string; text: string }) {
    this.chats.push({ threadId: p.threadId, text: p.text });
    return this.chatBehavior();
  }
  async headMessage(id: string) {
    return this.messages.get(id) ?? null;
  }
  async notifyDiscord(text: string) {
    if (this.discordFails) throw new Error("discord is not installed");
    this.discord.push(text);
  }
  async notifySlack(text: string) {
    this.slack.push(text);
  }
  async requestApproval(_summary: string) {
    const d = { decision: this.approvalDecision };
    this.approvals.push(d);
    return d;
  }
}

function setup(over: Partial<ScheduleConfig> = {}, jobs: Job[] = [dailyJob]) {
  const store = new FakeStore();
  const invoker = new FakeInvoker();
  let now = MON_07;
  const sleeps: number[] = [];
  const logs: unknown[][] = [];
  const svc = createScheduleService({
    config: { ...testConfig(over), jobs: [] },
    store,
    invoker,
    clock: { now: () => now, every: () => () => {}, sleep: async (ms) => void sleeps.push(ms) },
    log: (...a) => void logs.push(a),
    onTick: () => {},
  });
  return {
    svc,
    store,
    invoker,
    sleeps,
    logs,
    setNow: (ms: number) => (now = ms),
    addJobs: async () => {
      for (const j of jobs) await svc.add({ ...j, id: j.id });
    },
  };
}

describe("firing", () => {
  test("a due job runs on its own thread and completes on the reply", async () => {
    const t = setup();
    await t.addJobs();
    await t.svc.load({ lastTick: null });
    t.setNow(MON_09 + 60_000);
    await t.svc.tick();
    expect(t.invoker.chats).toHaveLength(1);
    expect(t.invoker.chats[0]).toMatchObject({ threadId: "sched-morning", text: "오늘 일정 요약해줘" });
    // The reply completes: run goes done and discord gets the summary.
    t.invoker.messages.set("m1", { id: "m1", threadId: "sched-morning", role: "assistant", text: "브리핑이에요", status: "done" });
    await t.svc.onMessageChanged({ id: "m1", threadId: "sched-morning" });
    expect(t.store.saved.map((r) => r.state)).toEqual(["done"]);
    expect(t.invoker.discord).toEqual(["⏱ 아침 브리핑\n브리핑이에요"]);
  });

  test("an unrelated thread's message is ignored", async () => {
    const t = setup();
    await t.addJobs();
    await t.svc.load({ lastTick: null });
    await t.svc.onMessageChanged({ id: "x", threadId: "other" });
    expect(t.store.saved).toHaveLength(0);
  });
});

describe("overlap", () => {
  test("a second fire while the first runs records skipped", async () => {
    const t = setup();
    await t.addJobs();
    await t.svc.load({ lastTick: null });
    let release!: () => void;
    const gate = new Promise<ChatResult>((r) => (release = () => r({ threadId: "sched-morning", messageId: "m1", route: "direct", status: "done" })));
    t.invoker.chatBehavior = () => gate;
    const first = t.svc.runNow({ id: "morning" });
    await Bun.sleep(0);
    const skipped = await t.svc.runNow({ id: "morning" });
    expect(skipped.state).toBe("skipped");
    release();
    const started = await first;
    expect(started.state).toBe("started");
    expect(t.invoker.chats).toHaveLength(1);
  });
});

describe("missed-on-startup", () => {
  test("a due missed while off is recorded once and not executed", async () => {
    const t = setup();
    await t.addJobs();
    // Off for 3h; the 09:00 due is 2h old, past the 60s grace.
    const offSince = new Date(MON_07).toISOString();
    t.setNow(MON_09 + 2 * 3600_000);
    await t.svc.load({ lastTick: offSince });
    expect(t.invoker.chats).toHaveLength(0);
    expect(t.store.saved.map((r) => r.state)).toEqual(["missed"]);
    // A second start with a fresh watermark records nothing more.
    await t.svc.load({ lastTick: new Date(MON_09 + 2 * 3600_000).toISOString() });
    expect(t.store.saved).toHaveLength(1);
  });

  test("a due within the grace runs on start-up", async () => {
    const t = setup();
    await t.addJobs();
    t.setNow(MON_09 + 30_000);
    await t.svc.load({ lastTick: new Date(MON_09 - 30_000).toISOString() });
    expect(t.invoker.chats).toHaveLength(1);
    expect(t.store.saved.map((r) => r.state)).toEqual(["started"]);
  });
});

describe("retry", () => {
  test("a failed start retries twice with backoff, then runs", async () => {
    const t = setup();
    await t.addJobs();
    let calls = 0;
    t.invoker.chatBehavior = async () => {
      if (++calls < 3) throw new Error("head is busy");
      return { threadId: "sched-morning", messageId: "m1", route: "direct", status: "done" };
    };
    const run = await t.svc.runNow({ id: "morning" });
    expect(run.state).toBe("started");
    expect(calls).toBe(3);
    expect(t.sleeps).toEqual([10, 20]);
  });

  test("three failures record failed with the error", async () => {
    const t = setup();
    await t.addJobs();
    let calls = 0;
    t.invoker.chatBehavior = async () => {
      calls++;
      throw new Error("head is down");
    };
    const run = await t.svc.runNow({ id: "morning" });
    expect(run.state).toBe("failed");
    expect(run.error).toContain("head is down");
    expect(calls).toBe(3);
  });
});

describe("approval", () => {
  const writer: Job = { ...dailyJob, id: "writer", access: "project" };
  test("project access asks once; a reject records failed without calling the head", async () => {
    const t = setup({}, [writer]);
    await t.addJobs();
    t.invoker.approvalDecision = "reject";
    const run = await t.svc.runNow({ id: "writer" });
    expect(run.state).toBe("failed");
    expect(t.invoker.approvals).toHaveLength(1);
    expect(t.invoker.chats).toHaveLength(0);
  });
  test("allowUnattendedWrite skips the approval", async () => {
    const t = setup({ allowUnattendedWrite: true }, [writer]);
    await t.addJobs();
    await t.svc.runNow({ id: "writer" });
    expect(t.invoker.approvals).toHaveLength(0);
    expect(t.invoker.chats).toHaveLength(1);
  });
});

describe("delivery routing", () => {
  test("web-only jobs notify nobody", async () => {
    const webOnly: Job = { ...dailyJob, id: "web", deliver: ["web"] };
    const t = setup({}, [webOnly]);
    await t.addJobs();
    await t.svc.runNow({ id: "web" });
    t.invoker.messages.set("m1", { id: "m1", threadId: "sched-web", role: "assistant", text: "done", status: "done" });
    await t.svc.onMessageChanged({ id: "m1", threadId: "sched-web" });
    expect(t.invoker.discord).toHaveLength(0);
    expect(t.invoker.slack).toHaveLength(0);
  });

  test("summaries are capped at 600 chars and redacted", async () => {
    const both: Job = { ...dailyJob, id: "both", deliver: ["discord", "slack"] };
    const t = setup({}, [both]);
    await t.addJobs();
    t.invoker.chatBehavior = async () => ({ threadId: "sched-both", messageId: "m9", route: "direct", status: "done" });
    await t.svc.runNow({ id: "both" });
    t.invoker.messages.set("m9", { id: "m9", threadId: "sched-both", role: "assistant", text: `key=sk-abcdef1234567890 ${"x".repeat(1000)}`, status: "done" });
    await t.svc.onMessageChanged({ id: "m9", threadId: "sched-both" });
    for (const sent of [...t.invoker.discord, ...t.invoker.slack]) {
      expect(sent).not.toContain("sk-abcdef1234567890");
      expect(sent).toContain("[REDACTED]");
      expect(sent.length).toBeLessThanOrEqual("⏱ 아침 브리핑\n".length + 600);
    }
  });

  test("a missing messenger logs once and keeps the web result", async () => {
    const t = setup();
    await t.addJobs();
    t.invoker.discordFails = true;
    await t.svc.runNow({ id: "morning" });
    t.invoker.messages.set("m1", { id: "m1", threadId: "sched-morning", role: "assistant", text: "one", status: "done" });
    await t.svc.onMessageChanged({ id: "m1", threadId: "sched-morning" });
    await t.svc.onMessageChanged({ id: "m1", threadId: "sched-morning" });
    expect(t.store.saved.map((r) => r.state)).toEqual(["done"]);
    expect(t.logs.filter((l) => String(l[0]).includes("discord")).length).toBe(1);
  });

  test("a failed reply delivers a short failure note", async () => {
    const t = setup();
    await t.addJobs();
    await t.svc.runNow({ id: "morning" });
    t.invoker.messages.set("m1", { id: "m1", threadId: "sched-morning", role: "assistant", text: "", status: "error", error: "model blew up" });
    await t.svc.onMessageChanged({ id: "m1", threadId: "sched-morning" });
    expect(t.store.saved.map((r) => r.state)).toEqual(["failed"]);
    expect(t.invoker.discord).toEqual(["⏱ 아침 브리핑 실패: model blew up"]);
  });
});

describe("methods", () => {
  test("config jobs are read-only; runtime jobs are not", async () => {
    const t = setup();
    const svc2 = createScheduleService({
      config: { ...testConfig(), jobs: [dailyJob] },
      store: t.store,
      invoker: t.invoker,
      clock: { now: () => MON_07, every: () => () => {}, sleep: async () => {} },
      onTick: () => {},
    });
    await expect(svc2.update({ id: "morning", name: "바꿈" })).rejects.toThrow();
    await expect(svc2.remove({ id: "morning" })).rejects.toThrow();
    const created = await svc2.add({ name: "밤", prompt: "밤 요약", when: { kind: "daily", time: "22:00" } });
    const updated = await svc2.update({ id: created.id, name: "밤 바꿈" });
    expect(updated.name).toBe("밤 바꿈");
    await svc2.remove({ id: created.id });
    const { jobs } = await svc2.list();
    expect(jobs.map((j) => j.id)).toEqual(["morning"]);
  });

  test("list carries nextRun and lastRun for the future screen", async () => {
    const t = setup();
    await t.addJobs();
    await t.svc.load({ lastTick: null });
    const { jobs } = await t.svc.list();
    expect(jobs[0]!.nextRun).toBe(new Date(MON_09).toISOString());
    expect(jobs[0]!.lastRun).toBeNull();
  });
});
