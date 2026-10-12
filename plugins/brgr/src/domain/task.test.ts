import { describe, expect, test } from "bun:test";
import { canTransition, createQueuedTask, createTask, InvalidTransition, isTerminal, transition, type TaskState } from "./task.ts";

const AT = "2026-10-10T00:00:00.000Z";
const base = () => createTask({ taskId: "t1", harness: "local.codex", objective: "do it", project: "/p", criterion: "c", origin: null }, AT);
const at = (state: TaskState) => ({ ...base(), state });

describe("task state machine", () => {
  test("new tasks start running with no apply fields", () => {
    const t = base();
    expect(t.state).toBe("running");
    expect(t.commitSha).toBeNull();
    expect(t.appliedAt).toBeNull();
  });

  test.each([
    ["queued", "running"],
    ["queued", "failed"],
    ["queued", "cancelled"],
  ] as [TaskState, TaskState][])("allows %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(transition(at(from), to, {}, "later").state).toBe(to);
  });

  test.each([
    ["queued", "sealed"],
    ["queued", "accepted"],
    ["queued", "queued"],
    ["running", "queued"],
  ] as [TaskState, TaskState][])("rejects %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => transition(at(from), to, {}, "later")).toThrow(InvalidTransition);
  });

  test.each([
    ["running", "sealed"],
    ["running", "failed"],
    ["running", "awaiting-input"],
    ["running", "cancelled"],
    ["awaiting-input", "awaiting-input"],
    ["awaiting-input", "running"],
    ["awaiting-input", "sealed"],
    ["sealed", "accepted"],
    ["sealed", "rejected"],
    ["sealed", "apply-failed"],
    ["accepted", "applied"],
    ["accepted", "apply-failed"],
    ["applied", "reverted"],
  ] as [TaskState, TaskState][])("allows %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(transition(at(from), to, {}, "later").state).toBe(to);
  });

  test.each([
    ["running", "accepted"],
    ["running", "applied"],
    ["sealed", "applied"],
    ["sealed", "cancelled"],
    ["sealed", "sealed"],
    ["accepted", "rejected"],
    ["accepted", "accepted"],
    ["rejected", "accepted"],
    ["failed", "sealed"],
    ["applied", "apply-failed"],
    ["apply-failed", "applied"],
    ["reverted", "applied"],
    ["cancelled", "running"],
  ] as [TaskState, TaskState][])("rejects %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => transition(at(from), to, {}, "later")).toThrow(InvalidTransition);
  });

  test("terminal states have no way out", () => {
    for (const s of ["failed", "apply-failed", "rejected", "cancelled", "reverted"] as const) expect(isTerminal(s)).toBe(true);
    for (const s of ["queued", "running", "awaiting-input", "sealed", "accepted", "applied"] as const) expect(isTerminal(s)).toBe(false);
  });

  test("queued tasks carry no remote id and no verify result yet", () => {
    const t = createQueuedTask({ taskId: "q-1", harness: "local.codex", objective: "do it", project: "/p", criterion: "c", origin: null }, AT);
    expect(t).toMatchObject({ state: "queued", remoteId: null, verify: null, autoApply: false });
  });

  test("transition applies the patch, stamps updatedAt, and does not mutate the input", () => {
    const t = at("accepted");
    const next = transition(t, "applied", { commitSha: "abc", appliedAt: "later" }, "later");
    expect(next).toMatchObject({ state: "applied", commitSha: "abc", appliedAt: "later", updatedAt: "later", createdAt: AT });
    expect(t.state).toBe("accepted");
  });
});
