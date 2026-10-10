// Routing rules of the head: when to skip judging, when to answer directly, which harness to use.
// Pure functions only; no I/O.
import type { Judgement, Route } from "./types.ts";

export const FAST_PATH_MAX_CHARS = 40;

const WORK_WORDS_KO = ["파일", "코드", "수정", "추가", "만들어", "고쳐", "리뷰", "커밋", "배포", "테스트"];
const WORK_SIGNALS: RegExp[] = [
  /`/,
  // Paths: ~/x, ./x, ../x, /x/y, a/b
  /(^|[\s(])(~|\.{1,2})?\/[\w.-]/,
  /[\w.-]+\/[\w.-]+/,
  // File extensions such as main.ts, README.md
  /(^|[^.])\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|py|go|rs|java|kt|swift|rb|php|c|h|cpp|cs|sh|ya?ml|toml|css|scss|html|sql|txt|lock|env)\b/i,
  /\b(PR|repo|README)s?\b/i,
];

/** True when the text mentions files, code or work the head would have to delegate. */
export function hasWorkSignal(text: string): boolean {
  return WORK_WORDS_KO.some((w) => text.includes(w)) || WORK_SIGNALS.some((re) => re.test(text));
}

/** Short chat with no work signals skips summarize and jev and is answered directly. */
export function isFastPath(normalized: string): boolean {
  const t = normalized.trim();
  return t.length > 0 && t.length <= FAST_PATH_MAX_CHARS && !hasWorkSignal(t);
}

/** Judgement shown for fast-path messages so the UI still renders a badge. */
export function fastPathJudgement(): Judgement {
  return { simpleProb: 1, confidence: 1, source: "fast-path", model: "rule" };
}

/** Anything that needs files is delegated; otherwise direct only when clearly simple. Uncertain means delegate. */
export function decideRoute(p: { needsCodeChange: boolean; simpleProb: number; threshold: number }): Route {
  return !p.needsCodeChange && p.simpleProb >= p.threshold ? "direct" : "delegate";
}

export interface HarnessChoice {
  harness: string;
  /** True when the decider's amend replaced the suggestion. */
  amended: boolean;
}

/** The decider's amend.harness wins when it names a known harness; otherwise the suggestion stands. */
export function chooseHarness(p: { suggested: string; harnesses: string[]; amend?: Record<string, unknown> | null }): HarnessChoice {
  const wanted = p.amend?.harness;
  if (typeof wanted === "string" && wanted !== p.suggested && p.harnesses.includes(wanted)) return { harness: wanted, amended: true };
  return { harness: p.suggested, amended: false };
}
