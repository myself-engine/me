import { describe, expect, test } from "bun:test";
import { codexTrustBlock, ensureCodexTrust, isTomlParseable, managedTrustPaths, outsideProjectPaths, underWorktreeRoot } from "./trust.ts";

const ROOT = "/Users/me/Library/Application Support/brgr/worktrees";

describe("codex trust", () => {
  test("creates a managed block on an empty config", () => {
    const out = ensureCodexTrust("", [ROOT]);
    expect(out).toContain("# me:brgr-trust begin");
    expect(out).toContain(`[projects."${ROOT}"]`);
    expect(out).toContain('trust_level = "trusted"');
  });

  test("replaces the old block and keeps other config", () => {
    const before = `[other]\nkeep = true\n${codexTrustBlock(["/old"])}`;
    const out = ensureCodexTrust(before, [ROOT, "/w/abc"]);
    expect(out).toContain("keep = true");
    expect(out).not.toContain('"/old"');
    expect(out).toContain(`[projects."${ROOT}"]`);
    expect(out).toContain('[projects."/w/abc"]');
    expect(out.match(/# me:brgr-trust begin/g)).toHaveLength(1);
  });

  test("is idempotent", () => {
    const once = ensureCodexTrust('[x]\na = 1\n', [ROOT]);
    expect(ensureCodexTrust(once, [ROOT])).toBe(once);
  });

  test("omits a path already defined outside the block (no duplicate table)", () => {
    const before = `[projects."${ROOT}"]\ntrust_level = "trusted"\n`;
    const out = ensureCodexTrust(before, [ROOT]);
    expect(out).toContain(`[projects."${ROOT}"]`);
    expect(out.split(`[projects."${ROOT}"]`).length - 1).toBe(1);
    expect(isTomlParseable(out)).toBe(true);
  });

  test("single-quoted outside key is also deduplicated", () => {
    const before = `[projects.'${ROOT}']\ntrust_level = "trusted"\n`;
    expect(outsideProjectPaths(before)).toEqual([ROOT]);
    const out = ensureCodexTrust(before, [ROOT]);
    expect(out.match(/# me:brgr-trust begin/g)).toHaveLength(1);
    expect(isTomlParseable(out)).toBe(true);
  });

  test("whitespace-padded outside header is deduplicated", () => {
    const before = `[  projects  .  "${ROOT}"  ]\ntrust_level = "trusted"\n`;
    expect(outsideProjectPaths(before)).toEqual([ROOT]);
    expect(isTomlParseable(ensureCodexTrust(before, [ROOT]))).toBe(true);
  });

  test("untrusted outside entry is left alone, never overridden", () => {
    const before = `[projects."${ROOT}"]\ntrust_level = "untrusted"\n`;
    const out = ensureCodexTrust(before, [ROOT]);
    expect(out).toContain('trust_level = "untrusted"');
    expect(out).not.toContain(`[projects."${ROOT}"]\ntrust_level = "trusted"`);
    expect(isTomlParseable(out)).toBe(true);
  });

  test("unparseable input is returned untouched", () => {
    const before = `[projects."${ROOT}"\ntrust_level = "trusted"\n`;
    expect(isTomlParseable(before)).toBe(false);
    expect(ensureCodexTrust(before, [ROOT])).toBe(before);
  });

  test("re-run over an outside duplicate stays idempotent", () => {
    const before = `[projects."${ROOT}"]\ntrust_level = "trusted"\n`;
    const once = ensureCodexTrust(before, [ROOT]);
    expect(ensureCodexTrust(once, [ROOT])).toBe(once);
  });

  test("managedTrustPaths lists only the block's entries", () => {
    const text = `[projects."/mine"]\ntrust_level = "trusted"\n${codexTrustBlock([ROOT, "/w/abc"])}`;
    expect(managedTrustPaths(text).sort()).toEqual([ROOT, "/w/abc"].sort());
    expect(managedTrustPaths("no block here")).toEqual([]);
  });

  test("trust never widens beyond the worktree root", () => {
    expect(underWorktreeRoot(ROOT, ROOT)).toBe(true);
    expect(underWorktreeRoot(`${ROOT}/abc`, ROOT)).toBe(true);
    expect(underWorktreeRoot("/Users/me/dev/me", ROOT)).toBe(false);
    expect(underWorktreeRoot(`${ROOT}-other`, ROOT)).toBe(false);
  });
});
