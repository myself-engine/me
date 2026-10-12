import { describe, expect, test } from "bun:test";
import { diffTotals, parseDiffStat, splitDiff } from "./diff.ts";
import { fenceLanguage, highlight } from "./highlight.ts";
import { isDeep, parseRoute, taskHref } from "./routes.ts";
import { headChoice, initial, reducer, shortModel, taskTitle, threadTone, toneOf, workItems, type State } from "./state.ts";

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
    // Old tabs: approvals moved into 작업 (and the thread), projects into 상태.
    expect(parseRoute("#/approvals")).toEqual({ tab: "tasks", taskId: null, project: null });
    expect(parseRoute("#/projects")).toEqual({ tab: "ops" });
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
    expect(diffTotals(s)).toEqual({ files: 2, added: 9, removed: 3 });
    expect(diffTotals(parseDiffStat(" a.md | 1 +\n 1 file changed, 1 insertion(+)\n"))).toEqual({ files: 1, added: 1, removed: 0 });
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
    // Accepting starts the apply; only a landed commit counts as done.
    expect(toneOf("accepted")).toBe("running");
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

  test("a failed task shows on the thread, a rejected one stays quiet", () => {
    const base = state();
    const s: State = { ...base, approvals: {}, tasks: { k1: { ...base.tasks.k1!, state: "failed" } } };
    // The other turn is still pending, and running outranks a failure.
    expect(threadTone(s, "th")).toBe("running");
    const settled: State = { ...s, messages: { m1: s.messages.m1! } };
    expect(threadTone(settled, "th")).toBe("failed");
    expect(threadTone({ ...settled, tasks: { k1: { ...base.tasks.k1!, state: "rejected" } } }, "th")).toBe("none");
  });

  test("work titles use the user's own words, falling back to the brief", () => {
    const base = state();
    const user = { id: "u1", threadId: "th", role: "user" as const, text: "README에 설치 방법 섹션을 추가하고 커밋해 줘", ts: "2026-01-01T00:00:00.000Z", traceId: "tr1", status: "done" as const };
    const s: State = { ...base, messages: { ...base.messages, u1: user } };
    expect(taskTitle(s, { taskId: "k1", objective: "Add an install section" })).toBe("README에 설치 방법 섹션을 추가하고 커밋해 줘");
    expect(taskTitle(s, { taskId: "nope", objective: "Add an install section\nmore" })).toBe("Add an install section");
    expect(workItems(s).find((w) => w.id === "approval:a1")?.title).toBe("README에 설치 방법 섹션을 추가하고 커밋해 줘");
  });

  test("kernel.op entities land in state", () => {
    const s = reducer(state(), {
      type: "server",
      msg: { type: "entity", kind: "kernel.op", id: "o1", data: { opId: "o1", traceId: "tr2", callee: "gjc-head", state: "running", phaseLabel: "판정 중" } },
    });
    expect(s.ops.o1?.phaseLabel).toBe("판정 중");
  });
});

describe("highlight", () => {
  test("reads the fence language from the class", () => {
    expect(fenceLanguage("language-ts")).toBe("ts");
    expect(fenceLanguage("foo language-Diff")).toBe("diff");
    expect(fenceLanguage(undefined)).toBeNull();
    expect(fenceLanguage("hljs")).toBeNull();
  });
  test("highlights registered languages and their aliases", () => {
    for (const lang of ["ts", "typescript", "js", "json", "bash", "sh", "diff", "python", "py", "go", "rust", "css", "html", "xml", "md", "yaml", "yml", "sql"])
      expect(highlight("x", lang), lang).not.toBeNull();
    expect(highlight("+hello\n-bye", "diff")).toContain('class="hljs-addition"');
  });
  test("returns null for unknown or missing languages instead of throwing", () => {
    expect(highlight("x", "cobol")).toBeNull();
    expect(highlight("x", null)).toBeNull();
  });
  test("escapes the source", () => {
    expect(highlight("<img src=x onerror=alert(1)>", "html")).not.toContain("<img");
  });
});

describe("head choice", () => {
  const d = { model: "openai-codex/gpt-5.6-luna", effort: "off" as const, favorites: [], efforts: [], workers: { models: {}, efforts: [] } };
  test("follows the defaults until a thread has its own choice", () => {
    expect(headChoice({}, d)).toEqual({ model: d.model, effort: "off", isDefault: true });
    expect(headChoice({ model: null, effort: "high" }, d)).toEqual({ model: d.model, effort: "high", isDefault: false });
    expect(headChoice({}, null)).toBeNull();
  });
  test("settings entities land in state and chips drop the provider", () => {
    const s = reducer(initial, { type: "server", msg: { type: "entity", kind: "gjc-head.settings", id: "default", data: d } });
    expect(s.headSettings?.model).toBe(d.model);
    expect(shortModel("openai-codex/gpt-6.1-sol")).toBe("gpt-6.1-sol");
    expect(shortModel("bare")).toBe("bare");
  });
});
