import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask, type Task, type TaskState } from "../domain/task.ts";
import type { Approvals, Events, Git, TaskStore } from "../ports/index.ts";
import { gitCli } from "../adapters/git.ts";
import { createService } from "./service.ts";

const AT = "2026-10-10T00:00:00.000Z";

class FakeGit implements Git {
  calls: string[] = [];
  dirty: string[] = [];
  ancestor = true;
  merge = false;
  touched = ["src/a.ts"];
  later: string[] = [];
  failRevert: string | null = null;
  throwOn: Partial<Record<"status" | "isAncestor" | "isMerge" | "filesIn" | "changedSince", string>> = {};
  status = async (_cwd: string) => {
    this.calls.push("status");
    if (this.throwOn.status) throw new Error(this.throwOn.status);
    return this.dirty;
  };
  add = async () => void this.calls.push("add");
  commit = async () => void this.calls.push("commit");
  headSha = async () => (this.calls.push("headSha"), "deadbeef");
  isAncestor = async () => {
    this.calls.push("isAncestor");
    if (this.throwOn.isAncestor) throw new Error(this.throwOn.isAncestor);
    return this.ancestor;
  };
  isMerge = async () => {
    this.calls.push("isMerge");
    if (this.throwOn.isMerge) throw new Error(this.throwOn.isMerge);
    return this.merge;
  };
  filesIn = async () => {
    this.calls.push("filesIn");
    if (this.throwOn.filesIn) throw new Error(this.throwOn.filesIn);
    return this.touched;
  };
  changedSince = async () => {
    this.calls.push("changedSince");
    if (this.throwOn.changedSince) throw new Error(this.throwOn.changedSince);
    return this.later;
  };
  revert = async () => {
    this.calls.push("revert");
    if (this.failRevert) throw new Error(this.failRevert);
  };
  abortRevert = async () => void this.calls.push("abortRevert");
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

class FakeApprovals implements Approvals {
  calls = 0;
  decision: "approve" | "reject" = "approve";
  note?: string;
  fail?: string;
  request = async (p: Parameters<Approvals["request"]>[0]) => {
    this.calls++;
    if (this.fail) throw new Error(this.fail);
    expect(p.summary).toContain("되돌리기");
    return { approvalId: "a1", decision: this.decision, ...(this.note ? { note: this.note } : {}) };
  };
}

const nullBrgr = new Proxy(
  {},
  {
    get: () => {
      throw new Error("revert must not touch brgr");
    },
  },
) as any;

function setup(state: TaskState = "applied", commitSha: string | null = "abc123") {
  const git = new FakeGit();
  const store = new MemoryStore();
  const events = new FakeEvents();
  const approvals = new FakeApprovals();
  const base = createTask(
    { taskId: "t1", harness: "local.codex", objective: "Add thing", project: "/repo", criterion: "c", origin: null },
    AT,
  );
  store.tasks.set("t1", { ...base, state, commitSha, appliedAt: state === "applied" ? AT : null });
  const service = createService({
    brgr: nullBrgr,
    git,
    store,
    events,
    deadlineSeconds: () => 1800,
    now: () => "2026-10-11T00:00:00.000Z",
    approvals,
  });
  return { git, store, events, approvals, service, get: () => store.tasks.get("t1")! };
}

describe("task.revert", () => {
  test("success without later overlap: reverts directly, no approval", async () => {
    const { git, approvals, events, service, get } = setup();
    const result = await service.revert({ taskId: "t1" });
    expect(git.calls).toEqual(["status", "isAncestor", "isMerge", "filesIn", "changedSince", "revert"]);
    expect(approvals.calls).toBe(0);
    expect(get()).toMatchObject({ state: "reverted", error: null, revert: { commit: "abc123" } });
    expect(get().revert!.at).toBeString();
    expect(result).toEqual(get());
    expect(events.names()).toEqual(["task.reverted"]);
    expect(events.emitted[0]!.data).toEqual({ taskId: "t1", state: "reverted", harness: "local.codex" });
  });

  test.each(["queued", "running", "awaiting-input", "sealed", "accepted", "failed", "rejected", "cancelled", "apply-failed", "reverted"] as TaskState[])(
    "refuses a %s task without side effects",
    async (state) => {
      const { git, events, service, get } = setup(state);
      await expect(service.revert({ taskId: "t1" })).rejects.toThrow("적용한 작업만");
      expect(git.calls).toEqual([]);
      expect(events.emitted).toEqual([]);
      expect(get().state).toBe(state);
    },
  );

  test("refuses an applied task with no commit recorded", async () => {
    const { git, service, get } = setup("applied", null);
    await expect(service.revert({ taskId: "t1" })).rejects.toThrow("적용한 작업만");
    expect(git.calls).toEqual([]);
    expect(get().state).toBe("applied");
  });

  test("dirty tree -> stays applied with a Korean error, revert never runs, retry works", async () => {
    const { git, service, get } = setup();
    git.dirty = [" M src/a.ts"];
    await expect(service.revert({ taskId: "t1" })).rejects.toThrow("커밋되지 않은 변경");
    expect(git.calls).toEqual(["status"]);
    expect(get().state).toBe("applied");
    expect(get().revert).toBeNull();
    git.dirty = [];
    await service.revert({ taskId: "t1" });
    expect(get().state).toBe("reverted");
  });

  test("commit not on the current branch -> stays applied", async () => {
    const { git, service, get } = setup();
    git.ancestor = false;
    await expect(service.revert({ taskId: "t1" })).rejects.toThrow("지금 브랜치에 없어");
    expect(git.calls).toEqual(["status", "isAncestor"]);
    expect(get().state).toBe("applied");
  });

  test("merge commit -> refuses with a Korean reason", async () => {
    const { git, service, get } = setup();
    git.merge = true;
    await expect(service.revert({ taskId: "t1" })).rejects.toThrow("합치기(머지)");
    expect(git.calls).toContain("isMerge");
    expect(get().state).toBe("applied");
  });

  test("later commits on the same files ask approval; approve reverts", async () => {
    const { git, approvals, service, get } = setup();
    git.later = ["src/a.ts", "other.ts"];
    await service.revert({ taskId: "t1" });
    expect(approvals.calls).toBe(1);
    expect(git.calls).toContain("revert");
    expect(get().state).toBe("reverted");
  });

  test("approval reject cancels, tree untouched", async () => {
    const { git, approvals, service, get } = setup();
    git.later = ["src/a.ts"];
    approvals.decision = "reject";
    await expect(service.revert({ taskId: "t1" })).rejects.toThrow("취소했어요");
    expect(git.calls).not.toContain("revert");
    expect(get().state).toBe("applied");
    expect(get().revert).toBeNull();
  });

  test("expired approval says so in Korean", async () => {
    const { git, approvals, service, get } = setup();
    git.later = ["src/a.ts"];
    approvals.decision = "reject";
    approvals.note = "expired";
    await expect(service.revert({ taskId: "t1" })).rejects.toThrow("승인 시간이 지나");
    expect(git.calls).not.toContain("revert");
    expect(get().state).toBe("applied");
  });

  test("conflict aborts the revert and leaves the tree as it was", async () => {
    const { git, service, get } = setup();
    git.failRevert = "CONFLICT (modify/delete)";
    await expect(service.revert({ taskId: "t1" })).rejects.toThrow("충돌이 나서");
    expect(git.calls).toEqual(["status", "isAncestor", "isMerge", "filesIn", "changedSince", "revert", "abortRevert"]);
    expect(get().state).toBe("applied");
    expect(get().revert).toBeNull();
    expect(get().error).toContain("그대로");
  });

  test("missing taskId rejects before touching anything", async () => {
    const { git, service } = setup();
    await expect(service.revert({} as any)).rejects.toThrow("taskId is required");
    expect(git.calls).toEqual([]);
  });
});

describe("task.revert against a real git repo", () => {
  const sh = (dir: string, args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${new TextDecoder().decode(r.stderr).slice(0, 200)}`);
    return new TextDecoder().decode(r.stdout).trim();
  };
  const initRepo = () => {
    const dir = mkdtempSync(join(tmpdir(), "me-revert-"));
    sh(dir, ["init", "-q", "-b", "main"]);
    sh(dir, ["config", "user.email", "test@me.local"]);
    sh(dir, ["config", "user.name", "me test"]);
    return dir;
  };
  const serviceFor = (dir: string, task: Task, approvals?: Approvals) => {
    const store = new MemoryStore();
    store.tasks.set(task.taskId, task);
    const events = new FakeEvents();
    return createService({ brgr: nullBrgr, git: gitCli(), store, events, deadlineSeconds: () => 60, now: () => new Date().toISOString(), approvals });
  };
  const appliedTask = (dir: string, sha: string): Task => ({
    ...createTask({ taskId: "t1", harness: "local.codex", objective: "Add f", project: dir, criterion: "c", origin: null }, AT),
    state: "applied" as const,
    commitSha: sha,
    appliedAt: AT,
  });

  test("reverts the applied commit and restores the file", async () => {
    const dir = initRepo();
    writeFileSync(join(dir, "f.txt"), "v1\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-q", "-m", "init"]);
    writeFileSync(join(dir, "f.txt"), "v2\n");
    sh(dir, ["commit", "-q", "-am", "applied change"]);
    const sha = sh(dir, ["rev-parse", "HEAD"]);
    const service = serviceFor(dir, appliedTask(dir, sha));
    const result = await service.revert({ taskId: "t1" });
    expect(result.state).toBe("reverted");
    expect(result.revert).toMatchObject({ commit: sha });
    expect(await Bun.file(join(dir, "f.txt")).text()).toBe("v1\n");
    expect(sh(dir, ["status", "--porcelain", "--untracked-files=no"])).toBe("");
  });

  test("a conflicting later commit refuses and leaves a clean tree", async () => {
    const dir = initRepo();
    writeFileSync(join(dir, "f.txt"), "v1\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-q", "-m", "init"]);
    writeFileSync(join(dir, "f.txt"), "v2\n");
    sh(dir, ["commit", "-q", "-am", "applied change"]);
    const sha = sh(dir, ["rev-parse", "HEAD"]);
    writeFileSync(join(dir, "f.txt"), "v3\n");
    sh(dir, ["commit", "-q", "-am", "later change"]);
    const approvals: Approvals = { request: async () => ({ approvalId: "a", decision: "approve" }) };
    const service = serviceFor(dir, appliedTask(dir, sha), approvals);
    await expect(service.revert({ taskId: "t1" })).rejects.toThrow("충돌이 나서");
    expect(sh(dir, ["status", "--porcelain", "--untracked-files=no"])).toBe("");
    expect(await Bun.file(join(dir, "f.txt")).text()).toBe("v3\n");
  });
});
