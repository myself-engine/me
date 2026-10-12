import { describe, expect, test } from "bun:test";
import { fallbackReason, isFallbackEligible } from "./fallback.ts";

describe("fallbackReason", () => {
  test("quota and rate limits are eligible", () => {
    expect(fallbackReason(new Error("gjc error: 429 rate limit exceeded"))).toBe("quota");
    expect(fallbackReason("too many requests, retry later")).toBe("quota");
    expect(fallbackReason("quota exhausted for today")).toBe("quota");
  });
  test("expired auth is eligible", () => {
    expect(fallbackReason(new Error("gjc error: provider login expired (openai)"))).toBe("auth-expired");
    expect(fallbackReason("openai authentication token expired, please refresh")).toBe("auth-expired");
    expect(fallbackReason("401 unauthorized")).toBe("auth-expired");
  });
  test("missing models are eligible", () => {
    expect(fallbackReason("model_not_supported")).toBe("model-unavailable");
    expect(fallbackReason("model foo is not supported by this provider")).toBe("model-unavailable");
    expect(fallbackReason("unknown model: bar/baz")).toBe("model-unavailable");
  });
  test("provider 5xx and network errors are eligible", () => {
    expect(fallbackReason("gjc error: provider 503 service unavailable")).toBe("provider-error");
    expect(fallbackReason("fetch failed: socket hang up")).toBe("provider-error");
    expect(fallbackReason("connection reset by peer")).toBe("provider-error");
  });
  test("context-too-long is not eligible even next to a 500", () => {
    expect(fallbackReason("500 context length exceeded: reduce prompt")).toBeNull();
    expect(fallbackReason("prompt exceeds token limit")).toBeNull();
    expect(fallbackReason("input too long for context_window")).toBeNull();
  });
  test("refusals, guard violations and cancels are not eligible", () => {
    expect(fallbackReason("model foo is not allowed inside GJC (Claude runs only in Claude Code)")).toBeNull();
    expect(fallbackReason("gpt-x은 Claude Code에서만 쓸 수 있어요")).toBeNull();
    expect(fallbackReason("head tried to use tool read; run aborted")).toBeNull();
    expect(fallbackReason("aborted")).toBeNull();
    expect(fallbackReason("user cancelled the run")).toBeNull();
    expect(fallbackReason("content refused by policy")).toBeNull();
  });
  test("unknown errors stay ineligible", () => {
    expect(fallbackReason(new Error("something completely new"))).toBeNull();
    expect(isFallbackEligible(new Error("gjc error: 429 too many requests"))).toBe(true);
    expect(isFallbackEligible(new Error("nope"))).toBe(false);
  });
});
