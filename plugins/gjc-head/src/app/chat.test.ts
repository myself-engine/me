import { describe, expect, test } from "bun:test";
import type { HeadSettings, Message, Summary, Thread } from "../domain/types.ts";
import type { ApprovalOutcome } from "../ports/index.ts";
import { createHead, type HeadPorts } from "./chat.ts";

function setup(opts: { summary?: Partial<Summary>; decision?: Omit<ApprovalOutcome, "approvalId">; simpleProb?: number; warm?: boolean; brainError?: string; delegateError?: string; clarify?: boolean } = {}) {
  let saved: HeadSettings | null = null;
  const warmLog: string[] = [];
  const calls: Record<string, any[]> = { summarize: [], judge: [], approval: [], delegate: [], brain: [] };
  const messages = new Map<string, Message>();
  const threads = new Map<string, Thread>();
  const alerts = new Map<string, any>();
  const updates: any[] = [];
  const ports: HeadPorts = {
    brain: {
      reply: async (p) => {
        calls.brain!.push(p);
        if (opts.brainError && calls.brain!.length === 1) throw new Error(opts.brainError);
        p.onUpdate({ kind: "text_delta", delta: "안녕!" });
        return { text: "안녕!", sessionId: "s1", violation: null };
      },
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
        { summaryEn: "Fix the bug", brief: "Fix it", needsCodeChange: true, scope: "single-file", harness: "local.codex", harnessReason: "", criterion: "bun test passes.", commitSubject: "Fix the bug", ambiguous: false, questions: [], ...opts.summary }
      ),
    },
    judge: { judge: async (p) => (calls.judge!.push(p), { simpleProb: opts.simpleProb ?? 0.1, confidence: 0.9, source: "jev", model: "m" }) },
    approvals: { request: async (p) => (calls.approval!.push(p), { approvalId: "a1", ...(opts.decision ?? { decision: "approve" }) }) },
    delegator: {
      delegate: async (p) => {
        calls.delegate!.push(p);
        if (opts.delegateError && calls.delegate!.length === 1) throw new Error(opts.delegateError);
        return { taskId: "t1" };
      },
    },
    store: {
      registerKinds: async () => {},
      getThread: async (id) => threads.get(id) ?? null,
      saveThread: async (t) => void threads.set(t.id, structuredClone(t)),
      saveMessage: async (m) => void messages.set(m.id, structuredClone(m)),
      messagesByTask: async (taskId) => [...messages.values()].filter((m) => m.taskId === taskId),
      getSettings: async () => saved,
      saveSettings: async (s) => void (saved = structuredClone(s)),
      listAlerts: async () => [...alerts.values()],
      saveAlert: async (a) => void alerts.set(a.id, structuredClone(a)),
      clearAlert: async (cause) => {
        const cur = alerts.get(cause);
        if (cur?.active) alerts.set(cause, { ...cur, active: false });
      },
    },
    models: { list: async () => [{ id: "openai-codex/gpt-6.1-sol", efforts: ["off", "low", "high"] }] },
    events: { messageChanged: async () => {}, guardViolation: async () => {} },
  };
  const head = createHead(ports, {
    harnesses: ["local.claude-code", "local.codex"],
    simpleThreshold: 0.8,
    approvalExpiresSec: 60,
    clarify: opts.clarify,
    defaultProject: "/p",
    model: "openai-codex/gpt-5.6-luna",
    effort: "off",
    favoriteModels: ["openai-codex/gpt-6.1-sol"],
    workerModels: { "local.codex": ["gpt-6.1-sol"] },
  });
  const phases: string[] = [];
  const turn = { update: (u: any) => updates.push(u), phase: (ph: string) => void phases.push(ph), signal: new AbortController().signal, traceId: "tr" };
  return { head, turn, calls, messages, threads, alerts, updates, phases, warmLog };
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
    expect(del.phases).toEqual(["understanding", "judging", "summarizing", "delegating", "done"]);
  });

  test("summarizes only after a delegate judgement, then delegates with the brief", async () => {
    const { head, turn, calls, updates } = setup({ simpleProb: 0.05 });
    await head.send({ text: "gjc-head 플러그인에 타임아웃 설정 추가하고 테스트도 써 줘" }, turn);
    const kinds = updates.map((u) => u.kind);
    expect(kinds.indexOf("judgement")).toBeLessThan(kinds.indexOf("summary"));
    expect(calls.summarize).toHaveLength(1);
    expect(calls.delegate).toHaveLength(1);
  });

  test("an ambiguous delegate request asks once and delegates with the user's next message", async () => {
    const s = setup({ summary: { ambiguous: true, questions: [{ q: "어느 범위를 고칠까요?", options: ["로그인 화면", "가입 화면"] }] } });
    const first = await s.head.send({ text: "gjc-head 로그인 흐름 파일을 정리하고 테스트도 써 줘" }, s.turn);
    expect(first.status).toBe("done");
    expect(s.calls.summarize).toHaveLength(1);
    expect(s.calls.delegate).toHaveLength(0);
    expect(s.messages.get(first.messageId)?.text).toContain("1. 어느 범위를 고칠까요?");
    expect(s.messages.get(first.messageId)?.text).toContain("(추천)");
    const second = await s.head.send({ threadId: first.threadId, text: "가입 화면으로 해줘" }, s.turn);
    expect(second.status).toBe("done");
    expect(s.calls.summarize).toHaveLength(1);
    expect(s.calls.delegate).toHaveLength(1);
    expect(s.calls.delegate[0].request).toContain("gjc-head 로그인 흐름 파일을 정리하고 테스트도 써 줘");
    expect(s.calls.delegate[0].request).toContain("사용자 보충 답변: 가입 화면으로 해줘");
    expect(s.calls.delegate[0].objective).toContain("User clarification: 가입 화면으로 해줘");
    expect(s.threads.get(first.threadId)?.pendingClarification).toBeUndefined();
  });

  test("clarification can be disabled and does not affect direct or read-only answers", async () => {
    const disabled = setup({ clarify: false, summary: { ambiguous: true, questions: [{ q: "어느 쪽인가요?", options: ["A", "B"] }] } });
    await disabled.head.send({ text: "코드 변경해 줘" }, disabled.turn);
    expect(disabled.calls.delegate).toHaveLength(1);

    const direct = setup({ simpleProb: 0.97, summary: { ambiguous: true, questions: [{ q: "어느 쪽인가요?", options: ["A", "B"] }] } });
    await direct.head.send({ text: "설명해 줘" }, direct.turn);
    expect(direct.calls.summarize).toHaveLength(0);

    const readOnly = setup({ summary: { ambiguous: true, questions: [{ q: "어느 쪽인가요?", options: ["A", "B"] }] } });
    await readOnly.head.setDefaults({ access: "read" });
    const result = await readOnly.head.send({ text: "gjc-head 플러그인에 타임아웃 설정 추가하고 테스트도 써 줘" }, readOnly.turn);
    expect(result.route).toBe("direct");
    expect(readOnly.calls.summarize).toHaveLength(0);
    expect(readOnly.calls.delegate).toHaveLength(0);
  });

  test("chat.send uses title only when it creates the thread", async () => {
    const s = setup({ simpleProb: 0.97 });
    const first = await s.head.send({ text: "일정 브리핑", title: "⏱ 아침 일정" }, s.turn);
    expect(s.threads.get(first.threadId)?.title).toBe("⏱ 아침 일정");
    await s.head.send({ threadId: first.threadId, text: "다시 실행", title: "다른 제목" }, s.turn);
    expect(s.threads.get(first.threadId)?.title).toBe("⏱ 아침 일정");
  });

  test("chat.thread.set rejects a missing id before reading an entity", async () => {
    const s = setup();
    await expect(s.head.setThread({} as never)).rejects.toThrow("threadId is required");
  });

  test("short chat takes the fast path", async () => {
    const { head, turn, calls, updates } = setup();
    const r = await head.send({ text: "ㅎㅇ 잘 지내?" }, turn);
    expect(r.route).toBe("direct");
    expect(calls.summarize).toHaveLength(0);
    expect(calls.judge).toHaveLength(0);
    expect(updates.find((u) => u.kind === "judgement")).toMatchObject({ source: "fast-path", simpleProb: 1, route: "direct" });
  });

  test("project mode delegates at once: no approval, suggested harness, audit trail", async () => {
    const { head, turn, calls, messages, updates } = setup();
    const r = await head.send({ text: "README 오타 고쳐줘" }, turn);
    expect(r.route).toBe("delegate");
    expect(calls.approval).toHaveLength(0);
    expect(calls.delegate[0]).toMatchObject({ harness: "local.codex", criterion: "bun test passes.", commitSubject: "Fix the bug", request: "README 오타 고쳐줘" });
    expect(calls.delegate[0].autoApply).toBeUndefined();
    expect(calls.delegate[0]).not.toHaveProperty("model");
    expect(calls.delegate[0]).not.toHaveProperty("effort");
    expect(messages.get(r.messageId)!.delegation).toMatchObject({ harness: "local.codex", state: "delegated", approvedBy: "mode:project" });
    expect(updates.find((u) => u.kind === "delegation" && u.state === "delegated")).toMatchObject({ approvedBy: "mode:project", harness: "local.codex" });
  });

  test("auto modes use the suggested harness and the harness defaults, never an amend", async () => {
    const { head, turn, calls, messages } = setup();
    const r = await head.send({ text: "README 오타 고쳐줘" }, turn);
    expect(calls.delegate[0].harness).toBe("local.codex");
    expect(messages.get(r.messageId)!.delegation).toMatchObject({ harness: "local.codex" });
    expect(messages.get(r.messageId)!.delegation!.suggestedHarness).toBeUndefined();
  });

  test("a missing commitSubject delegates without it, but the request still travels", async () => {
    const { head, turn, calls } = setup({ summary: { commitSubject: "" } });
    await head.send({ text: "README 오타 고쳐줘" }, turn);
    expect(calls.delegate[0]).toMatchObject({ request: "README 오타 고쳐줘" });
    expect(calls.delegate[0]).not.toHaveProperty("commitSubject");
  });

  test("project mode never asks for an approval", async () => {
    const { head, turn, calls } = setup();
    await head.send({ text: "README 오타 고쳐줘" }, turn);
    expect(calls.approval).toHaveLength(0);
    expect(calls.delegate).toHaveLength(1);
  });

  test("full mode delegates with autoApply and records it", async () => {
    const { head, turn, calls, messages } = setup();
    await head.setDefaults({ access: "full", confirm: true });
    const r = await head.send({ text: "README 오타 고쳐줘" }, turn);
    expect(calls.approval).toHaveLength(0);
    expect(calls.delegate[0]).toMatchObject({ harness: "local.codex", autoApply: true });
    expect(messages.get(r.messageId)!.delegation).toMatchObject({ state: "delegated", approvedBy: "mode:full" });
  });

  test("read mode never delegates: a delegate verdict becomes a read-only reply", async () => {
    const { head, turn, calls, messages, updates } = setup();
    await head.setDefaults({ access: "read" });
    const r = await head.send({ text: "README 오타 고쳐줘" }, turn);
    expect(r.route).toBe("direct");
    expect(r.status).toBe("done");
    expect(calls.summarize).toHaveLength(0);
    expect(calls.approval).toHaveLength(0);
    expect(calls.delegate).toHaveLength(0);
    expect(calls.brain).toHaveLength(0);
    const reply = messages.get(r.messageId)!;
    expect(reply.text).toContain("읽기 전용");
    expect(reply.text).toContain("입력창 옆의 모드");
    expect(reply.delegation).toBeUndefined();
    expect(updates.find((u) => u.kind === "access")).toMatchObject({ mode: "read", delegated: false });
  });

  test("read mode still answers simple chat through the brain", async () => {
    const { head, turn, calls } = setup({ simpleProb: 0.97 });
    await head.setDefaults({ access: "read" });
    const r = await head.send({ text: "뮤텍스랑 세마포어 차이를 실제 예시 하나씩 들어서 두세 문장으로 비교 설명해 줄 수 있어?" }, turn);
    expect(r.route).toBe("direct");
    expect(calls.brain).toHaveLength(1);
  });

  test("a Herdr pane refusal records an alert and a retry clears it", async () => {
    const s = setup({ delegateError: "커널이 에이전트 없는 Herdr pane에서 실행돼야 brgr로 위임할 수 있어요" });
    const failed = await s.head.send({ text: "README 오타 고쳐줘" }, s.turn);
    expect(failed.status).toBe("error");
    expect(s.messages.get(failed.messageId)!.error).toContain("터미널에서 me를 실행");
    expect(s.alerts.get("herdr-pane")).toMatchObject({ active: true });
    const ok = await s.head.send({ text: "README 오타 고쳐줘" }, s.turn);
    expect(ok.status).toBe("done");
    expect(s.alerts.get("herdr-pane").active).toBe(false);
  });

  test("a GJC login expiry records an alert and a direct reply clears it", async () => {
    const s = setup({ simpleProb: 0.97, brainError: "gjc error: provider login expired (openai)" });
    const failed = await s.head.send({ text: "뮤텍스랑 세마포어 차이를 실제 예시 하나씩 들어서 두세 문장으로 비교 설명해 줄 수 있어?" }, s.turn);
    expect(failed.status).toBe("error");
    expect(s.messages.get(failed.messageId)!.error).toContain("GJC의 OpenAI 로그인이 만료됐어요 · 터미널에서 gjc 실행 후 /login");
    expect(s.alerts.get("gjc-login")).toMatchObject({ active: true });
    const ok = await s.head.send({ text: "뮤텍스랑 세마포어 차이를 실제 예시 하나씩 들어서 두세 문장으로 비교 설명해 줄 수 있어?" }, s.turn);
    expect(ok.status).toBe("done");
    expect(s.alerts.get("gjc-login").active).toBe(false);
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
      access: "project",
      favorites: ["openai-codex/gpt-6.1-sol", "openai-codex/gpt-5.6-luna"],
      userFavorites: [],
      configFavorites: ["openai-codex/gpt-6.1-sol"],
      workers: { models: { "local.codex": ["gpt-6.1-sol"] } },
    });
  });

  test("starring a model persists it into favourites and un starring removes it", async () => {
    const { head } = setup();
    await head.setFavorite({ model: "workbuddy/kimi-k3", on: true });
    expect((await head.settings()).favorites).toEqual(["openai-codex/gpt-6.1-sol", "workbuddy/kimi-k3", "openai-codex/gpt-5.6-luna"]);
    await head.setFavorite({ model: "workbuddy/kimi-k3", on: false });
    expect(await head.settings()).toMatchObject({
      favorites: ["openai-codex/gpt-6.1-sol", "openai-codex/gpt-5.6-luna"],
      userFavorites: [],
    });
  });

  test("un starring a config favourite keeps it, and Anthropic models are refused", async () => {
    const { head } = setup();
    await head.setFavorite({ model: "openai-codex/gpt-6.1-sol", on: false });
    expect((await head.settings()).favorites).toContain("openai-codex/gpt-6.1-sol");
    await expect(head.setFavorite({ model: "anthropic/claude-opus-5-5", on: true })).rejects.toThrow("Claude Code에서만");
    await expect(head.setFavorite({ model: "  ", on: true })).rejects.toThrow("비어");
  });
});

