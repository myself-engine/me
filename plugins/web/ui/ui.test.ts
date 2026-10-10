import { describe, expect, test } from "bun:test";
import { parseDiffStat, splitDiff } from "./diff.ts";
import { isDeep, parseRoute, taskHref } from "./routes.ts";
import { initial, reducer, threadTone, toneOf, workItems, type State } from "./state.ts";

describe("parseRoute", () => {
  test("defaults to chat", () => {
    expect(parseRoute("")).toEqual({ tab: "chat", threadId: null });
    expect(parseRoute("#/nope")).toEqual({ tab: "chat", threadId: null });
  });
  test("reads ids and the project filter", () => {
    expect(parseRoute("#/chat/t1")).toEqual({ tab: "chat", threadId: "t1" });
    expect(parseRoute("#/tasks/a%2Fb?project=%2Fx%2Fy")).toEqual({ tab: "tasks", taskId: "a/b", project: "/x/y" });
    expect(parseRoute(taskHref(null, "/Users/me/dev/me"))).toEqual({ tab: "tasks", taskId: null, project: "/Users/me/dev/me" });
    expect(parseRoute("#/ops")).toEqual({ tab: "ops" });
  });
  test("detail screens are deep", () => {
    expect(isDeep(parseRoute("#/chat/t1"))).toBe(true);
    expect(isDeep(parseRoute("#/tasks"))).toBe(false);
  });
});

describe("diff helpers", () => {
  test("parses --stat output", () => {
    const s = parseDiffStat(" src/a.ts   | 12 +++++++---\n img.png    | Bin 0 -> 120 bytes\n 2 files changed, 9 insertions(+), 3 deletions(-)\n");
    expect(s.files).toEqual([
      { path: "src/a.ts", changes: 12, plus: 7, minus: 3 },
      { path: "img.png", changes: null, plus: 0, minus: 0 },
    ]);
    expect(s.summary).toBe("2 files changed, 9 insertions(+), 3 deletions(-)");
  });
  test("splits a unified diff per file", () => {
    const d = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1,2 @@\n-a\n+b\n+c\ndiff --git a/y.md b/y.md\n+++ b/y.md\n+z\n";
    const files = splitDiff(d);
    expect(files.map((f) => [f.path, f.added, f.removed])).toEqual([
      ["x.ts", 2, 1],
      ["y.md", 1, 0],
    ]);
    expect(splitDiff("")).toEqual([]);
  });
});

describe("status tones", () => {
  test("maps task states to buckets", () => {
    expect(["sealed", "awaiting-input", "apply-failed", "awaiting-approval"].map(toneOf)).toEqual(["needs", "needs", "needs", "needs"]);
    expect(toneOf("running")).toBe("running");
    expect(toneOf("applied")).toBe("done");
    expect(toneOf("failed")).toBe("failed");
    expect(toneOf("rejected")).toBe("muted");
  });

  const state = (): State => {
    const at = "2026-10-11T00:00:00.000Z";
    let s = reducer(initial, {
      type: "bootstrap",
      data: {
        token: "t",
        viewer: null,
        threads: [{ id: "th", title: "x", project: "/p", createdAt: at, updatedAt: at }],
        messages: [
          { id: "m1", threadId: "th", role: "assistant", text: "", ts: at, traceId: "tr1", status: "done", taskId: "k1" },
          { id: "m2", threadId: "th", role: "assistant", text: "", ts: at, traceId: "tr2", status: "pending" },
        ],
        tasks: [{ taskId: "k1", harness: "local.codex", objective: "o", project: "/p", state: "applied", outcome: null, resultText: null, error: null, createdAt: at, updatedAt: at }],
        plugins: [],
        ops: [],
        checks: [],
        approvals: [{ approvalId: "a1", requester: "gjc-head", summary: "s", risk: "low", payload: { messageId: "m2", harness: "local.gjc", brief: "b", project: "/p" } }],
        config: { projects: [], defaultProject: "", githubRepo: null },
      },
    });
    return s;
  };

  test("a pending delegation approval is a Needs You work item and wins the thread's status", () => {
    const s = state();
    const items = workItems(s);
    expect(items.map((w) => [w.id, w.state])).toContainEqual(["approval:a1", "awaiting-approval"]);
    expect(threadTone(s, "th")).toBe("needs");
  });

  test("kernel.op entities land in state", () => {
    const s = reducer(state(), {
      type: "server",
      msg: { type: "entity", kind: "kernel.op", id: "o1", data: { opId: "o1", traceId: "tr2", callee: "gjc-head", state: "running", phaseLabel: "판정 중" } },
    });
    expect(s.ops.o1?.phaseLabel).toBe("판정 중");
  });
});
