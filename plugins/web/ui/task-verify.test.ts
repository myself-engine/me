import { describe, expect, test } from "bun:test";
import { queueAhead, queueLabel, verifyLabel, verifyOf, verifyTone, type VerifyResult } from "./tasks.tsx";
import { threadWait, toneOf, type State } from "./state.ts";
import { initial } from "./state.ts";
import type { Task } from "./api.ts";

const task = (over: Partial<Task>): Task => ({
  taskId: "t1",
  harness: "local.codex",
  objective: "do it",
  project: "/repo",
  state: "queued",
  outcome: null,
  resultText: null,
  error: null,
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
  ...over,
});

const verify = (over: Partial<VerifyResult>): VerifyResult => ({ state: "passed", commands: [], ...over });

describe("verify panel helpers", () => {
  test("labels read 검사 통과 / 검사 실패 · <cmd> / 검사 없음 / 검사 오류", () => {
    expect(verifyLabel(verify({ state: "passed" }))).toBe("검사 통과");
    expect(verifyLabel(verify({ state: "skipped" }))).toBe("검사 없음");
    expect(verifyLabel(verify({ state: "error" }))).toBe("검사 오류");
    expect(
      verifyLabel(verify({ state: "failed", commands: [{ cmd: "bun test", exitCode: 1, ms: 3, tail: "boom" }] })),
    ).toBe("검사 실패 · bun test");
  });

  test("tones are done / failed / muted", () => {
    expect(verifyTone(verify({ state: "passed" }))).toBe("done");
    expect(verifyTone(verify({ state: "failed" }))).toBe("failed");
    expect(verifyTone(verify({ state: "error" }))).toBe("failed");
    expect(verifyTone(verify({ state: "skipped" }))).toBe("muted");
  });

  test("tasks without a gate result show nothing", () => {
    expect(verifyOf(task({}))).toBeNull();
    expect(verifyOf(task({ verify: verify({ state: "passed" }) } as unknown as Partial<Task>))).toEqual({
      state: "passed",
      commands: [],
    });
  });
});

describe("queue panel helpers", () => {
  test("queued work spins; the label counts only earlier queued tasks", () => {
    expect(toneOf("queued")).toBe("running");
    expect(queueLabel(0)).toBe("대기 중");
    expect(queueLabel(2)).toBe("대기 중 · 앞에 2개");
    const tasks: Record<string, Task> = {
      a: task({ taskId: "a", state: "queued", createdAt: "2026-10-10T00:00:01.000Z" }),
      b: task({ taskId: "b", state: "queued", createdAt: "2026-10-10T00:00:02.000Z" }),
      c: task({ taskId: "c", state: "running", createdAt: "2026-10-10T00:00:03.000Z" }),
      d: task({ taskId: "d", state: "queued", createdAt: "2026-10-10T00:00:04.000Z" }),
    };
    expect(queueAhead(tasks, tasks.b!)).toBe(1);
    expect(queueAhead(tasks, tasks.d!)).toBe(2);
    expect(queueAhead(tasks, tasks.a!)).toBe(0);
  });

  test("a queued task keeps its thread in 답변", () => {
    const day = "2026-10-10T00:00:00.000Z";
    const s: State = {
      ...initial,
      threads: { th: { id: "th", title: "t", project: "/p", createdAt: day, updatedAt: day } },
      messages: {
        m1: { id: "m1", threadId: "th", role: "assistant", text: "맡겼어요", ts: day, traceId: "tr", status: "done", taskId: "q" },
      },
      tasks: { q: task({ taskId: "q", state: "queued" }) },
    };
    expect(threadWait(s, "th")).toBe("답변");
  });
});
