// Pure helpers for turning a sealed diff into a commit.
// The subject helpers below mirror plugins/summarize/src/subject.ts (plugins
// never import each other, so the ~20 lines live in both places).

export const CO_AUTHOR = "Co-Authored-By: me <noreply@me.local>";

export interface CommitTask {
  taskId: string;
  /** Short English imperative subject from summarize; may be absent on old tasks. */
  commitSubject?: string | null;
  /** The user's original raw message (Korean), stored at delegation. */
  request?: string | null;
  /** The worker brief (objective); the legacy subject source. */
  objective: string;
}

/** First sentence of the brief's first line (up to . ! ? or 개행). */
function firstSentence(brief: string): string {
  const line = brief.split("\n")[0]?.trim() ?? "";
  if (!line) return "";
  const m = /^[^.!?\n]+[.!?]/.exec(line);
  return (m ? m[0] : line).trim();
}

export function commitMessage(task: CommitTask | string, taskId?: string): string {
  const t: CommitTask =
    typeof task === "string" ? { taskId: taskId ?? "", objective: task } : task;
  const id = t.taskId;
  // Subject: commitSubject, else the user's request first line, else the brief's first sentence.
  const subjectRaw =
    normalizeCommitSubject(t.commitSubject) ||
    normalizeCommitSubject(t.request?.split("\n")[0]) ||
    normalizeCommitSubject(firstSentence(t.objective)) ||
    `brgr task ${id}`;
  const subject = subjectRaw || `brgr task ${id}`;
  const requested = (t.request ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const body = requested
    ? `Requested: ${requested}\n\nApplied from brgr task ${id} via me.`
    : `Applied from brgr task ${id} via me.`;
  return `${subject}\n\n${body}\n\n${CO_AUTHOR}`;
}

// Collapse whitespace, strip surrounding quotes and one trailing period,
// then cap at a word boundary (hard 72); "" when nothing usable remains.
export function normalizeCommitSubject(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let s = raw.replace(/\s+/g, " ").trim();
  // Strip one layer of surrounding quotes ("…", '…', «…» style pairs).
  if (s.length >= 2) {
    const pairs: Record<string, string> = { '"': '"', "'": "'", "`": "`", "«": "»", "“": "”", "‘": "’" };
    const close = pairs[s[0]!];
    if (close && s.endsWith(close)) s = s.slice(1, -1).trim();
  }
  s = s.replace(/\.+$/, "").trim();
  if (!s) return "";
  if (s.length <= 60) return s;
  return truncateSubject(s, 72);
}

/** Cut `s` at a word boundary within `max` chars; spaceless text cuts hard at 60. */
export function truncateSubject(s: string, max = 72): string {
  const t = s.trim();
  if (t.length <= max) return t;
  if (!/\s/.test(t)) return t.slice(0, 60);
  // Cut hard at max, then back up to the last space so no word is split.
  const cut = t.slice(0, max).replace(/\s+$/, "");
  const last = cut.lastIndexOf(" ");
  if (last <= 0) return cut.slice(0, 60);
  return cut.slice(0, last);
}


/** Paths a unified git diff touches, old and new sides of renames included, in first-seen order. */
export function touchedFiles(diff: string): string[] {
  const seen = new Set<string>();
  const add = (p: string | null) => {
    if (p) seen.add(p);
  };
  let inHeader = false;
  for (const raw of diff.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      for (const p of headerPaths(line.slice("diff --git ".length))) add(p);
      continue;
    }
    if (!inHeader) continue;
    if (line.startsWith("@@")) {
      inHeader = false;
      continue;
    }
    for (const [prefix, side] of [
      ["--- ", "a/"],
      ["+++ ", "b/"],
    ] as const) {
      if (line.startsWith(prefix)) add(sidePath(line.slice(prefix.length).replace(/\t$/, ""), side));
    }
    for (const prefix of ["rename from ", "rename to ", "copy to "]) {
      if (line.startsWith(prefix)) add(unquote(line.slice(prefix.length)));
    }
  }
  return [...seen];
}

function sidePath(s: string, side: "a/" | "b/"): string | null {
  if (s === "/dev/null") return null;
  const p = unquote(s);
  return p.startsWith(side) ? p.slice(side.length) : null;
}

// `a/<old> b/<new>`; quoted when the path has special characters. Unquoted paths with spaces
// are only resolvable when both sides are equal, which is the case whenever no rename happened.
function headerPaths(rest: string): string[] {
  if (rest.startsWith('"')) {
    const end = closingQuote(rest);
    const left = unquote(rest.slice(0, end + 1));
    const right = unquote(rest.slice(end + 2));
    return [left.replace(/^a\//, ""), right.replace(/^b\//, "")];
  }
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === " ") {
    const left = rest.slice(0, half);
    const right = rest.slice(half + 1);
    if (left.startsWith("a/") && right.startsWith("b/") && left.slice(2) === right.slice(2)) return [left.slice(2)];
  }
  // Anything else (renames) is also covered by the `---`/`+++`/`rename` lines that follow.
  const m = /^a\/(\S+) b\/(\S+)$/.exec(rest);
  return m ? [m[1]!, m[2]!] : [];
}

function closingQuote(s: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === '"') return i;
  }
  return s.length - 1;
}

const ESCAPES: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };

/** Decodes git's C-style quoted path ("dir/\352\260\200.txt"); returns unquoted input as is. */
export function unquote(s: string): string {
  if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s;
  const body = s.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      bytes.push(...new TextEncoder().encode(c));
      continue;
    }
    const next = body[i + 1] ?? "";
    const oct = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (oct) {
      bytes.push(parseInt(oct[0], 8));
      i += 3;
    } else {
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
