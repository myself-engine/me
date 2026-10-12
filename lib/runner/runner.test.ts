// Tests for the shared GJC/OMP runner: the event stream carries the same
// envelope on both harnesses (fixture: one real `omp -p --mode json` call,
// signature blobs trimmed), the tool guard aborts on either, and both refuse
// Anthropic models.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assertAllowedModel, feedRunnerEvent, gjcArgv, ompArgv, parseGjcModelList, parseOmpModelList, type RunnerUpdate } from "./index.ts";

function feed(lines: unknown[], allow: string[] = []) {
  const s = { text: "", sessionId: null as string | null, stopReason: null as string | null, errorMessage: null as string | null, violation: null as { toolName: string; args?: unknown } | null };
  const updates: RunnerUpdate[] = [];
  let killed = 0;
  for (const e of lines) feedRunnerEvent(e, s, { allow, onUpdate: (u) => updates.push(u), kill: () => killed++ });
  return { s, updates, killed };
}

describe("omp fixture", () => {
  test("a real say-ok stream maps to one text delta and the final text", async () => {
    const lines = (await Bun.file(join(import.meta.dir, "fixtures", "omp-say-ok.jsonl")).text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThan(5);
    const { s, updates, killed } = feed(lines);
    expect(killed).toBe(0);
    expect(s.violation).toBeNull();
    expect(s.sessionId).toBeString();
    expect(s.stopReason).toBe("stop");
    expect(s.text).toBe("ok");
    expect(updates.filter((u) => u.kind === "text_delta").map((u) => (u as { delta: string }).delta).join("")).toBe("ok");
  });
});

describe("event mapping", () => {
  test("thinking deltas become thought deltas, tool events pass through", () => {
    const { updates, s } = feed(
      [
        { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } },
        { type: "tool_execution_start", toolCallId: "c1", toolName: "read", intent: "reading", args: { path: "a" } },
        { type: "tool_execution_end", toolCallId: "c1", toolName: "read" },
        { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } },
      ],
      ["read"],
    );
    expect(updates).toEqual([
      { kind: "thought_delta", delta: "hmm" },
      { kind: "tool_call", toolCallId: "c1", toolName: "read", intent: "reading", args: { path: "a" } },
      { kind: "tool_result", toolCallId: "c1", toolName: "read", ok: true },
    ]);
    expect(s.text).toBe("done");
  });

  test("a tool outside the whitelist aborts the run on either harness", () => {
    for (const toolName of ["read", "bash", "write"]) {
      const { s, killed } = feed([{ type: "tool_execution_start", toolCallId: "c1", toolName, args: {} }], []);
      expect(s.violation).toMatchObject({ toolName });
      expect(killed).toBe(1);
    }
  });

  test("non-assistant message_end lines never become reply text", () => {
    const { s } = feed([{ type: "message_end", message: { role: "user", content: [{ type: "text", text: "say ok" }] } }]);
    expect(s.text).toBe("");
    expect(s.stopReason).toBeNull();
  });
});

describe("argv", () => {
  const base = { model: "openai-codex/gpt-5.6-luna", cwd: "/tmp/me-runner-test" };
  test("gjc keeps --no-mcp and no tools by default", () => {
    const a = gjcArgv(base);
    expect(a[0]).toBe("gjc");
    expect(a).toContain("--no-mcp");
    expect(a).toContain("--no-tools");
    expect(a).not.toContain("--tools");
  });
  test("omp has no --no-mcp: --no-extensions --no-skills plus an explicit whitelist instead", () => {
    const a = ompArgv(base);
    expect(a[0]).toBe("omp");
    expect(a).not.toContain("--no-mcp");
    expect(a).toContain("--no-extensions");
    expect(a).toContain("--no-skills");
    expect(a).toContain("--no-tools");
    expect(ompArgv({ ...base, allowTools: ["read"] })).toContain("read");
  });
});

describe("models", () => {
  test("omp models --json parses, dedupes, and drops Anthropic models", () => {
    const out = parseOmpModelList({
      models: [
        { provider: "openai-codex", id: "gpt-5.6-luna", selector: "openai-codex/gpt-5.6-luna", thinking: ["low", "medium", "high"] },
        { provider: "openai-codex", id: "gpt-5.6-luna", selector: "openai-codex/gpt-5.6-luna", thinking: ["low"] },
        { provider: "commandcode", id: "claude-opus-5-5", selector: "commandcode/claude-opus-5-5", thinking: ["low"] },
        { provider: "anthropic", id: "claude-x", thinking: null },
        { provider: "opencode-go", id: "deepseek-v4.1-flash", thinking: null },
        "junk",
      ],
    });
    expect(out).toEqual([
      { id: "openai-codex/gpt-5.6-luna", efforts: ["off", "low", "medium", "high"] },
      { id: "opencode-go/deepseek-v4.1-flash", efforts: ["off"] },
    ]);
  });
  test("garbage omp output lists nothing", () => {
    expect(parseOmpModelList({})).toEqual([]);
    expect(parseOmpModelList(null)).toEqual([]);
  });
  test("gjc --list-models table still parses", () => {
    const out = parseGjcModelList(
      [
        "Provider models",
        "provider          model                    context  max-out  thinking                           images",
        "anthropic         claude-opus-5-5          1M       128K     minimal,low,medium,high,xhigh      yes",
        "openai-codex      gpt-6.1-sol              272K     128K     minimal,low,medium,high,xhigh      yes",
      ].join("\n"),
    );
    expect(out).toEqual([{ id: "openai-codex/gpt-6.1-sol", efforts: ["off", "minimal", "low", "medium", "high", "xhigh"] }]);
  });
});

describe("model refusal", () => {
  test("Anthropic models are refused on both harnesses", () => {
    for (const h of ["gjc", "omp"] as const) {
      for (const m of ["anthropic/claude-opus-5-5", "commandcode/claude-sonnet-5", "openai-codex/opus-thing", "workbuddy/haiku-x"]) {
        expect(() => assertAllowedModel(m, h)).toThrow("Claude runs only in Claude Code");
      }
      expect(() => assertAllowedModel("openai-codex/gpt-5.6-luna", h)).not.toThrow();
    }
  });
});
