// Pure diff text helpers for the review screen (no React, unit-tested).

export interface StatFile {
  path: string;
  /** Changed lines as git reports them; null for binary files. */
  changes: number | null;
  plus: number;
  minus: number;
}

export interface DiffStat {
  files: StatFile[];
  /** The closing "N files changed, …" line, if present. */
  summary: string | null;
}

/** Parses `git diff --stat` output: ` path | 12 +++--` rows and the summary line. */
export function parseDiffStat(text: string): DiffStat {
  const files: StatFile[] = [];
  let summary: string | null = null;
  for (const line of text.split("\n")) {
    const row = line.match(/^\s*(.+?)\s+\|\s+(?:(\d+)\s*(\+*)(-*)|Bin\b.*)\s*$/);
    if (row) {
      files.push({ path: row[1]!.trim(), changes: row[2] !== undefined ? Number(row[2]) : null, plus: row[3]?.length ?? 0, minus: row[4]?.length ?? 0 });
      continue;
    }
    if (/^\s*\d+ files? changed/.test(line)) summary = line.trim();
  }
  return { files, summary };
}

export interface FileDiff {
  path: string;
  text: string;
  added: number;
  removed: number;
}

/** Splits a unified diff into one chunk per file (by `diff --git` headers). */
export function splitDiff(text: string): FileDiff[] {
  const out: FileDiff[] = [];
  const starts = [...text.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)];
  if (starts.length === 0) return text.trim() ? [{ path: "", text: text.trim(), ...countLines(text) }] : [];
  starts.forEach((m, i) => {
    const chunk = text.slice(m.index, i + 1 < starts.length ? starts[i + 1]!.index : undefined).trimEnd();
    out.push({ path: m[2]!, text: chunk, ...countLines(chunk) });
  });
  return out;
}

function countLines(chunk: string) {
  let added = 0;
  let removed = 0;
  for (const l of chunk.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) added++;
    else if (l.startsWith("-") && !l.startsWith("---")) removed++;
  }
  return { added, removed };
}
