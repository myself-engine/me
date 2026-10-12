// Shared child-process environment allowlist. Every spawn site (kernel plugin
// processes, MCP/ACP/CLI bridge children, brgr git/harness spawns) builds the
// child's env with childEnv so a secret sitting in the parent's environment
// never leaks into an unattended child. Explicit values (manifest run.env,
// bridge env/envFiles) always win over the allowlist.
const BASE_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TZ",
  "TMPDIR",
  "TERM",
  "COLORTERM",
  "SSH_AUTH_SOCK",
]);

const BASE_PREFIXES = ["LC_", "XDG_", "HERDR_", "ME_"];

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** True when `name` is kept for every child without being listed. */
export function isBaseEnv(name: string): boolean {
  return BASE_NAMES.has(name) || BASE_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Validates an `envPass` list: exact names (`HOME`) or `PREFIX_*` globs
 * (`MYAPP_*`). The bare `"*"` wildcard is refused, as is `*` anywhere else.
 * Returns the list unchanged so callers can store it.
 */
export function validateEnvPass(pass: unknown): string[] {
  if (!Array.isArray(pass)) throw new Error("envPass must be an array of strings");
  for (const entry of pass) {
    if (typeof entry !== "string" || !entry) throw new Error(`envPass entries must be non-empty strings, got ${JSON.stringify(entry)}`);
    if (!entry.includes("*")) {
      if (!ENV_NAME_RE.test(entry)) throw new Error(`envPass has an invalid variable name: ${entry}`);
      continue;
    }
    if (entry === "*") throw new Error('envPass refuses the "*" wildcard; list names or PREFIX_* globs instead');
    if (!entry.endsWith("*") || entry.indexOf("*") !== entry.length - 1) {
      throw new Error(`envPass globs must be PREFIX_* (a trailing star only): ${entry}`);
    }
    const prefix = entry.slice(0, -1);
    if (!prefix || !ENV_NAME_RE.test(prefix)) throw new Error(`envPass has an invalid prefix in ${entry}`);
  }
  return pass as string[];
}

/**
 * Builds a child's environment: the base set plus names matched by `pass`,
 * overlaid with `extra` (manifest run.env, bridge env, secret files).
 * `from` defaults to the current process's environment.
 */
export function childEnv(
  pass: string[] = [],
  extra: Record<string, string> = {},
  from: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const allow = new Set<string>();
  const prefixes = [...BASE_PREFIXES];
  for (const entry of validateEnvPass(pass)) {
    if (entry.endsWith("*")) prefixes.push(entry.slice(0, -1));
    else allow.add(entry);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(from)) {
    if (v === undefined) continue;
    if (BASE_NAMES.has(k) || allow.has(k) || prefixes.some((p) => k.startsWith(p))) out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) out[k] = v;
  return out;
}
