import { describe, expect, test } from "bun:test";
import { accessOf, brainChoice, checkAccess, checkCooldownSec, checkFallbackModels, checkWorkerChoice, DEFAULT_ACCESS, DEFAULT_COOLDOWN_SEC, parseModelList } from "./settings.ts";

const LIST = `Canonical models
canonical            selected                       variants  context  max-out
gpt-6.1-sol          openai-codex/gpt-6.1-sol       5         272K     128K

Provider models
provider          model                    context  max-out  thinking                           images
anthropic         claude-opus-5-5          1M       128K     minimal,low,medium,high,xhigh      yes
openai-codex      gpt-6.1-sol              272K     128K     minimal,low,medium,high,xhigh      yes
workbuddy         kimi-k3                  1M       32K      yes                                yes
ollama            dolphin3:latest          131K     8.2K     no                                 no
`;

describe("parseModelList", () => {
  test("reads provider rows with their thinking levels and drops Anthropic models", () => {
    expect(parseModelList(LIST)).toEqual([
      { id: "openai-codex/gpt-6.1-sol", efforts: ["off", "minimal", "low", "medium", "high", "xhigh"] },
      { id: "workbuddy/kimi-k3", efforts: null },
      { id: "ollama/dolphin3:latest", efforts: ["off"] },
    ]);
  });
});

describe("choices", () => {
  test("a thread's own choice wins over the defaults, field by field", () => {
    const d = { model: "a/m", effort: "off" as const };
    expect(brainChoice({}, d)).toEqual(d);
    expect(brainChoice({ effort: "high" }, d)).toEqual({ model: "a/m", effort: "high" });
    expect(brainChoice({ model: "b/n", effort: null }, d)).toEqual({ model: "b/n", effort: "off" });
  });
  test("worker: Claude models only through Claude Code, empty fields mean the harness default", () => {
    expect(checkWorkerChoice({ harness: "local.claude-code", model: "opus", effort: "high" })).toEqual({ model: "opus", effort: "high" });
    expect(() => checkWorkerChoice({ harness: "local.gjc", model: "claude-sonnet-5-5" })).toThrow();
    expect(checkWorkerChoice({ harness: "local.codex", model: " ", effort: "" })).toEqual({});
    expect(() => checkWorkerChoice({ harness: "local.codex", effort: "max" })).toThrow();
  });
});

describe("access", () => {
  test("read and project pass without confirm, full needs confirm: true", () => {
    expect(checkAccess({})).toEqual({});
    expect(checkAccess({ access: null })).toEqual({});
    expect(checkAccess({ access: "read" })).toEqual({ access: "read" });
    expect(checkAccess({ access: "project" })).toEqual({ access: "project" });
    expect(() => checkAccess({ access: "full" })).toThrow("확인");
    expect(() => checkAccess({ access: "full", confirm: false })).toThrow("확인");
    expect(checkAccess({ access: "full", confirm: true })).toEqual({ access: "full" });
  });
  test("unknown modes are refused", () => {
    expect(() => checkAccess({ access: "admin" })).toThrow("모드");
    expect(() => checkAccess({ access: "" })).toThrow("모드");
  });
  test("a thread's own access wins, otherwise the default (project) applies", () => {
    expect(DEFAULT_ACCESS).toBe("project");
    expect(accessOf({}, { access: "project" })).toBe("project");
    expect(accessOf({ access: null }, { access: "full" })).toBe("full");
    expect(accessOf({ access: "read" }, { access: "project" })).toBe("read");
  });
});

describe("fallback", () => {
  test("fallback models are trimmed and deduped, empty means no fallback", () => {
    expect(DEFAULT_COOLDOWN_SEC).toBe(600);
    expect(checkFallbackModels({})).toEqual({});
    expect(checkFallbackModels({ fallbackModels: null })).toEqual({});
    expect(checkFallbackModels({ fallbackModels: [] })).toEqual({ fallbackModels: [] });
    expect(checkFallbackModels({ fallbackModels: [" a/m ", "a/m", "b/n"] })).toEqual({ fallbackModels: ["a/m", "b/n"] });
    expect(() => checkFallbackModels({ fallbackModels: "a/m" })).toThrow("배열");
    expect(() => checkFallbackModels({ fallbackModels: ["  "] })).toThrow("비어");
  });
  test("Anthropic models are refused as fallbacks", () => {
    expect(() => checkFallbackModels({ fallbackModels: ["anthropic/claude-opus-5-5"] })).toThrow("Claude Code에서만");
    expect(() => checkFallbackModels({ fallbackModels: ["openai/claude-sonnet-5"] })).toThrow("Claude Code에서만");
  });
  test("cooldownSec must be a finite number at or above zero", () => {
    expect(checkCooldownSec({})).toEqual({});
    expect(checkCooldownSec({ cooldownSec: 0 })).toEqual({ cooldownSec: 0 });
    expect(checkCooldownSec({ cooldownSec: 30 })).toEqual({ cooldownSec: 30 });
    expect(() => checkCooldownSec({ cooldownSec: -1 })).toThrow("cooldownSec");
    expect(() => checkCooldownSec({ cooldownSec: Number.NaN })).toThrow("cooldownSec");
    expect(() => checkCooldownSec({ cooldownSec: "60" })).toThrow("cooldownSec");
  });
});
