// Worker trust preparation: pure helpers, no I/O.
//
// Findings (2026-10-12, from brgr harness manifests and the harness CLIs):
// - Codex one-shot runs carry --dangerously-bypass-approvals-and-sandbox, so
//   they never stop on a trust prompt. The interactive worker TUI (bare
//   `codex` in a fresh brgr worktree) can: it honours only
//   ~/.codex/config.toml `[projects."<path>"] trust_level = "trusted"`.
//   That file is rewritten rarely, so a marker-block read-modify-write is safe.
// - Claude Code one-shot runs carry --permission-mode bypassPermissions, but
//   the interactive TUI launches with no flags at all, so a fresh worktree can
//   still stop on its folder-trust dialog. Its answer lives in ~/.claude.json,
//   which running Claude sessions rewrite constantly; no atomic
//   read-modify-write tolerates those concurrent writers (rename is atomic but
//   loses their updates), so me never touches that file. The fix belongs
//   upstream in brgr's harness manifest (e.g. a skip-permissions flag for the
//   interactive launch), not here.
// - Trust is never widened beyond brgr's own worktree root: only that root
//   and exact worktree paths beneath it are ever added.

import { homedir } from "node:os";
import { join } from "node:path";

const BEGIN = "# me:brgr-trust begin (managed by me, do not edit)";
const END = "# me:brgr-trust end";

/** brgr's worktree root: $BRGR_HOME/worktrees, defaulting to ~/Library/Application Support/brgr/worktrees. */
export function worktreeRoot(home?: string): string {
  const base = home ?? process.env.BRGR_HOME ?? join(homedir(), "Library", "Application Support", "brgr");
  return join(base, "worktrees");
}

/** True when the path is the worktree root or sits beneath it. */
export function underWorktreeRoot(path: string, root?: string): boolean {
  const r = (root ?? worktreeRoot()).replace(/\/+$/, "");
  return path === r || path.startsWith(`${r}/`);
}

const quote = (p: string) => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The managed TOML block granting Codex trust to the given paths. */
export function codexTrustBlock(paths: string[]): string {
  const lines = [BEGIN];
  for (const p of [...new Set(paths)].sort()) lines.push(`[projects.${quote(p)}]`, `trust_level = "trusted"`);
  lines.push(END);
  return `${lines.join("\n")}\n`;
}

const stripBlock = (text: string): string => {
  const start = text.indexOf(BEGIN);
  if (start < 0) return text;
  const end = text.indexOf(END, start);
  const cut = end < 0 ? text.length : end + END.length;
  const stripped = `${text.slice(0, start)}${text.slice(cut)}`.replace(/\n{3,}/g, "\n\n");
  // The block carries its own trailing newline; drop leftovers so re-adding is idempotent.
  return /^\s*$/.test(stripped) ? "" : stripped.replace(/\n+$/, "\n");
};

/**
 * Ensures the managed block lists exactly `paths` (plus nothing else),
 * preserving all other config text. Pass the worktree root so every future
 * worker worktree is covered, plus exact worktree paths when known.
 */
export function ensureCodexTrust(configText: string, paths: string[]): string {
  const base = stripBlock(configText);
  const prefix = base.length > 0 && !base.endsWith("\n") ? "\n" : "";
  return `${base}${prefix}${codexTrustBlock(paths)}`;
}

/** Paths named in the managed block, for pruning entries whose worktree is gone. */
export function managedTrustPaths(configText: string): string[] {
  const start = configText.indexOf(BEGIN);
  if (start < 0) return [];
  const end = configText.indexOf(END, start);
  const block = configText.slice(start, end < 0 ? configText.length : end);
  const out: string[] = [];
  for (const m of block.matchAll(/^\[projects\."((?:[^"\\]|\\.)*)"\]/gm)) {
    out.push(m[1]!.replace(/\\(.)/g, "$1"));
  }
  return out;
}
