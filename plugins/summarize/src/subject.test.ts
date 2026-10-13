import { describe, expect, test } from "bun:test";
import { normalizeCommitSubject } from "./subject.ts";

describe("normalizeCommitSubject", () => {
  test("trims whitespace, quotes, and the trailing period", () => {
    expect(normalizeCommitSubject('  "Add multiply function with a test."  ')).toBe("Add multiply function with a test");
  });

  test("non-strings and empty subjects give empty string", () => {
    expect(normalizeCommitSubject(undefined)).toBe("");
    expect(normalizeCommitSubject("  ")).toBe("");
  });

  test("long subjects cap at a word boundary", () => {
    const s = normalizeCommitSubject(`${"word ".repeat(30)}tail`);
    expect(s.length).toBeLessThanOrEqual(72);
    expect(s.endsWith("tail")).toBe(false);
  });
});
