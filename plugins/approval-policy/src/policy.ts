// Approval risk tiers (DECISIONS §16): low-risk work such as tests may be approved automatically;
// deploys, DB writes and anything high-risk always wait for the user. Pure rules, no I/O.

export interface PendingApproval {
  approvalId: string;
  requester: string;
  summary: string;
  risk: "low" | "medium" | "high";
  payload?: Record<string, unknown> | null;
}

export interface Rule {
  /** Shown in the journal and the decision note. */
  name: string;
  requester?: string;
  /** Highest risk this rule may auto-approve. High is never auto-approved. */
  maxRisk?: "low" | "medium";
  /** Payload fields that must equal these values (e.g. { role: "test" }). */
  payload?: Record<string, string | number | boolean>;
  /** Regex the summary must match. */
  summary?: string;
}

/** Payload roles that always require a human, whatever the rules say. */
export const ALWAYS_MANUAL_ROLES = ["deploy", "db-write", "release", "secrets"];
const ALWAYS_MANUAL_WORDS = /\b(deploy|production|prod|migrat\w*|drop\s+table|db\s*write|release|publish)\b|배포|운영\s*DB|마이그레이션/i;

const RANK = { low: 0, medium: 1, high: 2 } as const;

export type Verdict = { auto: true; rule: string } | { auto: false; reason: string };

export function evaluate(a: PendingApproval, rules: Rule[]): Verdict {
  if (a.risk === "high") return { auto: false, reason: "high risk always needs the user" };
  const role = typeof a.payload?.role === "string" ? (a.payload.role as string) : null;
  if (role && ALWAYS_MANUAL_ROLES.includes(role)) return { auto: false, reason: `role ${role} always needs the user` };
  if (ALWAYS_MANUAL_WORDS.test(a.summary)) return { auto: false, reason: "summary mentions a deploy, release or DB change" };
  for (const r of rules) {
    if (r.requester && r.requester !== a.requester) continue;
    if (RANK[a.risk] > RANK[r.maxRisk ?? "low"]) continue;
    if (r.payload && !Object.entries(r.payload).every(([k, v]) => a.payload?.[k] === v)) continue;
    if (r.summary && !new RegExp(r.summary, "i").test(a.summary)) continue;
    return { auto: true, rule: r.name };
  }
  return { auto: false, reason: "no rule matched" };
}
