import { describe, expect, test } from "bun:test";
import { codexTrustBlock, ensureCodexTrust, managedTrustPaths, underWorktreeRoot } from "./trust.ts";

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
