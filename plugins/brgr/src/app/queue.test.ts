import { describe, expect, test } from "bun:test";
import { createTask, type Task, type TaskState } from "../domain/task.ts";
import type { BrgrCli, CliResult, Events, Git, TaskStore } from "../ports/index.ts";
import { createService } from "./service.ts";

const ok = (stdout = ""): CliResult => ({ code: 0, stdout, stderr: "" });

const DIFF = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";

/** Brgr fake with a manual gate on wait, so tests control when delegations seal. */
class GatedBrgr implements BrgrCli {
  runs: { objective: string; project: string }[] = [];
  private releases = new Map<string, (r: CliResult) => void>();
  private seq = 0;
  run = (r: Parameters<BrgrCli["run"]>[0]) => {
    this.runs.push({ objective: r.objective, project: r.project });
    return Promise.resolve(ok(JSON.stringify({ task_id: `remote-${++this.seq}` })));
  };
  wait = (id: string) =>
    new Promise<CliResult>((resolve) => {
      this.releases.set(id, resolve);
    });
  release(id: string, outcome = "candidate") {
    this.releases.get(id)?.(ok(JSON.stringify({ state: "sealed", outcome })));
    this.releases.delete(id);
  }
  result = (_id: string) => Promise.resolve(ok(JSON.stringify({ artifacts: [{ text: "done" }] })));
  diff = (_id: string, _stat?: boolean) => Promise.resolve(ok(DIFF));
  status = (_id: string) => Promise.resolve(ok("{}"));
  accept = (_id: string, _reason: string) => Promise.resolve(ok("{}"));
  reject = (_id: string, _reason: string) => Promise.resolve(ok("{}"));
  cancelCalls: string[] = [];
  cancel = (id: string) => (this.cancelCalls.push(id), Promise.resolve(ok("{}")));
  apply = (_id: string, _ws: string) => Promise.resolve(ok("{}"));
  messages = (_id: string, _recipient: "owner" | "worker") => Promise.resolve(ok("[]"));
  sendMessage = (_id: string, _p: { to: "owner" | "worker"; kind: "question" | "reply" | "note"; body: string; replyTo?: string }) => Promise.resolve(ok("{}"));
  input = (_id: string, _p: { text?: string; key?: string }) => Promise.resolve(ok("{}"));
}

const git: Git = {
  status: async () => [],
  add: async () => {},
  commit: async () => {},
  headSha: async () => "deadbeef",
  isAncestor: async () => true,
  isMerge: async () => false,
  filesIn: async () => [],
  changedSince: async () => [],
  revert: async () => {},
  abortRevert: async () => {},
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

function setup(maxRunning = 3) {
  const brgr = new GatedBrgr();
  const store = new MemoryStore();
  const events = new FakeEvents();
  let n = 0;
  const service = createService({
    brgr,
    git,
    store,
    events,
    deadlineSeconds: () => 1800,
    sleep: async () => {},
    config: () => ({ maxRunning }),
    newId: () => `q-${++n}`,
  });
  return { brgr, store, events, service };
}

const runningOf = (store: MemoryStore, id: string) => store.tasks.get(id)!;
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(10);
  expect(cond()).toBe(true);
};

describe("delegation queue", () => {
  test("at most one running delegation per project; the second waits queued", async () => {
    const { brgr, store, service } = setup();
    const a = await service.delegate({ harness: "local.codex", objective: "a", project: "/a" });
    const b = await service.delegate({ harness: "local.codex", objective: "b", project: "/a" });
    await until(() => runningOf(store, a.taskId).state === "running");
    expect(runningOf(store, b.taskId).state).toBe("queued");
    expect(brgr.runs).toEqual([{ objective: "a", project: "/a" }]);

    brgr.release(runningOf(store, a.taskId).remoteId!);
    await until(() => runningOf(store, b.taskId).state === "running");
    expect(runningOf(store, a.taskId).state).toBe("sealed");
    expect(brgr.runs.map((r) => r.objective)).toEqual(["a", "b"]);
  });

  test("a global cap holds extra delegations queued across projects", async () => {
    const { brgr, store, service } = setup(1);
    const a = await service.delegate({ harness: "local.codex", objective: "a", project: "/a" });
    const c = await service.delegate({ harness: "local.codex", objective: "c", project: "/b" });
    await until(() => runningOf(store, a.taskId).state === "running");
    expect(runningOf(store, c.taskId).state).toBe("queued");
    expect(brgr.runs).toHaveLength(1);

    brgr.release(runningOf(store, a.taskId).remoteId!);
    await until(() => runningOf(store, c.taskId).state === "running");
    expect(brgr.runs.map((r) => r.objective)).toEqual(["a", "c"]);
  });

  test("queued delegations start FIFO; a blocked head never stops later projects", async () => {
    const { brgr, store, service } = setup(3);
    const a = await service.delegate({ harness: "local.codex", objective: "a", project: "/same" });
    const blocked = await service.delegate({ harness: "local.codex", objective: "blocked", project: "/same" });
    const later = await service.delegate({ harness: "local.codex", objective: "later", project: "/other" });
    await until(() => runningOf(store, a.taskId).state === "running");
    await until(() => runningOf(store, later.taskId).state === "running");
    expect(runningOf(store, blocked.taskId).state).toBe("queued");
    expect(brgr.runs.map((r) => r.objective)).toEqual(["a", "later"]);

    brgr.release(runningOf(store, a.taskId).remoteId!);
    await until(() => runningOf(store, blocked.taskId).state === "running");
    expect(brgr.runs.map((r) => r.objective)).toEqual(["a", "later", "blocked"]);
  });

  test("resume restarts queued delegations in order", async () => {
    const first = setup(1);
    const at = (n: number) => `2026-10-10T00:00:0${n}.000Z`;
    for (const [id, objective, createdAt] of [["old", "old", at(1)], ["new", "new", at(2)]] as const) {
      const t = createTask({ taskId: id, harness: "local.codex", objective, project: "/a", criterion: "c", origin: null }, createdAt);
      first.store.tasks.set(id, { ...t, state: "queued" });
    }
    await first.service.resume();
    await until(() => first.store.tasks.get("old")?.state === "running");
    expect(first.store.tasks.get("new")?.state).toBe("queued");
    expect(first.brgr.runs.map((r) => r.objective)).toEqual(["old"]);
  });

  test("cancelling a queued delegation never touches brgr", async () => {
    const { brgr, store, events, service } = setup(1);
    const a = await service.delegate({ harness: "local.codex", objective: "a", project: "/a" });
    const b = await service.delegate({ harness: "local.codex", objective: "b", project: "/b" });
    await until(() => runningOf(store, a.taskId).state === "running");
    await service.cancel({ taskId: b.taskId });
    expect(runningOf(store, b.taskId).state).toBe("cancelled");
    expect(brgr.cancelCalls).toEqual([]);
    expect(events.names()).toContain("task.cancelled");
  });

  test("queued tasks expose their position: earlier queued tasks come first", async () => {
    const { store, service } = setup(1);
    const a = await service.delegate({ harness: "local.codex", objective: "a", project: "/a" });
    const b = await service.delegate({ harness: "local.codex", objective: "b", project: "/b" });
    const c = await service.delegate({ harness: "local.codex", objective: "c", project: "/c" });
    await until(() => runningOf(store, a.taskId).state === "running");
    const queued = [...store.tasks.values()]
      .filter((t) => t.state === "queued")
      .sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.taskId.localeCompare(y.taskId));
    expect(queued.map((t) => t.taskId)).toEqual([b.taskId, c.taskId]);
  });
});
