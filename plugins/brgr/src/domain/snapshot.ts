// Worker file setup (.worktreeinclude + pluginConfig brgr `include`): pure helpers, no I/O.
//
// A per-project `.worktreeinclude` file lists gitignore-style patterns for
// files the worker needs in its base even though they are uncommitted
// (typically secrets like .env, which stay local and are never logged).
// pluginConfig brgr `include: {"<project>": ["…"]}` adds more patterns for
// the same purpose, matched by full project path first, then repo name.
// Only this subset of gitignore syntax is honoured:
//   - blank lines and `#` comments are skipped; `!` negates (excludes again)
//   - a pattern without `/` matches that basename at any depth (`**/` prefix)
//   - trailing `/` means directory-only (everything beneath matches)
//   - `*`/`?`/`[...]` never cross `/`; `**` does
// Matched files are passed to `brgr run --snapshot-path` so they become part
// of the worker's base. Total size is capped at 5 MB; over the cap the whole
// snapshot is skipped with a Korean warning on the task.

/** Uncommitted files may not exceed this in total; over it the snapshot is skipped. */
export const SNAPSHOT_CAP_BYTES = 5 * 1024 * 1024;

export interface SnapshotPlan {
  /** Project-absolute paths to hand to brgr. Secret names are never logged by callers. */
  paths: string[];
  totalBytes: number;
}

/** Split raw file/config text into ordered include and exclude (negated) patterns. */
export function parsePatterns(text: string): { include: string[]; exclude: string[] } {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("!")) {
      const p = line.slice(1).trim();
      if (p) exclude.push(p);
    } else {
      include.push(line);
    }
  }
  return { include, exclude };
}

/** Explicit config wins by full path, then by repo (directory) name. Shared with verify's matcher shape. */
export function configListFor(project: string, byProject: Record<string, string[]> | undefined): string[] {
  if (!byProject) return [];
  if (byProject[project] !== undefined) return byProject[project];
  const name = project.split("/").filter(Boolean).pop();
  if (name && byProject[name] !== undefined) return byProject[name];
  return [];
}

/** Turns one gitignore-style pattern into a glob rooted at the project dir. */
export function toGlob(pattern: string): { glob: string; dirOnly: boolean } {
  let p = pattern.trim();
  const dirOnly = p.endsWith("/");
  p = p.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!p.includes("/")) p = `**/${p}`;
  return { glob: p, dirOnly };
}

const segmentToRegExp = (seg: string): string => {
  let out = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const close = seg.indexOf("]", i + 1);
      if (close > i + 1) {
        out += seg.slice(i, close + 1);
        i = close;
      } else {
        out += "\\[";
      }
    } else if ("\\.+()|^$|{}".includes(c)) out += `\\${c}`;
    else out += c;
  }
  return out;
};

/** Matches one translated glob against a project-relative posix path. */
export function matchGlob(glob: string, rel: string): boolean {
  const gseg = glob.split("/");
  const rseg = rel.split("/");
  const match = (gi: number, ri: number): boolean => {
    if (gi === gseg.length) return ri === rseg.length;
    if (gseg[gi] === "**") {
      for (let k = ri; k <= rseg.length; k++) if (match(gi + 1, k)) return true;
      return false;
    }
    if (ri === rseg.length) return false;
    if (!new RegExp(`^${segmentToRegExp(gseg[gi]! )}$`).test(rseg[ri]!)) return false;
    return match(gi + 1, ri + 1);
  };
  return match(0, 0);
}

/**
 * Applies ordered patterns to one relative path: the last matching pattern
 * wins, includes select and `!` excludes deselect. A directory-only pattern
 * also matches everything beneath the directory.
 */
export function wantedBy(rel: string, include: string[], exclude: string[]): boolean {
  const hit = (pattern: string): boolean => {
    const { glob, dirOnly } = toGlob(pattern);
    if (matchGlob(glob, rel)) return true;
    if (!dirOnly) return false;
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (matchGlob(glob, parts.slice(0, i).join("/"))) return true;
    }
    return false;
  };
  let want = false;
  for (const p of include) if (hit(p)) want = true;
  for (const p of exclude) if (hit(p)) want = false;
  return want;
}


/** Sums sizes and enforces the cap; over it the caller skips the snapshot with a Korean warning. */
export function planSnapshots(files: { path: string; bytes: number }[]): SnapshotPlan | null {
  const totalBytes = files.reduce((n, f) => n + f.bytes, 0);
  if (totalBytes > SNAPSHOT_CAP_BYTES) return null;
  return { paths: files.map((f) => f.path), totalBytes };
}
