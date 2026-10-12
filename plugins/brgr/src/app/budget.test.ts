import { describe, expect, test } from "bun:test";
import { createTask, type Task, type TaskState } from "../domain/task.ts";
import type { Approvals, BrgrCli, Budget, BudgetCheck, CliResult, Events, Git, TaskStore } from "../ports/index.ts";
import { createService } from "./service.ts";

const ok = (stdout = ""): CliResult => ({ code: 0, stdout, stderr: "" });

class FakeBrgr implements BrgrCli {
  runs = 0;
  run = (_r: Parameters<BrgrCli["run"]>[0]) => (this.runs++, Promise.resolve(ok(JSON.stringify({ task_id: "remote-1" }))));
  wait = (_id: string) => Promise.resolve(ok(JSON.stringify({ state: "sealed", outcome: "candidate" })));
  result = (_id: string) => Promise.resolve(ok(JSON.stringify({ artifacts: [{ text: "done" }] })));
  diff = (_id: string, _stat?: boolean) => Promise.resolve(ok("diff --git a/x b/x\n"));
  status = (_id: string) => Promise.resolve(ok("{}"));
  accept = (_id: string, _reason: string) => Promise.resolve(ok("{}"));
  reject = (_id: string, _reason: string) => Promise.resolve(ok("{}"));
  cancel = (_id: string) => Promise.resolve(ok("{}"));
  apply = (_id: string, _ws: string) => Promise.resolve(ok("{}"));
}

const git: Git = {
  status: async () => [],
  add: async () => {},
  commit: async () => {},
  headSha: async () => "deadbeef",
};

class MemoryStore implements TaskStore {
  tasks = new Map<string, Task>();
  get = async (id: string) => this.tasks.get(id) ?? null;
  put = async (t: Task) => void this.tasks.set(t.taskId, t);
  listByState = async (s: TaskState) => [...this.tasks.values()].filter((t) => t.state === s);
}

class FakeEvents implements Events {
  emitted: { name: string; data: unknown }[] = [];
  emit = async (name: string, data: unknown) => void this.emitted.push({ name, data });
  names = () => this.emitted.map((e) => e.name);
}

function setup(budget?: Budget, approvals?: Approvals) {
  const brgr = new FakeBrgr();
  const store = new MemoryStore();
  const events = new FakeEvents();
  const service = createService({
    brgr,
    git,
    store,
    events,
    deadlineSeconds: () => 1800,
    sleep: async () => {},
    newId: () => "q-1",
    ...(budget ? { budget } : {}),
    ...(approvals ? { approvals } : {}),
  });
  return { brgr, store, events, service };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(10);
  expect(cond()).toBe(true);
};

