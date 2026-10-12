// Merge rules, plan diffs, redaction and conflict detection. Pure.
//
// Ownership rule (stateless): the source owns an entry in a harness file only by name.
//   added    = routed to this target, missing from the file
//   changed  = routed to this target, present but different
//   removed  = present in the file, declared in source, but its share/scope excludes this target
// Names the source does not declare are never touched; `list` reports them as unmanaged.
// Inside an owned entry only the neutral fields (type/command/args/env/url/headers) are owned;
// adapters keep harness-only fields such as Codex `startup_timeout_sec` or GJC `sharing`.
// The same rules apply to hooks (identified by a marker the adapter appends to the command) and
// to skills (identified by their entry name in a harness's skills directory).
import type { HarnessId, Hook, McpServer, Scope, SkillMode } from "./model.ts";

export const REF_RE = /\$\{(env|file):([^}]+)\}/g;
export const hasRef = (v: string) => new RegExp(REF_RE.source).test(v);

export interface FieldChange {
  field: string;
  /** Redacted. Absent = field did not exist. */
  before?: unknown;
  after?: unknown;
}

export interface SectionDiff {
  added: { name: string; after: Record<string, unknown> }[];
  changed: { name: string; fields: FieldChange[] }[];
  removed: { name: string }[];
  unchanged: string[];
}

export interface Change<T> {
  upsert: Record<string, T>;
  remove: string[];
}

export const emptyDiff = (): SectionDiff => ({ added: [], changed: [], removed: [], unchanged: [] });
export const diffSize = (d: SectionDiff) => d.added.length + d.changed.length + d.removed.length;

const SECRET_MAPS = ["env", "headers"] as const;

/** Strips userinfo and the query string; remote MCP URLs sometimes carry tokens there. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}${u.search ? "?<redacted>" : ""}`;
  } catch {
    return "<unparsed url>";
  }
}

/** A secret value as shown in a plan: references are safe to show, literal values never are. */
const showSecret = (v: string | undefined) => (v === undefined ? undefined : hasRef(v) ? v : "<set>");

/** Flattens a server into comparable fields: `type`, `command`, `args`, `url`, `env.K`, `headers.K`. */
function fields(s: McpServer): Map<string, unknown> {
  const m = new Map<string, unknown>([["type", s.type]]);
  if (s.command !== undefined) m.set("command", s.command);
  if (s.args) m.set("args", s.args);
  if (s.url !== undefined) m.set("url", s.url);
  for (const k of SECRET_MAPS) for (const [key, v] of Object.entries(s[k] ?? {})) m.set(`${k}.${key}`, v);
  return m;
}

const isSecretField = (f: string) => f.startsWith("env.") || f.startsWith("headers.");

function show(field: string, v: unknown, fromSource: boolean): unknown {
  if (v === undefined) return undefined;
  if (isSecretField(field)) return fromSource ? showSecret(v as string) : "<set>";
  if (field === "url") return redactUrl(v as string);
  return v;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Redacted view of a server, for `added` entries and import conflicts. */
export function redactServer(s: McpServer, fromSource: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [f, v] of fields(s)) out[f] = show(f, v, fromSource);
  return out;
}

/** Names of the fields that differ between two servers (values are never included). */
export function differingFields(a: McpServer, b: McpServer): string[] {
  const fa = fields(a);
  const fb = fields(b);
  return [...new Set([...fa.keys(), ...fb.keys()])].filter((f) => !same(fa.get(f), fb.get(f))).sort();
}

export interface DesiredServer {
  /** As written in source.json (references unresolved); used for display only. */
  display: McpServer;
  /** References resolved; compared against and written into the harness file. */
  resolved: McpServer;
}

/**
 * Diffs one target's MCP section. `desired` holds the servers routed to this target; `declared`
 * holds every server name in source (routed anywhere) and decides what may be removed.
 */
export function diffServers(
  desired: Record<string, DesiredServer>,
  current: Record<string, McpServer>,
  declared: ReadonlySet<string>,
): { diff: SectionDiff; change: Change<McpServer> } {
  const diff = emptyDiff();
  const change: Change<McpServer> = { upsert: {}, remove: [] };
  for (const [name, d] of Object.entries(desired)) {
    const cur = current[name];
    if (!cur) {
      diff.added.push({ name, after: redactServer(d.display, true) });
      change.upsert[name] = d.resolved;
      continue;
    }
    const names = differingFields(cur, d.resolved);
    if (names.length === 0) {
      diff.unchanged.push(name);
      continue;
    }
    const before = fields(cur);
    const shown = fields(d.display);
    diff.changed.push({
      name,
      fields: names.map((f) => ({ field: f, before: show(f, before.get(f), false), after: show(f, shown.get(f), true) })),
    });
    change.upsert[name] = d.resolved;
  }
  for (const name of Object.keys(current)) {
    if (declared.has(name) && !(name in desired)) {
      diff.removed.push({ name });
      change.remove.push(name);
    }
  }
  return { diff, change };
}

