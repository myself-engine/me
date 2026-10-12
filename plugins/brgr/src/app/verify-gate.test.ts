import { describe, expect, test } from "bun:test";
import { createTask, type Task, type TaskState, type VerifyInfo } from "../domain/task.ts";
import type { BrgrCli, CliResult, Events, Git, TaskStore, Verifier } from "../ports/index.ts";
import { createService } from "./service.ts";

const ok = (stdout = ""): CliResult => ({ code: 0, stdout, stderr: "" });

const DIFF = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";

class FakeBrgr implements BrgrCli {
  accepts: string[] = [];
  run = (_r: Parameters<BrgrCli["run"]>[0]) => Promise.resolve(ok(JSON.stringify({ task_id: "remote-1" })));
  wait = (_id: string) => Promise.resolve(ok(JSON.stringify({ state: "sealed", outcome: "candidate" })));
  result = (_id: string) => Promise.resolve(ok(JSON.stringify({ artifacts: [{ text: "done" }] })));
  diff = (_id: string, _stat?: boolean) => Promise.resolve(ok(DIFF));
  accept = (id: string, _reason: string) => (this.accepts.push(id), Promise.resolve(ok("{}")));
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

const passed: VerifyInfo = { state: "passed", commands: [{ cmd: "bun test", exitCode: 0, ms: 5, tail: "3 pass" }] };
const failed: VerifyInfo = {
  state: "failed",
  commands: [
    { cmd: "bun run typecheck", exitCode: 0, ms: 5, tail: "ok" },
    { cmd: "bun test", exitCode: 1, ms: 9, tail: "1 fail\nfoo.ts: expected 1 to be 2" },
  ],
};

function setup(verifier: Verifier, verifyRequired = false) {
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
    config: () => ({ verifyRequired }),
    verifier,
    newId: () => "q-1",
  });
  return { brgr, store, events, service };
}

const sealedWith = (verify: VerifyInfo | null) => {
  const t = createTask(
    { taskId: "t1", harness: "local.codex", objective: "o", project: "/repo", criterion: "c", origin: null },
    "2026-10-10T00:00:00.000Z",
  );
  return { ...t, state: "sealed" as const, verify };
};

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(10);
  expect(cond()).toBe(true);
};

describe("verify gate", () => {
  test("a passed gate auto-applies and records the result", async () => {
    const { brgr, store, events, service } = setup({ verify: async () => passed });
    const { taskId } = await service.delegate({ harness: "local.codex", objective: "o", project: "/repo", autoApply: true });
    await until(() => store.tasks.get(taskId)?.state === "applied");
    expect(store.tasks.get(taskId)?.verify).toEqual(passed);
    expect(brgr.accepts).toEqual(["remote-1"]);
    expect(events.names()).toEqual(["task.queued", "task.running", "task.sealed", "task.verified", "task.accepted", "task.applied"]);
    expect(events.emitted.find((e) => e.name === "task.verified")?.data).toMatchObject({ taskId, verify: "passed" });
  });

  test("a failed gate leaves the task sealed with a Korean reason naming the command", async () => {
    const seen: { taskId: string; project: string; diff: string }[] = [];
    const { brgr, store, service } = setup({
      verify: async (p) => (seen.push(p), failed),
    });
    const { taskId } = await service.delegate({ harness: "local.codex", objective: "o", project: "/repo", autoApply: true });
    await until(() => store.tasks.get(taskId)?.state === "sealed" && store.tasks.get(taskId)?.error !== null);
    const t = store.tasks.get(taskId)!;
    expect(t.verify).toEqual(failed);
    expect(t.error).toContain("검사");
    expect(t.error).toContain("bun test");
    expect(brgr.accepts).toEqual([]);
    // The sealed diff is what gets checked.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ taskId, project: "/repo" });
    expect(seen[0]!.diff).toContain("diff --git");
  });

  test("a gate error leaves the task sealed without auto-applying", async () => {
    const { brgr, store, service } = setup({ verify: async () => ({ state: "error", commands: [] }) });
    const { taskId } = await service.delegate({ harness: "local.codex", objective: "o", project: "/repo", autoApply: true });
    await until(() => store.tasks.get(taskId)?.error !== null);
    expect(store.tasks.get(taskId)?.state).toBe("sealed");
    expect(store.tasks.get(taskId)?.error).toContain("검사 실행에 실패");
    expect(brgr.accepts).toEqual([]);
  });

  test("no checks auto-applies unless the config requires checks", async () => {
    const skipped: Verifier = { verify: async () => ({ state: "skipped", commands: [] }) };
    const open = setup(skipped, false);
    const id1 = (await open.service.delegate({ harness: "local.codex", objective: "o", project: "/repo", autoApply: true })).taskId;
    await until(() => open.store.tasks.get(id1)?.state === "applied");
    expect(open.store.tasks.get(id1)?.verify).toEqual({ state: "skipped", commands: [] });

    const strict = setup(skipped, true);
    const id2 = (await strict.service.delegate({ harness: "local.codex", objective: "o", project: "/repo", autoApply: true })).taskId;
    await until(() => strict.store.tasks.get(id2)?.error !== null);
    expect(strict.store.tasks.get(id2)?.state).toBe("sealed");
    expect(strict.store.tasks.get(id2)?.error).toContain("검사할 항목이 없어");
    expect(strict.brgr.accepts).toEqual([]);
  });

  test("manual accept stays allowed whatever the gate said", async () => {
    const brgr = new FakeBrgr();
    const store = new MemoryStore();
    const events = new FakeEvents();
    store.tasks.set("t1", sealedWith(failed));
    const service = createService({ brgr, git, store, events, deadlineSeconds: () => 1800, sleep: async () => {} });
    await service.accept({ taskId: "t1" });
    expect(store.tasks.get("t1")?.state).toBe("applied");
    expect(store.tasks.get("t1")?.verify).toEqual(failed);
  });

  test("non-autoApply seals still record the gate for the review panel", async () => {
    const { store, service } = setup({ verify: async () => failed });
    const { taskId } = await service.delegate({ harness: "local.codex", objective: "o", project: "/repo" });
    await until(() => store.tasks.get(taskId)?.verify !== null);
    expect(store.tasks.get(taskId)).toMatchObject({ state: "sealed", verify: failed });
  });
});