describe("budget hook", () => {
  test("no budget plugin means no gate: the delegation proceeds", async () => {
    const { brgr, service } = setup();
    const { taskId } = await service.delegate({ harness: "local.codex", objective: "o", project: "/repo" });
    expect(taskId).toBe("q-1");
    expect(brgr.runs).toBe(1);
  });

  test("a failing budget call lets the delegation proceed", async () => {
    const { brgr, service } = setup({ check: async () => Promise.reject(new Error("budget is down")) });
    await service.delegate({ harness: "local.codex", objective: "o", project: "/repo" });
    expect(brgr.runs).toBe(1);
  });

  test("ok=false fails fast with the Korean reason and never touches brgr", async () => {
    const checks: unknown[] = [];
    const { brgr, store, service } = setup({
      check: async (p) => (checks.push(p), { ok: false, reason: "이번 주 한도 초과" } satisfies BudgetCheck),
    });
    await expect(service.delegate({ harness: "local.codex", objective: "o", project: "/repo" })).rejects.toThrow(
      "예산 때문에 위임하지 않았어요: 이번 주 한도 초과",
    );
    expect(checks).toEqual([{ harness: "local.codex", project: "/repo", autoApply: false }]);
    expect(brgr.runs).toBe(0);
    expect(store.tasks.size).toBe(0);
  });

  test("ok=false without a reason still says why in Korean", async () => {
    const { service } = setup({ check: async () => ({ ok: false }) });
    await expect(service.delegate({ harness: "local.codex", objective: "o", project: "/repo" })).rejects.toThrow(
      "예산 때문에 위임하지 않았어요",
    );
  });

  test("needsApproval starts only after the kernel approval", async () => {
    const approvals: Approvals & { calls: unknown[] } = {
      calls: [],
      request: async (p) => (approvals.calls.push(p), { approvalId: "a1", decision: "approve" }),
    };
    const { brgr, service } = setup({ check: async () => ({ ok: true, needsApproval: true, reason: "큰 작업" }) }, approvals);
    await service.delegate({ harness: "local.codex", objective: "o", project: "/repo" });
    expect(brgr.runs).toBe(1);
    // The gate runs when the delegation is asked for and again when it actually starts.
    expect(approvals.calls).toHaveLength(2);
    expect(approvals.calls[0]).toMatchObject({ risk: "medium", summary: expect.stringContaining("예산") });
  });

  test("a rejected budget approval stops the delegation in Korean", async () => {
    const { brgr, service } = setup(
      { check: async () => ({ ok: true, needsApproval: true }) },
      { request: async () => ({ approvalId: "a1", decision: "reject" }) },
    );
    await expect(service.delegate({ harness: "local.codex", objective: "o", project: "/repo" })).rejects.toThrow(
      "예산 승인이 거절돼서 맡기지 않았어요.",
    );
    expect(brgr.runs).toBe(0);
  });

  test("an expired budget approval says the wait timed out", async () => {
    const { service } = setup(
      { check: async () => ({ ok: true, needsApproval: true }) },
      { request: async () => ({ approvalId: "a1", decision: "reject", note: "expired" }) },
    );
    await expect(service.delegate({ harness: "local.codex", objective: "o", project: "/repo" })).rejects.toThrow(
      "예산 승인 시간이 지나서 맡기지 않았어요.",
    );
  });

  test("a denial between queueing and start fails the queued task instead of starting it", async () => {
    const brgr = new FakeBrgr();
    const store = new MemoryStore();
    const events = new FakeEvents();
    let deny = false;
    const svc = createService({
      brgr,
      git,
      store,
      events,
      deadlineSeconds: () => 1800,
      sleep: async () => {},
      // No slot, so the delegation stays queued.
      config: () => ({ maxRunning: 0 }),
      newId: () => "q-9",
      budget: { check: async () => (deny ? { ok: false, reason: "늦은 거부" } : { ok: true }) },
    });
    const { taskId } = await svc.delegate({ harness: "local.codex", objective: "o", project: "/repo" });
    expect(store.tasks.get(taskId)?.state).toBe("queued");
    deny = true;
    // A fresh slot opens: resume re-pumps the queue and the gate denies the start.
    const svc2 = createService({
      brgr,
      git,
      store,
      events,
      deadlineSeconds: () => 1800,
      sleep: async () => {},
      config: () => ({}),
      budget: { check: async () => ({ ok: false, reason: "늦은 거부" }) },
    });
    await svc2.resume();
    await until(() => store.tasks.get(taskId)?.state === "failed");
    expect(store.tasks.get(taskId)?.error).toContain("늦은 거부");
    expect(brgr.runs).toBe(0);
    expect(events.names()).toContain("task.failed");
  });

  test("old tasks without a remote id still resolve through their own id", async () => {
    const brgr = new FakeBrgr();
    const store = new MemoryStore();
    const events = new FakeEvents();
    const t = createTask(
      { taskId: "legacy", harness: "local.codex", objective: "o", project: "/repo", criterion: "c", origin: null },
      "2026-10-10T00:00:00.000Z",
    );
    store.tasks.set("legacy", { ...t, state: "sealed" });
    const service = createService({ brgr, git, store, events, deadlineSeconds: () => 1800, sleep: async () => {} });
    await service.accept({ taskId: "legacy" });
    expect(store.tasks.get("legacy")?.state).toBe("applied");
  });
});
