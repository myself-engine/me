// Pure helpers for turning a sealed diff into a commit.

export const CO_AUTHOR = "Co-Authored-By: me <noreply@me.local>";
const SUBJECT_MAX = 72;

export function commitMessage(objective: string, taskId: string): string {
  const first = objective.split("\n")[0]?.trim() ?? "";
  const subject = (first || `brgr task ${taskId}`).slice(0, SUBJECT_MAX).trimEnd();
  return `${subject}\n\nApplied from brgr task ${taskId} via me.\n\n${CO_AUTHOR}`;
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
