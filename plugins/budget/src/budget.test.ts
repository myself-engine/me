// Budget tests: fake meter output and fake clock; no real meter call.
import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, evaluateQuota, harnessProvider, localDay, parseConfig, parseMeterOutput, usagesFor } from "./budget.ts";
import { createBudgetService, type BudgetStore, type DayRecord, type Exec, type SummaryRecord } from "./service.ts";

const METER = JSON.stringify({
  snapshots: [
    {
      provider: "codex",
      state: "live",
      buckets: [{ id: "weekly", label: "Weekly", limit: 100, remaining: 8, unit: "percent", used: 92 }],
    },
    {
      provider: "claude",
      state: "live",
      buckets: [
        { id: "weekly", label: "Weekly", limit: 100, remaining: 95, unit: "percent", used: 5 },
        { id: "spend", label: "Total spend", unit: "usd", used: 13.97 },
      ],
    },
  ],
});

function fakeExec(stdout: string, opts: { code?: number; spawnError?: string; calls?: { n: number } } = {}): Exec {
  return {
    async run() {
      if (opts.calls) opts.calls.n += 1;
      return {
        code: opts.code ?? 0,
        stdout,
        stderr: "",
        timedOut: false,
        ...(opts.spawnError ? { spawnError: opts.spawnError } : {}),
      };
    },
  };
}

function fakeStore(tasks: Record<string, { autoApply?: boolean }> = {}): BudgetStore & { days: Map<string, DayRecord>; summaries: Map<string, SummaryRecord> } {
  const days = new Map<string, DayRecord>();
  const summaries = new Map<string, SummaryRecord>();
  return {
    days,
    summaries,
    getDay: async (id) => days.get(id) ?? null,
    putDay: async (d) => {
      days.set(d.id, d);
    },
    getTask: async (taskId) => tasks[taskId] ?? null,
    putSummary: async (s) => {
      summaries.set(s.id, s);
    },
  };
}

function service(opts: { meter?: string; code?: number; spawnError?: string; at?: number; tasks?: Record<string, { autoApply?: boolean }>; calls?: { n: number } }) {
  let at = opts.at ?? Date.parse("2026-10-12T10:00:00+09:00");
  const store = fakeStore(opts.tasks);
  const svc = createBudgetService({
    config: DEFAULT_CONFIG,
    exec: fakeExec(opts.meter ?? METER, { code: opts.code, spawnError: opts.spawnError, calls: opts.calls }),
    store,
    now: () => at,
  });
  return { svc, store, advance: (ms: number) => (at += ms) };
}

describe("parseConfig", () => {
  test("missing or garbage config falls back to defaults", () => {
    expect(parseConfig(undefined)).toEqual(DEFAULT_CONFIG);
    expect(parseConfig({ dailyCap: "many", providers: ["codex"] }).dailyCap).toBe(30);
    expect(parseConfig({ dailyCap: -5 }).dailyCap).toBe(30);
  });
  test("valid overrides merge, provider map extends defaults", () => {
    const c = parseConfig({ dailyCap: 5, providers: { "local.gjc": "codex" } });
    expect(c.dailyCap).toBe(5);
    expect(c.providers).toEqual({ "local.codex": "codex", "local.claude-code": "claude", "local.gjc": "codex" });
  });
});

describe("meter parsing", () => {
  test("buckets without limits are skipped", () => {
    const snaps = parseMeterOutput(METER);
    expect(usagesFor(snaps, "claude")).toHaveLength(1);
    expect(usagesFor(snaps, "cursor")).toEqual([]);
  });
  test("garbage output throws", () => {
    expect(() => parseMeterOutput("not json")).toThrow();
    expect(() => parseMeterOutput("{}")).toThrow();
  });
});

describe("harnessProvider", () => {
  test("config map wins; opencode-go models map by prefix; the rest is skipped", () => {
    expect(harnessProvider("local.codex", undefined, DEFAULT_CONFIG)).toBe("codex");
    expect(harnessProvider("local.gjc", "opencode-go/gpt-5", DEFAULT_CONFIG)).toBe("opencode-go");
    expect(harnessProvider("local.gjc", "openai-codex/gpt-6", DEFAULT_CONFIG)).toBeNull();
    expect(harnessProvider("local.opencode", undefined, DEFAULT_CONFIG)).toBeNull();
    expect(harnessProvider(undefined, undefined, DEFAULT_CONFIG)).toBeNull();
  });
});

