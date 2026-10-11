import { describe, expect, test } from "bun:test";
import { brainChoice, checkWorkerChoice, parseModelList } from "./settings.ts";

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
