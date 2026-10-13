// Pure commit-subject validation for summarize output.
// Mirrors the helpers in plugins/brgr/src/domain/commit.ts (plugins never
// import each other, so the ~20 lines live in both places); both are tested.
export function normalizeCommitSubject(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let s = raw.replace(/\s+/g, " ").trim();
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
  const cut = t.slice(0, max).replace(/\s+$/, "");
  const last = cut.lastIndexOf(" ");
  if (last <= 0) return cut.slice(0, 60);
  return cut.slice(0, last);
}