export const normText = (t: string) => t.replace(/\r\n/g, "\n").trim();

/** Same rules as diffServers for managed instruction blocks; content is shown as a line count only. */
export function diffInstructions(
  desired: Record<string, string>,
  current: Record<string, string>,
  declared: ReadonlySet<string>,
): { diff: SectionDiff; change: Change<string> } {
  const diff = emptyDiff();
  const change: Change<string> = { upsert: {}, remove: [] };
  const lines = (t: string) => `${normText(t).split("\n").length} lines`;
  for (const [name, text] of Object.entries(desired)) {
    const cur = current[name];
    if (cur === undefined) {
      diff.added.push({ name, after: { content: lines(text) } });
      change.upsert[name] = normText(text);
    } else if (normText(cur) !== normText(text)) {
      diff.changed.push({ name, fields: [{ field: "content", before: lines(cur), after: lines(text) }] });
      change.upsert[name] = normText(text);
    } else diff.unchanged.push(name);
  }
  for (const name of Object.keys(current)) {
    if (declared.has(name) && !(name in desired)) {
      diff.removed.push({ name });
      change.remove.push(name);
    }
  }
  return { diff, change };
}

/** Same rules for hooks. Commands are shown as written; source commands hold no references. */
export function diffHooks(
  desired: Record<string, Hook>,
  current: Record<string, Hook>,
  declared: ReadonlySet<string>,
): { diff: SectionDiff; change: Change<Hook> } {
  const diff = emptyDiff();
  const change: Change<Hook> = { upsert: {}, remove: [] };
  const KEYS = ["event", "matcher", "command", "timeout"] as const;
  const view = (h: Hook) => Object.fromEntries(KEYS.filter((k) => h[k] !== undefined).map((k) => [k, h[k]]));
  for (const [name, h] of Object.entries(desired)) {
    const cur = current[name];
    if (!cur) {
      diff.added.push({ name, after: view(h) });
      change.upsert[name] = h;
      continue;
    }
    const fields = KEYS.filter((k) => !same(cur[k], h[k])).map((k) => ({ field: k, before: cur[k], after: h[k] }));
    if (fields.length === 0) diff.unchanged.push(name);
    else {
      diff.changed.push({ name, fields });
      change.upsert[name] = h;
    }
  }
  for (const name of Object.keys(current)) {
    if (declared.has(name) && !(name in desired)) {
      diff.removed.push({ name });
      change.remove.push(name);
    }
  }
  return { diff, change };
}

/** What sits at `<skills dir>/<name>`. Link targets are real paths, so links through a dotfile stack compare equal. */
export type SkillState = { kind: "link"; target: string } | { kind: "dir"; files: number; hash: string } | { kind: "file" };

export interface DesiredSkill {
  mode: SkillMode;
  /** Absolute source directory, as written (not resolved); a link points here. */
  source: string;
  /** The state an installed copy or link must have. */
  state: SkillState;
}

const skillView = (s: SkillState): Record<string, unknown> =>
  s.kind === "link"
    ? { mode: "link", target: s.target }
    : s.kind === "dir"
      ? { mode: "copy", content: `${s.files} files #${s.hash.slice(0, 8)}` }
      : { mode: "file" };

/** Same rules for skills; a copied skill's content is shown as a file count and a short hash only. */
export function diffSkills(
  desired: Record<string, DesiredSkill>,
  current: Record<string, SkillState>,
  declared: ReadonlySet<string>,
): { diff: SectionDiff; change: Change<DesiredSkill> } {
  const diff = emptyDiff();
  const change: Change<DesiredSkill> = { upsert: {}, remove: [] };
  for (const [name, d] of Object.entries(desired)) {
    const cur = current[name];
    const after: Record<string, unknown> = { ...skillView(d.state), ...(d.mode === "link" ? { target: d.source } : {}) };
    if (!cur) {
      diff.added.push({ name, after });
      change.upsert[name] = d;
    } else if (same(cur, d.state)) diff.unchanged.push(name);
    else {
      const before = skillView(cur);
      const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
      diff.changed.push({
        name,
        fields: keys.filter((k) => !same(before[k], after[k])).map((k) => ({ field: k, before: before[k], after: after[k] })),
      });
      change.upsert[name] = d;
    }
  }
  for (const name of Object.keys(current)) {
    if (declared.has(name) && !(name in desired)) {
      diff.removed.push({ name });
      change.remove.push(name);
    }
  }
  return { diff, change };
}

// ---------- import ----------

export interface Found {
  harness: HarnessId;
  scope: Scope;
  servers: Record<string, McpServer>;
}

export interface ImportConflict {
  /** Where the name appears, e.g. `codex:user`. */
  targets: string[];
  /** Fields that differ between at least two of them (names only). */
  fields: string[];
}

const envName = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** Where import keeps a secret it found in a harness file, relative to home (`${file:~/...}`). */
export const SECRET_DIR = ".config/me/secrets/mcp";

