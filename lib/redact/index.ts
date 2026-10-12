// Secret redaction for journal rows, issue exports and outgoing messenger
// replies. Pure, no I/O. Masks two things: values of secret-named keys
// (token/secret/password/api keys/authorization/cookie/private keys,
// case-insensitive) and known token shapes inside strings (sk-…, ghp_…,
// xox…-, Bearer …, AKIA…, JWTs, PEM private-key blocks).
//
// The journal is hot, so every entry point first runs one cheap regex test
// and returns the input untouched when nothing looks secret.
export const REDACTED = "[REDACTED]";

// Shared with harness-config's looksSecret: import these there so both use one
// source. looksSecret stays broader on purpose (import-time detection also
// hides long opaque strings); journal redaction below is narrower so UUIDs,
// short commit SHAs, Korean text and secret *paths* pass through.
export const SECRET_KEY_RE = /(key|token|secret|passw|auth|credential|cookie|session|private|bearer)/i;
export const SECRET_VALUE_RE = /^(sk-|ghp_|gho_|ghs_|github_pat_|xox[abpr]-|glpat-|AIza|Bearer\s|Basic\s)/;

// Key names masked in objects. Deliberately narrower than SECRET_KEY_RE:
// a field called `keyboard` or `monkey` is not a secret.
const KEY_NAME_RE = /(token|secret|passwd|password|api[_-]?key|authorization|cookie|private[_-]?key)/i;

// Gate: one test over the JSON text decides whether a traversal is needed.
// Broad on purpose (a hit only costs a traversal, never a wrong mask).
const NEEDS_REDACT_RE =
  /token|secret|passwd|api[_-]?key|authoriz|cookie|private[_-]?key|credential|bearer|sk-|ghp_|gho_|ghs_|github_pat_|xox[abpr]-|akia|eyj|begin [^-]*private key/i;

// Gate for plain strings (no key names: redactString cannot see keys).
const STRING_HINT_RE =
  /sk-|ghp_|gho_|ghs_|github_pat_|xox[abpr]-|akia|eyj|bearer\s|begin [^-]*private key|(password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]/i;

const VALUE_PATTERNS: RegExp[] = [
  // PEM private-key block, whole block incl. body.
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*-----/g,
  // JWT: eyJ header . payload . signature.
  /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(ghp_[A-Za-z0-9_]+|gho_[A-Za-z0-9_]+|ghs_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g,
  /\bxox[abpr]-[A-Za-z0-9-]+/g,
  /\bBearer\s+[A-Za-z0-9\-._~+/=]+/g,
];

/** `password=hunter2` → `password=[REDACTED]`; the label stays, the value goes. */
const ASSIGNMENT_RE = /(password|passwd|pwd|secret|token|api[_-]?key)(\s*[:=]\s*)["']?[^\s"' ,;}\]]+/gi;

/** True when the string holds anything worth a closer look. */
export function hasCandidates(s: string): boolean {
  return STRING_HINT_RE.test(s);
}

/** Masks known token shapes and `name=value` assignments in a string. */
export function redactString(s: string): string {
  if (!STRING_HINT_RE.test(s)) return s;
  let out = s;
  for (const re of VALUE_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, REDACTED);
  }
  ASSIGNMENT_RE.lastIndex = 0;
  return out.replace(ASSIGNMENT_RE, (_, name: string, sep: string) => `${name}${sep}${REDACTED}`);
}

/** Values that name a file are fine; only their contents are secret. */
function isPathValue(s: string): boolean {
  return s.startsWith("~/") || s.startsWith("/") || s.startsWith("./") || s.startsWith("../") || /^[A-Za-z]:[\\/]/.test(s);
}

function maskNamedValue(value: unknown): unknown {
  if (typeof value === "string") {
    const r = redactString(value);
    if (r !== value) return r;
    if (isPathValue(value)) return value;
    return REDACTED;
  }
  if (Array.isArray(value)) return value.map(maskNamedValue);
  if (value && typeof value === "object") return redactObject(value as Record<string, unknown>);
  return value === null || value === undefined ? value : REDACTED;
}

function redactObject(o: Record<string, unknown>): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    const next = KEY_NAME_RE.test(k) ? maskNamedValue(v) : redactValue(v);
    out[k] = next;
    if (next !== v) changed = true;
  }
  return changed ? out : o;
}

/**
 * Deep-masks secrets in a JSON value. Returns the input reference when
 * nothing was masked.
 */
export function redactValue<T>(v: T): T {
  if (typeof v === "string") return redactString(v) as T;
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((e) => {
      const next = redactValue(e);
      if (next !== e) changed = true;
      return next;
    });
    return (changed ? out : v) as T;
  }
  if (v && typeof v === "object") return redactObject(v as Record<string, unknown>) as T;
  return v;
}

/** True when the JSON text of a body needs a redaction pass. */
export function needsRedactPass(jsonText: string): boolean {
  return NEEDS_REDACT_RE.test(jsonText);
}
