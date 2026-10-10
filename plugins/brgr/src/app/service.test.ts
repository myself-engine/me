import { describe, expect, test } from "bun:test";
import { createTask, type Task, type TaskState } from "../domain/task.ts";
import type { BrgrCli, CliResult, Events, Git, TaskStore } from "../ports/index.ts";
import { createService } from "./service.ts";

const ok = (stdout = ""): CliResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): CliResult => ({ code: 1, stdout: "", stderr });

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/gone.ts b/gone.ts",
  "deleted file mode 100644",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-x",
].join("\n");

type Call = [string, ...unknown[]];

class FakeBrgr implements BrgrCli {
  calls: Call[] = [];
  responses: Partial<Record<keyof BrgrCli, CliResult>> = {};
  diffText = DIFF;
  private reply(name: keyof BrgrCli, args: unknown[], fallback: CliResult) {
    this.calls.push([name, ...args]);
    return Promise.resolve(this.responses[name] ?? fallback);
  }
  run = (r: Parameters<BrgrCli["run"]>[0]) => this.reply("run", [r], ok(JSON.stringify({ task_id: "t-new" })));
  wait = (id: string) => this.reply("wait", [id], ok(JSON.stringify({ state: "sealed", outcome: "candidate" })));
  result = (id: string) => this.reply("result", [id], ok(JSON.stringify({ artifacts: [{ text: "done" }] })));
  diff = (id: string, stat?: boolean) => this.reply("diff", [id, stat], ok(this.diffText));
  accept = (id: string, reason: string) => this.reply("accept", [id, reason], ok("{}"));
  reject = (id: string, reason: string) => this.reply("reject", [id, reason], ok("{}"));
  cancel = (id: string) => this.reply("cancel", [id], ok("{}"));
  apply = (id: string, ws: string) => this.reply("apply", [id, ws], ok("{}"));
  names = () => this.calls.map((c) => c[0]);
}

class FakeGit implements Git {
  calls: Call[] = [];
  dirty: string[] = [];
  failOn: string | null = null;
  private step(name: string, args: unknown[]) {
    this.calls.push([name, ...args]);
    if (this.failOn === name) throw new Error(`git ${name} failed: boom`);
  }
  status = async (cwd: string) => (this.step("status", [cwd]), this.dirty);
  add = async (cwd: string, files: string[]) => this.step("add", [cwd, files]);
  commit = async (cwd: string, message: string) => this.step("commit", [cwd, message]);
  headSha = async (cwd: string) => (this.step("headSha", [cwd]), "deadbeef");
}

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

function setup(state: TaskState = "sealed") {
  const brgr = new FakeBrgr();
  const git = new FakeGit();
  const store = new MemoryStore();
  const events = new FakeEvents();
  const task = createTask(
    { taskId: "t1", harness: "local.codex", objective: "Fix the parser\nwith details", project: "/repo", criterion: "c", origin: null },
    "2026-10-10T00:00:00.000Z",
  );
  store.tasks.set("t1", { ...task, state });
  let tick = 0;
  const service = createService({
    brgr,
    git,
    store,
    events,
    deadlineSeconds: () => 1800,
    now: () => `2026-10-10T00:00:0${++tick}.000Z`,
    sleep: async () => {},
  });
  return { brgr, git, store, events, service, get: () => store.tasks.get("t1")! };
}

