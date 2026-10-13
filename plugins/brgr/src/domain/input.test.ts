import { describe, expect, test } from "bun:test";
import { kindFromBody, latestWorkerQuestion, optionsFromBody, parseMessages, questionFromMessage, questionFromStatus } from "./input.ts";

describe("worker questions", () => {
  test("parses message lists and prefers question kinds", () => {
    const msgs = parseMessages(JSON.stringify([{ id: "m1", kind: "note", from: "worker", body: "hi" }, { id: "m2", kind: "question", from: "worker", body: "계속할까요?" }]));
    expect(msgs).toHaveLength(2);
    expect(latestWorkerQuestion(msgs)?.id).toBe("m2");
  });

  test("falls back to the latest worker note when no question kind", () => {
    const msgs = parseMessages(JSON.stringify({ messages: [{ id: "m1", from: "worker", body: "이 값은?" }] }));
    expect(latestWorkerQuestion(msgs)?.body).toBe("이 값은?");
  });

  test("ignores owner messages and bad json", () => {
    expect(parseMessages("nope")).toEqual([]);
    const msgs = parseMessages(JSON.stringify([{ id: "o1", from: "owner", body: "ok" }]));
    expect(latestWorkerQuestion(msgs)).toBeNull();
  });

  test("menu options parse from numbered lines", () => {
    const body = "어느 것으로 할까요?\n1. 첫째\n2. 둘째";
    expect(optionsFromBody(body)).toEqual(["첫째", "둘째"]);
    expect(kindFromBody(body)).toBe("menu");
    expect(kindFromBody("그냥 물어봐요")).toBe("message");
    expect(optionsFromBody("한 줄")).toBeUndefined();
  });

  test("question from a message is redacted and capped", () => {
    const q = questionFromMessage({ id: "m9", body: "token=hunter2 계속할까요?", at: "2026-10-13T00:00:00.000Z" }, "2026-10-13T00:01:00.000Z")!;
    expect(q.text).not.toContain("hunter2");
    expect(q.kind).toBe("message");
  });

  test("question from status keeps a bounded tail", () => {
    const q = questionFromStatus(JSON.stringify({ task: { pane: "a\nb\n질문이에요" } }), "2026-10-13T00:00:00.000Z")!;
    expect(q.kind).toBe("screen");
    expect(q.text).toContain("질문이에요");
    expect(questionFromStatus("nope", "t")).toBeNull();
  });
});
