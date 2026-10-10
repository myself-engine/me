import { describe, expect, test } from "bun:test";
import type { Message, Summary, Thread } from "../domain/types.ts";
import type { ApprovalOutcome } from "../ports/index.ts";
import { createHead, type HeadPorts } from "./chat.ts";

function setup(opts: { summary?: Partial<Summary>; decision?: Omit<ApprovalOutcome, "approvalId"> } = {}) {
  const calls: Record<string, any[]> = { summarize: [], judge: [], approval: [], delegate: [], brain: [] };
  const messages = new Map<string, Message>();
  const threads = new Map<string, Thread>();
  const updates: any[] = [];
  const ports: HeadPorts = {
    brain: { reply: async (p) => (calls.brain!.push(p), p.onUpdate({ kind: "text_delta", delta: "안녕!" }), { text: "안녕!", sessionId: "s1", violation: null }) },
    normalizer: { normalize: async (text) => ({ normalized: text, replaced: [] }) },
    summarizer: {
      summarize: async (p) => (
        calls.summarize!.push(p),
        { summaryEn: "Fix the bug", brief: "Fix it", needsCodeChange: true, scope: "single-file", harness: "local.codex", harnessReason: "", criterion: "bun test passes.", ...opts.summary }
      ),
    },
    judge: { judge: async (p) => (calls.judge!.push(p), { simpleProb: 0.1, confidence: 0.9, source: "jev", model: "m" }) },
    approvals: { request: async (p) => (calls.approval!.push(p), { approvalId: "a1", ...(opts.decision ?? { decision: "approve" }) }) },
    delegator: { delegate: async (p) => (calls.delegate!.push(p), { taskId: "t1" }) },
    store: {
      registerKinds: async () => {},
      getThread: async (id) => threads.get(id) ?? null,
      saveThread: async (t) => void threads.set(t.id, structuredClone(t)),
      saveMessage: async (m) => void messages.set(m.id, structuredClone(m)),
      messagesByTask: async (taskId) => [...messages.values()].filter((m) => m.taskId === taskId),
    },
    events: { messageChanged: async () => {}, guardViolation: async () => {} },
  };
  const head = createHead(ports, { harnesses: ["local.claude-code", "local.codex"], simpleThreshold: 0.8, approvalExpiresSec: 60, defaultProject: "/p" });
  const turn = { update: (u: any) => updates.push(u), signal: new AbortController().signal, traceId: "tr" };
  return { head, turn, calls, messages, updates };
}

describe("chat.send", () => {
  test("short chat takes the fast path", async () => {
    const { head, turn, calls, updates } = setup();
    const r = await head.send({ text: "ㅎㅇ 잘 지내?" }, turn);
    expect(r.route).toBe("direct");
    expect(calls.summarize).toHaveLength(0);
    expect(calls.judge).toHaveLength(0);
    expect(updates.find((u) => u.kind === "judgement")).toMatchObject({ source: "fast-path", simpleProb: 1, route: "direct" });
  });

  test("delegation passes criterion and harness list, keeps suggestion without amend", async () => {
    const { head, turn, calls, messages } = setup();
    const r = await head.send({ text: "README 오타 고쳐줘" }, turn);
    expect(r.route).toBe("delegate");
    expect(calls.approval[0].payload).toMatchObject({ harness: "local.codex", harnesses: ["local.claude-code", "local.codex"] });
    expect(calls.delegate[0]).toMatchObject({ harness: "local.codex", criterion: "bun test passes." });
    expect(messages.get(r.messageId)!.delegation).toMatchObject({ harness: "local.codex", state: "delegated" });
  });

  test("amend.harness overrides the suggestion and is recorded", async () => {
    const { head, turn, calls, messages } = setup({ decision: { decision: "approve", amend: { harness: "local.claude-code" } } });
    const r = await head.send({ text: "README 오타 고쳐줘" }, turn);
    expect(calls.delegate[0].harness).toBe("local.claude-code");
    expect(messages.get(r.messageId)!.delegation).toMatchObject({ harness: "local.claude-code", suggestedHarness: "local.codex" });
  });

  test("rejected approval does not delegate", async () => {
    const { head, turn, calls } = setup({ decision: { decision: "reject" } });
    await head.send({ text: "README 오타 고쳐줘" }, turn);
    expect(calls.delegate).toHaveLength(0);
  });
});