const SECRET_KEY = /(key|token|secret|passw|auth|credential|cookie|session|private|bearer)/i;
const SECRET_VALUE = /^(sk-|ghp_|gho_|ghs_|github_pat_|xox[abpr]-|glpat-|AIza|Bearer\s|Basic\s)/;
/**
 * A value worth hiding: a secret-sounding name, a known token shape, or a long opaque string.
 * Paths, flags, URLs and short words stay literal so a re-render reproduces them exactly.
 */
export function looksSecret(key: string, value: string): boolean {
  if (SECRET_KEY.test(key) || SECRET_VALUE.test(value)) return true;
  return value.length >= 32 && !/[\s/:.]/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value);
}

export interface FoundSecret {
  /** Path under home, e.g. `.config/me/secrets/mcp/lazyweb-AUTHORIZATION`. */
  path: string;
  value: string;
}

/**
 * Makes a server safe to store in source.json. References stay references (OpenCode's `{env:X}` and
 * Claude's `${X}` become `${env:X}`); secrets become `${file:~/...}` references and are returned
 * separately so the caller can store them 0600; plain values stay literal.
 */
export function placeholderize(name: string, s: McpServer): { server: McpServer; secrets: FoundSecret[] } {
  const out: McpServer = { ...s };
  const secrets: FoundSecret[] = [];
  const ref = (key: string, v: string) => {
    if (/^\$\{(env|file):[^}]+\}$/.test(v)) return v;
    const m = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(v) ?? /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(v);
    if (m) return `\${env:${m[1]}}`;
    if (!looksSecret(key, v)) return v;
    const path = `${SECRET_DIR}/${name.replace(/[^\w.-]+/g, "_")}-${envName(key)}`;
    secrets.push({ path, value: v });
    return `\${file:~/${path}}`;
  };
  if (s.env) out.env = Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, ref(k, v)]));
  if (s.headers) out.headers = Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [k, ref(k, v)]));
  return { server: out, secrets };
}

export interface ImportResult {
  mcpServers: Record<string, Record<string, unknown>>;
  conflicts: Record<string, ImportConflict>;
  /** Secret values to store; never part of the draft or of any printed result. */
  secrets: FoundSecret[];
}

/**
 * Builds the mcpServers part of a source draft. Names whose content differs between harnesses
 * are conflicts: they are left out of the draft (DECISIONS §15: same name, intentionally different
 * content is normal) so an apply never overwrites one harness's variant with another's.
 */
export function importServers(found: Found[]): ImportResult {
  const byName = new Map<string, { target: string; harness: HarnessId; scope: Scope; server: McpServer }[]>();
  for (const f of found)
    for (const [name, server] of Object.entries(f.servers)) {
      const list = byName.get(name) ?? [];
      list.push({ target: `${f.harness}:${f.scope}`, harness: f.harness, scope: f.scope, server });
      byName.set(name, list);
    }
  const result: ImportResult = { mcpServers: {}, conflicts: {}, secrets: [] };
  const allHarnesses = new Set(found.map((f) => f.harness));
  for (const name of [...byName.keys()].sort()) {
    const variants = byName.get(name)!;
    const first = variants[0]!;
    const diffs = new Set(variants.slice(1).flatMap((v) => differingFields(first.server, v.server)));
    const scopes = new Set(variants.map((v) => v.scope));
    if (diffs.size > 0 || scopes.size > 1) {
      if (scopes.size > 1) diffs.add("scope");
      result.conflicts[name] = { targets: variants.map((v) => v.target), fields: [...diffs].sort() };
      continue;
    }
    const harnesses = [...new Set(variants.map((v) => v.harness))];
    const share = harnesses.length === allHarnesses.size && allHarnesses.size === 4 ? "all" : harnesses;
    const safe = placeholderize(name, first.server);
    result.secrets.push(...safe.secrets);
    const item: Record<string, unknown> = { ...safe.server, share };
    if (first.scope === "project") item.scope = "project";
    result.mcpServers[name] = item;
  }
  return result;
}

export interface FoundInstructions {
  harness: HarnessId;
  blocks: Record<string, string>;
}

export function importInstructions(found: FoundInstructions[]): {
  instructions: Record<string, { content: string; share: HarnessId[] }>;
  conflicts: Record<string, ImportConflict>;
} {
  const out: Record<string, { content: string; share: HarnessId[] }> = {};
  const conflicts: Record<string, ImportConflict> = {};
  const seen = new Map<string, { harness: HarnessId; text: string }[]>();
  for (const f of found)
    for (const [name, text] of Object.entries(f.blocks)) seen.set(name, [...(seen.get(name) ?? []), { harness: f.harness, text: normText(text) }]);
  for (const [name, list] of seen) {
    if (new Set(list.map((l) => l.text)).size > 1) {
      conflicts[name] = { targets: list.map((l) => `${l.harness}:instructions`), fields: ["content"] };
      continue;
    }
    out[name] = { content: list[0]!.text, share: list.map((l) => l.harness) };
  }
  return { instructions: out, conflicts };
}
