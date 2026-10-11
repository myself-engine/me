import { describe, expect, test } from "bun:test";
import type { HeadSettings, Message, Summary, Thread } from "../domain/types.ts";
import type { ApprovalOutcome } from "../ports/index.ts";
import { createHead, type HeadPorts } from "./chat.ts";

function setup(opts: { summary?: Partial<Summary>; decision?: Omit<ApprovalOutcome, "approvalId">; simpleProb?: number; warm?: boolean } = {}) {
  let saved: HeadSettings | null = null;
  const warmLog: string[] = [];
  const calls: Record<string, any[]> = { summarize: [], judge: [], approval: [], delegate: [], brain: [] };
  const messages = new Map<string, Message>();
  const threads = new Map<string, Thread>();
  const updates: any[] = [];
  const ports: HeadPorts = {
    brain: {
      reply: async (p) => (calls.brain!.push(p), p.onUpdate({ kind: "text_delta", delta: "안녕!" }), { text: "안녕!", sessionId: "s1", violation: null }),
      ...(opts.warm
        ? {
            prepare: () => (
              warmLog.push("prepare"),
              {
                reply: async (q: any) => (warmLog.push("reply"), q.onUpdate({ kind: "text_delta", delta: "따뜻!" }), { text: "따뜻!", sessionId: "s2", violation: null }),
                cancel: () => void warmLog.push("cancel"),
              }
            ),
          }
        : {}),
    },
    normalizer: { normalize: async (text) => ({ normalized: text, replaced: [] }) },
    summarizer: {
      summarize: async (p) => (
        calls.summarize!.push(p),
        { summaryEn: "Fix the bug", brief: "Fix it", needsCodeChange: true, scope: "single-file", harness: "local.codex", harnessReason: "", criterion: "bun test passes.", ...opts.summary }
      ),
    },
    judge: { judge: async (p) => (calls.judge!.push(p), { simpleProb: opts.simpleProb ?? 0.1, confidence: 0.9, source: "jev", model: "m" }) },
    approvals: { request: async (p) => (calls.approval!.push(p), { approvalId: "a1", ...(opts.decision ?? { decision: "approve" }) }) },
    delegator: { delegate: async (p) => (calls.delegate!.push(p), { taskId: "t1" }) },
    store: {
      registerKinds: async () => {},
      getThread: async (id) => threads.get(id) ?? null,
      saveThread: async (t) => void threads.set(t.id, structuredClone(t)),
      saveMessage: async (m) => void messages.set(m.id, structuredClone(m)),
      messagesByTask: async (taskId) => [...messages.values()].filter((m) => m.taskId === taskId),
      getSettings: async () => saved,
      saveSettings: async (s) => void (saved = structuredClone(s)),
    },
    models: { list: async () => [{ id: "openai-codex/gpt-6.1-sol", efforts: ["off", "low", "high"] }] },
    events: { messageChanged: async () => {}, guardViolation: async () => {} },
  };
  const head = createHead(ports, {
    harnesses: ["local.claude-code", "local.codex"],
    simpleThreshold: 0.8,
    approvalExpiresSec: 60,
    defaultProject: "/p",
    model: "openai-codex/gpt-5.6-luna",
    effort: "off",
    favoriteModels: ["openai-codex/gpt-6.1-sol"],
    workerModels: { "local.codex": ["gpt-6.1-sol"] },
  });
  const phases: string[] = [];
  const turn = { update: (u: any) => updates.push(u), phase: (ph: string) => void phases.push(ph), signal: new AbortController().signal, traceId: "tr" };
  return { head, turn, calls, messages, threads, updates, phases, warmLog };
}

