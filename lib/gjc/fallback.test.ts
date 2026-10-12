import { describe, expect, test } from "bun:test";
import { withModelFallback } from "./index.ts";

const quota = () => new Error("429 rate limit exceeded");
const down = () => new Error("provider 503 service unavailable");
const eligible = (err: unknown) => (/429|503/.test(String((err as Error).message)) ? "retryable" : null);

function runner(script: (Error | string)[]) {
  const tried: string[] = [];
  return {
    tried,
    run: async (model: string) => {
      tried.push(model);
      const next = script[tried.length - 1];
      if (next instanceof Error) throw next;
      return { text: typeof next === "string" ? next : `ok:${model}` };
    },
  };
}

describe("withModelFallback", () => {
  test("primary success needs no fallback", async () => {
    const r = runner(["hi"]);
    const out = await withModelFallback({ primary: "p", fallbackModels: ["f"], cooldownSec: 600, cooldowns: new Map(), isEligible: eligible, run: r.run });
    expect(out.value).toEqual({ text: "hi" });
    expect(out.fallback).toBeNull();
    expect(r.tried).toEqual(["p"]);
  });

  test("tries fallbacks in order and reports from/to/reason", async () => {
    const r = runner([quota(), down(), "fine"]);
    const seen: unknown[] = [];
    const out = await withModelFallback({ primary: "p", fallbackModels: ["f1", "f2"], cooldownSec: 600, cooldowns: new Map(), isEligible: eligible, run: r.run, onFallback: (f) => seen.push(f) });
    expect(r.tried).toEqual(["p", "f1", "f2"]);
    expect(out.fallback).toEqual({ from: "p", to: "f2", reason: "retryable" });
    expect(seen).toEqual([{ from: "p", to: "f2", reason: "retryable" }]);
    expect(String((out.primaryError as Error).message)).toContain("429");
  });

  test("skips models in cooldown and expires them", async () => {
    let at = 1_000_000;
    const r = runner(["fine"]);
    const out = await withModelFallback({ primary: "p", fallbackModels: ["f1"], cooldownSec: 600, cooldowns: new Map([["p", at + 100_000]]), now: () => at, isEligible: eligible, run: r.run });
    expect(r.tried).toEqual(["f1"]);
    expect(out.fallback).toMatchObject({ from: "p", to: "f1" });
    at += 601_000;
    const r2 = runner(["fine"]);
    const out2 = await withModelFallback({ primary: "p", fallbackModels: ["f1"], cooldownSec: 600, cooldowns: new Map([["p", at - 1]]), now: () => at, isEligible: eligible, run: r2.run });
    expect(r2.tried).toEqual(["p"]);
    expect(out2.fallback).toBeNull();
  });

  test("marks every eligible failure in cooldown and throws the last error when all fail", async () => {
    const at = 2_000_000;
    const cooldowns = new Map<string, number>();
    const r = runner([quota(), down()]);
    await expect(withModelFallback({ primary: "p", fallbackModels: ["f"], cooldownSec: 60, cooldowns, now: () => at, isEligible: eligible, run: r.run })).rejects.toThrow("503");
    expect(r.tried).toEqual(["p", "f"]);
    expect(cooldowns.get("p")).toBe(at + 60_000);
    expect(cooldowns.get("f")).toBe(at + 60_000);
  });

  test("a non-eligible failure aborts without trying fallbacks", async () => {
    const r = runner([new Error("aborted")]);
    await expect(withModelFallback({ primary: "p", fallbackModels: ["f"], cooldownSec: 600, cooldowns: new Map(), isEligible: eligible, run: r.run })).rejects.toThrow("aborted");
    expect(r.tried).toEqual(["p"]);
  });

  test("Anthropic models are refused before anything runs", async () => {
    const r = runner(["hi"]);
    await expect(withModelFallback({ primary: "p", fallbackModels: ["anthropic/claude-opus-5-5"], cooldownSec: 600, cooldowns: new Map(), isEligible: eligible, run: r.run })).rejects.toThrow("not allowed inside GJC");
    expect(r.tried).toEqual([]);
  });
});
