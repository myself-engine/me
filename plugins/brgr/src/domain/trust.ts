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
 *
 * Paths already defined by a `[projects.<path>]` table outside the managed
 * block are omitted from the block: Codex itself adds such tables when the
 * user accepts a trust prompt, and a second definition (even an identical
 * one) makes Codex refuse the whole config. Entries the user left untrusted
 * stay exactly as they are; an untrusted outside table is never overridden.
 * When the existing text (or the rebuilt text) does not parse as TOML, the
 * input is returned unchanged so callers skip the write.
 */
export function ensureCodexTrust(configText: string, paths: string[]): string {
  if (configText.length > 0 && !isTomlParseable(configText)) return configText;
  const outside = new Set(outsideProjectPaths(configText));
  const filtered = [...new Set(paths)].filter((p) => !outside.has(p));
  const base = stripBlock(configText);
  const prefix = base.length > 0 && !base.endsWith("\n") ? "\n" : "";
  const next = `${base}${prefix}${codexTrustBlock(filtered)}`;
  if (!isTomlParseable(next)) return configText;
  return next;
}

/** True when `text` parses as TOML (empty counts as parseable). */
export function isTomlParseable(text: string): boolean {
  try {
    Bun.TOML.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Split a TOML table header's dotted key into unquoted segments. Null when malformed. */
const splitDottedKey = (inner: string): string[] | null => {
  const raw: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let i = 0;
  while (i < inner.length) {
    const c = inner[i]!;
    if (quote === '"') {
      cur += c;
      if (c === "\\" && i + 1 < inner.length) cur += inner[++i]!;
      else if (c === '"') quote = null;
      i++;
      continue;
    }
    if (quote === "'") {
      cur += c;
      if (c === "'") quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      i++;
      continue;
    }
    if (c === ".") {
      raw.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (quote !== null) return null;
  raw.push(cur);
  return raw.map((seg) => {
    const s = seg.trim();
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\(.)/g, "$1");
    if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
    return s;
  });
};

/** The project path of a `[projects.<path>]` table header line, or null. Ignores `[[array]]` headers. */
const projectsHeaderPath = (line: string): string | null => {
  const m = line.match(/^\s*\[(?!\[)(.+?)\]\s*(?:#.*)?$/);
  if (!m) return null;
  const segs = splitDottedKey(m[1]!);
  if (!segs || segs[0] !== "projects" || segs.length < 2) return null;
  return segs[1]!;
};

/**
 * Project paths with a `[projects.<path>]` table outside the managed block.
 * Handles quoted (`"x"`, `'x'`), bare, and whitespace-padded headers.
 */
export function outsideProjectPaths(configText: string): string[] {
  const out = new Set<string>();
  for (const line of stripBlock(configText).split("\n")) {
    const p = projectsHeaderPath(line);
    if (p !== null) out.add(p);
  }
  return [...out];
};

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