describe("task.accept", () => {
  test("applies the sealed diff and commits exactly the touched files", async () => {
    const { brgr, git, events, service, get } = setup();
    const result = await service.accept({ taskId: "t1", reason: "looks good" });

    expect(brgr.calls).toEqual([
      ["diff", "t1", undefined],
      ["accept", "t1", "looks good"],
      ["apply", "t1", "/repo"],
    ]);
    expect(git.calls).toEqual([
      ["status", "/repo"],
      ["add", "/repo", ["src/a.ts", "gone.ts"]],
      ["commit", "/repo", "Fix the parser\n\nApplied from brgr task t1 via me.\n\nCo-Authored-By: me <noreply@me.local>"],
      ["headSha", "/repo"],
    ]);
    expect(get()).toMatchObject({ state: "applied", commitSha: "deadbeef", decisionReason: "looks good", error: null });
    expect(get().appliedAt).toBeString();
    expect(result).toEqual(get());
    expect(events.names()).toEqual(["task.accepted", "task.applied"]);
    expect(events.emitted.at(-1)!.data).toEqual({ taskId: "t1", state: "applied", harness: "local.codex" });
  });

  test.each(["running", "awaiting-input", "accepted", "applied", "rejected", "failed", "apply-failed", "cancelled"] as TaskState[])(
    "refuses a %s task without side effects",
    async (state) => {
      const { brgr, git, events, service, get } = setup(state);
      await expect(service.accept({ taskId: "t1" })).rejects.toThrow("봉인된 작업만");
      expect(brgr.calls).toEqual([]);
      expect(git.calls).toEqual([]);
      expect(events.emitted).toEqual([]);
      expect(get().state).toBe(state);
    },
  );

  test("dirty working tree -> stays sealed with a Korean error, brgr accept never called, retry works", async () => {
    const { brgr, git, events, service, get } = setup();
    git.dirty = [" M src/a.ts"];
    await expect(service.accept({ taskId: "t1" })).rejects.toThrow("커밋되지 않은 변경");
    expect(brgr.calls).toEqual([]);
    expect(get().state).toBe("sealed");
    expect(get().error).toContain("/repo");
    expect(get().commitSha).toBeNull();
    expect(events.names()).toEqual([]);

    git.dirty = [];
    await service.accept({ taskId: "t1" });
    expect(get().state).toBe("applied");
  });

  test("brgr apply failure after accept -> apply-failed, nothing committed", async () => {
    const { brgr, git, events, service, get } = setup();
    brgr.responses.apply = fail("patch does not apply");
    await expect(service.accept({ taskId: "t1" })).rejects.toThrow("patch does not apply");
    expect(brgr.names()).toEqual(["diff", "accept", "apply"]);
    expect(git.calls.map((c) => c[0])).toEqual(["status"]);
    expect(get().state).toBe("apply-failed");
    expect(get().error).toContain("brgr apply failed");
    expect(events.names()).toEqual(["task.accepted", "task.apply-failed"]);
  });

  test("git commit failure after apply -> apply-failed", async () => {
    const { brgr, git, events, service, get } = setup();
    git.failOn = "commit";
    await expect(service.accept({ taskId: "t1" })).rejects.toThrow("git commit failed");
    expect(brgr.calls.filter((c) => c[0] === "accept")).toHaveLength(1);
    expect(get()).toMatchObject({ state: "apply-failed", commitSha: null, appliedAt: null });
    expect(events.names()).toEqual(["task.accepted", "task.apply-failed"]);
  });

  test("brgr accept failure leaves the task sealed", async () => {
    const { brgr, events, service, get } = setup();
    brgr.responses.accept = fail("not a candidate");
    await expect(service.accept({ taskId: "t1" })).rejects.toThrow("brgr accept failed: not a candidate");
    expect(get().state).toBe("sealed");
    expect(events.emitted).toEqual([]);
  });

  test("an unreadable or empty diff leaves the task sealed and brgr undecided", async () => {
    const { brgr, service, get } = setup();
    brgr.diffText = "";
    await expect(service.accept({ taskId: "t1" })).rejects.toThrow("변경된 파일이 없어요");
    expect(brgr.names()).toEqual(["diff"]);
    expect(get().state).toBe("sealed");
  });

  test("defaults the reason", async () => {
    const { brgr, service } = setup();
    await service.accept({ taskId: "t1" });
    expect(brgr.calls.find((c) => c[0] === "accept")).toEqual(["accept", "t1", "accepted from me"]);
  });
});

describe("other methods", () => {
  test("reject records the reason; refused when not sealed", async () => {
    const s = setup();
    expect((await s.service.reject({ taskId: "t1", reason: "no" })).state).toBe("rejected");
    expect(s.get().decisionReason).toBe("no");
    const r = setup("running");
    await expect(r.service.reject({ taskId: "t1" })).rejects.toThrow("cannot move");
    expect(r.brgr.calls).toEqual([]);
  });

  test("cancel moves running to cancelled", async () => {
    const { service, get, events } = setup("running");
    await service.cancel({ taskId: "t1" });
    expect(get().state).toBe("cancelled");
    expect(events.names()).toEqual(["task.cancelled"]);
  });

  test("delegate stores a running task and the watcher seals it", async () => {
    const { brgr, store, events, service } = setup();
    const { taskId } = await service.delegate({ harness: "local.codex", objective: "obj", project: "/repo" });
    expect(taskId).toBe("t-new");
    expect(brgr.calls[0]).toEqual([
      "run",
      { objective: "obj", harness: "local.codex", criterion: "The objective is satisfied and the result explains what changed.", deadlineSeconds: 1800, project: "/repo" },
    ]);
    await service.watch(taskId); // already watching from delegate: returns immediately
    await Bun.sleep(0);
    await Bun.sleep(0);
    const t = store.tasks.get("t-new")!;
    expect(t).toMatchObject({ state: "sealed", outcome: "candidate", resultText: "done", commitSha: null });
    expect(events.names()).toEqual(["task.running", "task.sealed"]);
  });

  test("delegate surfaces uncommitted-change refusals in Korean", async () => {
    const { brgr, service } = setup();
    brgr.responses.run = fail("error: workspace has uncommitted changes");
    await expect(service.delegate({ harness: "local.codex", objective: "o", project: "/repo" })).rejects.toThrow("커밋되지 않은 변경");
  });
});