describe("evaluateQuota", () => {
  test("8% remaining asks for approval in Korean", () => {
    const v = evaluateQuota(usagesFor(parseMeterOutput(METER), "codex"), DEFAULT_CONFIG);
    expect(v.ok).toBe(true);
    expect(v.needsApproval).toBe(true);
    expect(v.reason).toContain("Codex");
    expect(v.reason).toContain("8%");
    expect(v.reason).toContain("계속할까요?");
  });
  test("2% remaining stops", () => {
    const low = METER.replace('"remaining":8', '"remaining":2');
    const v = evaluateQuota(usagesFor(parseMeterOutput(low), "codex"), DEFAULT_CONFIG);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("멈췄어요");
  });
  test("healthy quota passes silently", () => {
    const v = evaluateQuota(usagesFor(parseMeterOutput(METER), "claude"), DEFAULT_CONFIG);
    expect(v).toEqual({ ok: true, worst: expect.anything() });
  });
});

describe("budget.check", () => {
  test("unknown harness passes without touching meter", async () => {
    const calls = { n: 0 };
    const { svc } = service({ calls });
    expect(await svc.check({ harness: "local.gjc" })).toEqual({ ok: true });
    expect(calls.n).toBe(0);
  });
  test("soft floor asks, hard floor blocks", async () => {
    const { svc } = service({});
    const soft = await svc.check({ harness: "local.codex" });
    expect(soft.ok).toBe(true);
    expect(soft.needsApproval).toBe(true);
  });
  test("meter result is cached for 60s", async () => {
    const calls = { n: 0 };
    const { svc, advance } = service({ calls });
    await svc.check({ harness: "local.codex" });
    await svc.check({ harness: "local.codex" });
    expect(calls.n).toBe(1);
    advance(61_000);
    await svc.check({ harness: "local.codex" });
    expect(calls.n).toBe(2);
  });
  test("missing meter never blocks; status exposes the problem", async () => {
    const { svc } = service({ spawnError: "ENOENT: meter" });
    expect(await svc.check({ harness: "local.codex" })).toEqual({ ok: true });
    const st = await svc.status();
    expect(st.problem).toContain("meter");
  });
  test("delegation cap blocks, auto cap blocks only auto-applied calls", async () => {
    const { svc, store } = service({});
    const day = localDay(Date.parse("2026-10-12T10:00:00+09:00"));
    store.days.set(day, { id: day, date: day, delegations: 30, autoApplied: 10, updatedAt: new Date().toISOString() });
    const blocked = await svc.check({ harness: "local.codex" });
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toContain("30건");
    store.days.set(day, { id: day, date: day, delegations: 0, autoApplied: 10, updatedAt: new Date().toISOString() });
    const autoBlocked = await svc.check({ harness: "local.codex", autoApply: true });
    expect(autoBlocked.ok).toBe(false);
    expect(autoBlocked.reason).toContain("자동 적용");
    expect((await svc.check({ harness: "local.gjc" })).ok).toBe(true);
  });
});

describe("events and status", () => {
  test("running counts delegations; applied counts only autoApply tasks", async () => {
    const { svc } = service({ tasks: { t1: { autoApply: true }, t2: { autoApply: false } } });
    await svc.onEvent("brgr.task.running", { taskId: "t1" });
    await svc.onEvent("brgr.task.running", { taskId: "t2" });
    await svc.onEvent("brgr.task.applied", { taskId: "t1" });
    await svc.onEvent("brgr.task.applied", { taskId: "t2" });
    await svc.onEvent("brgr.task.sealed", { taskId: "t1" });
    const st = await svc.status();
    expect(st.delegations).toBe(2);
    expect(st.autoApplied).toBe(1);
    expect(st.meters.find((m) => m.provider === "codex")?.remainingPercent).toBe(8);
    expect(st.meters.find((m) => m.provider === "claude")?.remainingPercent).toBe(95);
    expect(st.problem).toBeNull();
  });
  test("status only summarizes providers a configured harness can use", async () => {
    const meter = JSON.stringify({
      snapshots: [
        { provider: "codex", buckets: [{ label: "Weekly", limit: 100, remaining: 99 }] },
        { provider: "cursor", buckets: [{ label: "Other Models", limit: 100, remaining: 0 }] },
      ],
    });
    const { svc } = service({ meter });
    const st = await svc.status();
    expect(st.meters.map((m) => m.provider).sort()).toEqual(["codex"]);
  });
  test("counts reset on the next local day", async () => {
    const { svc, store, advance } = service({});
    await svc.onEvent("brgr.task.running", { taskId: "t" });
    advance(24 * 3600_000);
    await svc.onEvent("brgr.task.running", { taskId: "t" });
    expect(store.days.size).toBe(2);
    const st = await svc.status();
    expect(st.delegations).toBe(1);
  });
  test("status persists day and summary entities", async () => {
    const { svc, store } = service({});
    const st = await svc.status();
    expect(store.summaries.get("current")?.delegations).toBe(st.delegations);
    expect(store.days.get(st.date)?.delegations).toBe(0);
  });
});