describe("access mode", () => {
  test("full needs an explicit confirm on every entry point", async () => {
    const { head, turn, calls } = setup();
    await expect(head.setDefaults({ access: "full" })).rejects.toThrow("확인");
    await expect(head.send({ text: "README 오타 고쳐줘", access: "full" }, turn)).rejects.toThrow("확인");
    expect(calls.delegate).toHaveLength(0);
    const r = await head.send({ text: "README 오타 고쳐줘" }, turn);
    await expect(head.setThread({ threadId: r.threadId, access: "full" })).rejects.toThrow("확인");
    await head.setDefaults({ access: "full", confirm: true });
    expect((await head.settings()).access).toBe("full");
  });

  test("unknown modes are refused before anything runs", async () => {
    const { head, turn, calls } = setup();
    await expect(head.setDefaults({ access: "admin" as never })).rejects.toThrow("모드");
    await expect(head.send({ text: "ㅎㅇ", access: "admin" as never }, turn)).rejects.toThrow("모드");
    expect(calls.brain).toHaveLength(0);
    expect(calls.delegate).toHaveLength(0);
  });

  test("a new thread takes the default, or the access sent with it", async () => {
    const { head, turn, threads } = setup();
    const a = await head.send({ text: "README 오타 고쳐줘" }, turn);
    expect(threads.get(a.threadId)).toMatchObject({ access: "project" });
    const b = await head.send({ text: "README 오타 고쳐줘", access: "read" }, turn);
    expect(threads.get(b.threadId)).toMatchObject({ access: "read" });
  });

  test("an existing thread keeps its mode when chat.send carries another one", async () => {
    const { head, turn, threads, updates } = setup();
    const a = await head.send({ text: "README 오타 고쳐줘", access: "read" }, turn);
    await head.send({ threadId: a.threadId, text: "README 오타 고쳐줘", access: "project" }, turn);
    expect(threads.get(a.threadId)).toMatchObject({ access: "read" });
    expect(updates.filter((u) => u.kind === "access").find((u) => u.kept)).toMatchObject({ mode: "read", kept: true });
  });

  test("setThread switches a thread's mode, null clears it back to the default", async () => {
    const { head, turn, calls, threads } = setup();
    const a = await head.send({ text: "README 오타 고쳐줘" }, turn);
    expect(calls.delegate).toHaveLength(1);
    await head.setThread({ threadId: a.threadId, access: "read" });
    expect(threads.get(a.threadId)).toMatchObject({ access: "read" });
    await head.send({ threadId: a.threadId, text: "README 오타 고쳐줘" }, turn);
    expect(calls.delegate).toHaveLength(1);
    await head.setThread({ threadId: a.threadId, access: null });
    await head.send({ threadId: a.threadId, text: "README 오타 고쳐줘" }, turn);
    expect(calls.delegate).toHaveLength(2);
  });
});
