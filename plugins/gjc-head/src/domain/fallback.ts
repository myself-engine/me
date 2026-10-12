// Classifies head-model failures for model fallback. Pure: error in, short
// reason out, or null when another model would fail the same way.
// Eligible: quota/rate limits, expired auth, model unavailable, provider
// 5xx/network. Not eligible: context too long, refused content (including the
// Anthropic/ToS refusal), tool-guard violations, user cancel. Not-eligible
// patterns win when both match.
export type FallbackReason = "quota" | "auth-expired" | "model-unavailable" | "provider-error";

const textOf = (err: unknown) => (typeof err === "string" ? err : String((err as Error)?.message ?? err));

const NOT_ELIGIBLE =
  /context[\s\S]{0,30}(too long|length|exceed|overflow|limit)|token[\s\S]{0,30}(exceed|limit|too many)|maximum context|context_window|prompt too long|input too (long|large)|refus|not allowed inside GJC|Claude Code에서만|Anthropic|content (policy|filter)|moderat|safety|blocked by|policy violation|tried to use tool|guard.?violation|run aborted|abort|cancel/i;

const QUOTA_RE = /429|rate.?limit|quota|too many requests|temporarily unavailable/i;
const AUTH_RE =
  /provider login expired|login[\s\S]{0,40}expir|expir[\s\S]{0,40}(login|token|auth)|authentication[\s\S]{0,40}(expir|token)|unauthorized|\b401\b|invalid (api key|token)|refresh/i;
const MODEL_RE =
  /model[_-](not_supported|not_found|unavailable)|model[\s\S]{0,40}not (supported|found|available)|unknown model|unsupported model|model does not exist|no such model|invalid model/i;
const PROVIDER_RE =
  /\b5\d\d\b|internal server error|bad gateway|service unavailable|gateway timeout|overloaded|provider (unavailable|outage|error)|connection (reset|refused|timed out)|socket hang up|fetch failed|network error|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i;

/** Short reason when retrying on another model may help, else null. */
export function fallbackReason(err: unknown): FallbackReason | null {
  const text = textOf(err);
  if (NOT_ELIGIBLE.test(text)) return null;
  if (QUOTA_RE.test(text)) return "quota";
  if (AUTH_RE.test(text)) return "auth-expired";
  if (MODEL_RE.test(text)) return "model-unavailable";
  if (PROVIDER_RE.test(text)) return "provider-error";
  return null;
}

/** True when the failure is worth retrying on another model. */
export const isFallbackEligible = (err: unknown): boolean => fallbackReason(err) !== null;