describe("chat.send", () => {
  test("judges the normalized text first and never summarizes a direct answer", async () => {
    const long = "뮤텍스랑 세마포어 차이를 실제 예시 하나씩 들어서 두세 문장으로 비교 설명해 줄 수 있어?";
    const { head, turn, calls, updates } = setup({ simpleProb: 0.97 });
    const r = await head.send({ text: long }, turn);
    expect(r.route).toBe("direct");
    expect(calls.judge).toEqual([{ request: long }]);
    expect(calls.summarize).toHaveLength(0);
    expect(updates.some((u) => u.kind === "summary")).toBe(false);
  });

  test("a direct answer uses the brain started before judging", async () => {
    const { head, turn, calls, warmLog } = setup({ simpleProb: 0.97, warm: true });
    const r = await head.send({ text: "뮤텍스랑 세마포어 차이를 실제 예시 하나씩 들어서 두세 문장으로 비교 설명해 줄 수 있어?" }, turn);
    expect(r.route).toBe("direct");
    expect(warmLog).toEqual(["prepare", "reply"]);
    expect(calls.brain).toHaveLength(0);
  });

  test("a delegation cancels the early brain", async () => {
    const { head, turn, warmLog } = setup({ simpleProb: 0.05, warm: true });
    await head.send({ text: "gjc-head 플러그인에 타임아웃 설정 추가하고 테스트도 써 줘" }, turn);
    expect(warmLog).toEqual(["prepare", "cancel"]);
  });

  test("reports phases in order for a direct answer and for a delegation", async () => {
    const direct = setup({ simpleProb: 0.97 });
    await direct.head.send({ text: "뮤텍스랑 세마포어 차이를 실제 예시 하나씩 들어서 두세 문장으로 비교 설명해 줄 수 있어?" }, direct.turn);
    expect(direct.phases).toEqual(["understanding", "judging", "answering", "done"]);
    const del = setup({ simpleProb: 0.05 });
    await del.head.send({ text: "gjc-head 플러그인에 타임아웃 설정 추가하고 테스트도 써 줘" }, del.turn);
    expect(del.phases).toEqual(["understanding", "judging", "summarizing", "awaiting-approval", "delegating", "done"]);
  });

  test("summarizes only after a delegate judgement, then delegates with the brief", async () => {
    const { head, turn, calls, updates } = setup({ simpleProb: 0.05 });
    await head.send({ text: "gjc-head 플러그인에 타임아웃 설정 추가하고 테스트도 써 줘" }, turn);
    const kinds = updates.map((u) => u.kind);
    expect(kinds.indexOf("judgement")).toBeLessThan(kinds.indexOf("summary"));
    expect(calls.summarize).toHaveLength(1);
    expect(calls.delegate).toHaveLength(1);
  });

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

  test("worker model and effort from the approval reach brgr and the message", async () => {
    const { head, turn, calls, messages } = setup({ decision: { decision: "approve", amend: { harness: "local.codex", model: "gpt-6.1-sol", effort: "high" } } });
    const r = await head.send({ text: "README 오타 고쳐줘" }, turn);
    expect(calls.approval[0].payload.workers).toEqual({ models: { "local.codex": ["gpt-6.1-sol"] }, efforts: ["low", "medium", "high", "xhigh"] });
    expect(calls.delegate[0]).toMatchObject({ harness: "local.codex", model: "gpt-6.1-sol", effort: "high" });
    expect(messages.get(r.messageId)!.delegation).toMatchObject({ model: "gpt-6.1-sol", effort: "high" });
  });

  test("an Anthropic worker model outside Claude Code is refused", async () => {
    const { head, turn, calls, messages } = setup({ decision: { decision: "approve", amend: { harness: "local.codex", model: "claude-opus-5-5" } } });
    const r = await head.send({ text: "README 오타 고쳐줘" }, turn);
    expect(r.status).toBe("error");
    expect(calls.delegate).toHaveLength(0);
    expect(messages.get(r.messageId)!.error).toContain("Claude Code에서만");
  });
});

describe("model and effort", () => {
  const long = "뮤텍스랑 세마포어 차이를 실제 예시 하나씩 들어서 두세 문장으로 비교 설명해 줄 수 있어?";

  test("a thread replies with the defaults until it has its own choice", async () => {
    const { head, turn, calls, threads } = setup({ simpleProb: 0.97 });
    const r = await head.send({ text: long }, turn);
    expect(calls.brain[0]).toMatchObject({ model: "openai-codex/gpt-5.6-luna", effort: "off" });
    await head.send({ threadId: r.threadId, text: long, model: "openai-codex/gpt-6.1-sol", effort: "high" }, turn);
    expect(calls.brain[1]).toMatchObject({ model: "openai-codex/gpt-6.1-sol", effort: "high" });
    expect(threads.get(r.threadId)).toMatchObject({ model: "openai-codex/gpt-6.1-sol", effort: "high" });
    // The choice sticks to the thread without being sent again.
    await head.send({ threadId: r.threadId, text: long }, turn);
    expect(calls.brain[2]).toMatchObject({ model: "openai-codex/gpt-6.1-sol", effort: "high" });
  });

  test("changing the defaults moves threads without their own choice, and null clears a thread's choice", async () => {
    const { head, turn, calls } = setup({ simpleProb: 0.97 });
    const a = await head.send({ text: long, effort: "low" }, turn);
    await head.setDefaults({ model: "openai-codex/gpt-6-luna", effort: "medium" });
    expect((await head.settings()).model).toBe("openai-codex/gpt-6-luna");
    await head.send({ threadId: a.threadId, text: long }, turn);
    expect(calls.brain[1]).toMatchObject({ model: "openai-codex/gpt-6-luna", effort: "low" });
    await head.setThread({ threadId: a.threadId, effort: null });
    await head.send({ threadId: a.threadId, text: long }, turn);
    expect(calls.brain[2]).toMatchObject({ effort: "medium" });
  });

  test("the warm brain starts with the thread's choice", async () => {
    const { head, turn, warmLog } = setup({ simpleProb: 0.97, warm: true });
    await head.send({ text: long, model: "openai-codex/gpt-6.1-sol" }, turn);
    expect(warmLog).toEqual(["prepare", "reply"]);
  });

  test("Anthropic models and unknown efforts are refused before anything runs", async () => {
    const { head, turn, calls } = setup();
    await expect(head.send({ text: "ㅎㅇ", model: "anthropic/claude-opus-5-5" }, turn)).rejects.toThrow("Claude Code에서만");
    await expect(head.setDefaults({ effort: "turbo" as never })).rejects.toThrow("effort");
    expect(calls.brain).toHaveLength(0);
  });

  test("settings carry the config's favourites and worker choices", async () => {
    const { head } = setup();
    expect(await head.settings()).toMatchObject({
      model: "openai-codex/gpt-5.6-luna",
      effort: "off",
      favorites: ["openai-codex/gpt-6.1-sol", "openai-codex/gpt-5.6-luna"],
      workers: { models: { "local.codex": ["gpt-6.1-sol"] } },
    });
  });
});
