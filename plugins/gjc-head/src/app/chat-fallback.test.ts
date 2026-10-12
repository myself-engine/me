import { describe, expect, test } from "bun:test";
import type { HeadSettings, Message, Thread } from "../domain/types.ts";
import { createHead, type HeadPorts } from "./chat.ts";

const PRIMARY = "primary/model";
const FB = "fb/model";

function setup(opts: { script?: (Error | string)[]; fallbackModels?: string[]; cooldownSec?: number; clock?: () => number; warmError?: Error; harness?: "gjc" | "omp" } = {}) {
  let saved: HeadSettings | null = null;
  const tried: string[] = [];
  const triedHarness: string[] = [];
  const script = [...(opts.script ?? ["ok"])];
  const messages = new Map<string, Message>();
  const threads = new Map<string, Thread>();
  const alerts = new Map<string, any>();
  const updates: any[] = [];
  const cancels: string[] = [];
  const ports: HeadPorts = {
    brain: {
      reply: async (p) => {
        tried.push(p.model);
        triedHarness.push(p.harness);
        const next = script.shift();
        if (next instanceof Error) throw next;
        p.onUpdate({ kind: "text_delta", delta: typeof next === "string" ? next : "ok" });
        return { text: typeof next === "string" ? next : "ok", sessionId: "s1", violation: null };
      },
      prepare: opts.warmError
        ? () => ({
            reply: async () => {
              throw opts.warmError;
            },
            cancel: () => void cancels.push("cancel"),
          })
        : undefined,
    },
    normalizer: { normalize: async (text) => ({ normalized: text, replaced: [] }) },
    summarizer: { summarize: async () => { throw new Error("should not summarize"); } },
    judge: { judge: async () => ({ simpleProb: 1, confidence: 1, source: "t", model: "m" }) },
    approvals: { request: async () => { throw new Error("should not approve"); } },
    delegator: { delegate: async () => ({ taskId: "t1" }) },
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
    models: { list: async () => [] },
    events: { messageChanged: async () => {}, guardViolation: async () => {} },
  };
  const head = createHead(ports, {
    harnesses: ["local.codex"],
    harness: opts.harness ?? "gjc",
    simpleThreshold: 0.8,
    approvalExpiresSec: 60,
    defaultProject: "/p",
    model: PRIMARY,
    effort: "off",
    favoriteModels: [],
    workerModels: {},
    fallbackModels: opts.fallbackModels ?? [FB],
    cooldownSec: opts.cooldownSec ?? 600,
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  const turn = { update: (u: any) => updates.push(u), phase: () => {}, signal: new AbortController().signal, traceId: "tr" };
  return { head, turn, tried, triedHarness, messages, alerts, updates, cancels };
}

describe("model fallback", () => {
  test("an eligible failure retries the next model and records from/to/reason", async () => {
    const s = setup({ script: [new Error("gjc error: 429 rate limit exceeded"), "대체 답"] });
    const r = await s.head.send({ text: "안녕" }, s.turn);
    expect(r.status).toBe("done");
    expect(s.tried).toEqual([PRIMARY, FB]);
    const reply = s.messages.get(r.messageId)!;
    expect(reply.text).toBe("대체 답");
    expect(reply.fallback).toEqual({ from: "gjc:primary/model", to: "gjc:fb/model", reason: "quota" });
    expect(s.updates.find((u) => u.kind === "fallback")).toMatchObject({ from: "gjc:primary/model", to: "gjc:fb/model", reason: "quota" });
    // The primary is still broken: its alert stays so the user fixes it.
    expect(s.alerts.get("model-unavailable")).toMatchObject({ active: true });
  });

  test("a non-eligible failure never retries", async () => {
    const s = setup({ script: [new Error("aborted"), "unused"] });
    const r = await s.head.send({ text: "안녕" }, s.turn);
    expect(r.status).toBe("error");
    expect(s.tried).toEqual([PRIMARY]);
    expect(s.messages.get(r.messageId)!.fallback).toBeUndefined();
  });

  test("all models failing fails the message with the friendly error", async () => {
    const s = setup({ script: [new Error("429 too many requests"), new Error("provider 503 service unavailable")] });
    const r = await s.head.send({ text: "안녕" }, s.turn);
    expect(r.status).toBe("error");
    expect(s.tried).toEqual([PRIMARY, FB]);
    const reply = s.messages.get(r.messageId)!;
    expect(reply.fallback).toBeUndefined();
    expect(reply.error).toContain("기본 모델을 쓸 수 없어요");
    expect(s.alerts.get("model-unavailable")).toMatchObject({ active: true });
  });

  test("cooldown skips the primary until it expires", async () => {
    let at = 1_000_000;
    const s = setup({ clock: () => at, script: [new Error("429 too many requests"), "fb-1", "fb-2", "primary-again"] });
    const first = await s.head.send({ text: "안녕" }, s.turn);
    expect(s.messages.get(first.messageId)!.fallback).toMatchObject({ from: "gjc:primary/model", to: "gjc:fb/model" });
    const second = await s.head.send({ text: "안녕" }, s.turn);
    expect(s.tried).toEqual([PRIMARY, FB, FB]);
    expect(s.messages.get(second.messageId)!.fallback).toMatchObject({ from: "gjc:primary/model", to: "gjc:fb/model", reason: "cooldown" });
    at += 601_000;
    const third = await s.head.send({ text: "안녕" }, s.turn);
    expect(s.tried).toEqual([PRIMARY, FB, FB, PRIMARY]);
    expect(s.messages.get(third.messageId)!.fallback).toBeUndefined();
  });

  test("a failed warm brain still falls back without leaking the warm run", async () => {
    const s = setup({ script: ["warm-fallback-ok"], warmError: new Error("provider 503 service unavailable") });
    const r = await s.head.send({ text: "안녕" }, s.turn);
    expect(r.status).toBe("done");
    expect(s.tried).toEqual([FB]);
    expect(s.cancels).toEqual([]);
    expect(s.messages.get(r.messageId)!.fallback).toMatchObject({ from: "gjc:primary/model", to: "gjc:fb/model", reason: "provider-error" });
  });

  test("Anthropic fallbacks and bad cooldowns are refused before anything runs", async () => {
    const s = setup({ fallbackModels: [] });
    await expect(s.head.setDefaults({ fallbackModels: ["anthropic/claude-opus-5-5"] })).rejects.toThrow("Claude Code에서만");
    await expect(s.head.setDefaults({ fallbackModels: ["  "] })).rejects.toThrow("비어");
    await expect(s.head.setDefaults({ cooldownSec: -1 })).rejects.toThrow("cooldownSec");
    expect(s.tried).toEqual([]);
    await s.head.setDefaults({ fallbackModels: [FB], cooldownSec: 30 });
    expect(await s.head.settings()).toMatchObject({ fallbackModels: [FB], cooldownSec: 30 });
    await s.head.setDefaults({ fallbackModels: null, cooldownSec: null });
    expect(await s.head.settings()).toMatchObject({ fallbackModels: [], cooldownSec: 600 });
  });

  test("a GJC auth failure falls back to an OMP ref on the other harness", async () => {
    const s = setup({ script: [new Error("gjc error: provider login expired"), "omp 답"], fallbackModels: ["omp:fb/model"] });
    const r = await s.head.send({ text: "안녕" }, s.turn);
    expect(r.status).toBe("done");
    expect(s.tried).toEqual([PRIMARY, FB]);
    expect(s.triedHarness).toEqual(["gjc", "omp"]);
    expect(s.messages.get(r.messageId)!.fallback).toEqual({ from: "gjc:primary/model", to: "omp:fb/model", reason: "auth-expired" });
  });

  test("switching the default harness sends the next turn there", async () => {
    const s = setup({ script: ["gjc 답", "omp 답"], fallbackModels: [] });
    await s.head.send({ text: "안녕" }, s.turn);
    await s.head.setDefaults({ harness: "omp" });
    expect(await s.head.settings()).toMatchObject({ harness: "omp" });
    await s.head.send({ text: "안녕" }, s.turn);
    expect(s.triedHarness).toEqual(["gjc", "omp"]);
  });

  test("unknown harnesses and harness-qualified Anthropic models are refused", async () => {
    const s = setup({ fallbackModels: [] });
    await expect(s.head.setDefaults({ harness: "claude-code" as never })).rejects.toThrow("gjc, omp");
    await expect(s.head.setDefaults({ fallbackModels: ["omp:anthropic/claude-x"] })).rejects.toThrow("대화 엔진(OMP)");
    expect(s.tried).toEqual([]);
  });
});
