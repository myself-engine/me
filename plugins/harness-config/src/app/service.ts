// Use cases of the harness-config plugin, written against ports only.
//   plan    per-target added/changed/removed (redacted) plus a planId that pins the exact bytes to write
//   apply   needs that planId and an approvalId; re-plans, refuses if anything moved, backs up, writes
//   import  builds a source.json draft from what the harness files hold now; never copies secrets;
//           read-only unless `write: true`
//   list    source items with their targets, and managed/unmanaged names per harness file
//   source.get    the source with secret values redacted (references stay, literals become "<set>")
//   source.update set one server's share list, remove a server, or add/edit a server from fields;
//           secret-looking values become ${file:...} references (stored 0600), never source literals
//   draft.adopt   turns source.draft.json into source.json once every conflict has a picked side
//   apply.request pins a fresh plan, asks the kernel approval gate, and applies on approve (like ops actions)
// Skills are directories, so they go through SkillStore instead of the text codec, but follow the same
// plan / pin / backup / write steps. Sections a harness cannot hold (see targets.ts) are reported as
// `unsupported` with the items they skip; they are not errors, so a hook shared with "all" still applies.
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, sep } from "node:path";
import {
  diffHooks,
  diffInstructions,
  diffServers,
  diffSize,
  diffSkills,
  emptyDiff,
  hasRef,
  importInstructions,
  importServers,
  normText,
  placeholderize,
  redactUrl,
  type Change,
  type DesiredServer,
  type DesiredSkill,
  type Found,
  type FoundInstructions,
  type FoundSecret,
  type ImportConflict,
  type SectionDiff,
  type SkillState,
} from "../domain/diff.ts";
import {
  isHarness,
  nativeEnvRefs,
  routes,
  sharedWith,
  toHook,
  toServer,
  validateShare,
  validateSource,
  type HarnessId,
  type Hook,
  type McpServer,
  type Section,
  type Share,
  type Source,
  type SourceServer,
  type Target,
} from "../domain/model.ts";
import type { Approvals, Clock, Events, FileSystem, HarnessConfigFile, SecretResolver, SkillsDir, SkillStore, Unsupported } from "../ports/index.ts";

export interface ServiceDeps {
  fs: FileSystem;
  clock: Clock;
  secrets: SecretResolver;
  events?: Events;
  /** Without it, `apply.request` refuses (the CLI has none; the kernel plugin wires the gate). */
  approvals?: Approvals;
  skills: SkillStore;
  files: HarnessConfigFile<McpServer | string | Hook>[];
  skillDirs: SkillsDir[];
  /** Harness sections that are never written; plan and list name the items they skip. */
  unsupported?: Unsupported[];
  /** Absolute path of source.json. */
  sourcePath: string;
  /** Used to expand `~/` in instruction fragment and skill paths. */
  home: string;
}

export interface PlanParams {
  /** Limit to these harnesses; default all. */
  harnesses?: string[];
  /** Allow renders that lose comments (see the Codex adapter). */
  force?: boolean;
}

export interface ApplyParams extends PlanParams {
  planId: string;
  /** Id of the kernel approval the caller obtained for this apply. */
  approvalId: string;
}

export interface TargetPlan {
  target: string;
  harness: HarnessId;
  path: string;
  exists: boolean;
  diff: SectionDiff;
  /** Set when this target cannot be rendered; apply refuses while any target has one. */
  error?: string;
}

export interface UnsupportedPlan {
  target: string;
  harness: HarnessId;
  reason: string;
  /** Source items shared with this harness that it cannot receive. */
  skipped: string[];
}

export interface Plan {
  planId: string;
  sourcePath: string;
  ok: boolean;
  /** Total added + changed + removed across targets. */
  changes: number;
  targets: TargetPlan[];
  unsupported: UnsupportedPlan[];
}

type Write =
  | { kind: "file"; target: Target; file: HarnessConfigFile<any>; before: string | null; after: string }
  /** `before` is the planned state of every touched entry; apply re-inspects and compares it. */
  | { kind: "skills"; target: Target; dir: SkillsDir; before: string; change: Change<DesiredSkill> };

interface Computed {
  plan: Plan;
  writes: Write[];
}

const sha = (s: string | null) => (s === null ? "-" : createHash("sha256").update(s).digest("hex"));
const message = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 500);

export function createService(deps: ServiceDeps) {
  const { fs, files, skillDirs } = deps;
  const unsupported = deps.unsupported ?? [];

  async function loadSource(): Promise<Source> {
    const text = await fs.read(deps.sourcePath);
    if (text === null) throw new Error(`no source at ${deps.sourcePath}; run import to draft one`);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(`${deps.sourcePath} is not valid JSON: ${message(err)}`);
    }
    return validateSource(raw);
  }

  function select<T extends { target: { harness: HarnessId } }>(list: T[], harnesses?: string[]): T[] {
    if (!harnesses?.length) return list;
    for (const h of harnesses) if (!isHarness(h)) throw new Error(`unknown harness: ${h}`);
    return list.filter((x) => harnesses.includes(x.target.harness));
  }

  /** Expands a path written in source.json: `~/` against home, relative against source.json's directory. */
  const sourceRelative = (p: string) =>
    p.startsWith("~/") ? join(deps.home, p.slice(2)) : isAbsolute(p) ? p : join(dirname(deps.sourcePath), p);

  async function resolveMap(m: Record<string, string> | undefined, where: string, errors: string[], harness: HarnessId) {
    if (!m) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(m)) {
      try {
        out[k] = await deps.secrets.resolve(nativeEnvRefs(v, harness));
      } catch (err) {
        errors.push(`${where}.${k}: ${message(err)}`);
      }
    }
    return out;
  }

  async function desiredServers(source: Source, file: HarnessConfigFile<any>, errors: string[]) {
    const desired: Record<string, DesiredServer> = {};
    for (const [name, s] of Object.entries(source.mcpServers)) {
      if (!routes(s, file.target)) continue;
      const display = toServer(s);
      const resolved: McpServer = { ...display };
      if (display.env) resolved.env = await resolveMap(display.env, `${name}.env`, errors, file.target.harness);
      if (display.headers) resolved.headers = await resolveMap(display.headers, `${name}.headers`, errors, file.target.harness);
      desired[name] = { display, resolved };
    }
    return desired;
  }

  async function desiredInstructions(source: Source, file: HarnessConfigFile<any>, errors: string[]) {
    const desired: Record<string, string> = {};
    for (const [name, i] of Object.entries(source.instructions)) {
      if (!routes(i, file.target)) continue;
      const text = await fs.read(sourceRelative(i.file));
      if (text === null) errors.push(`instruction ${name}: fragment ${i.file} not found`);
      else desired[name] = text;
    }
    return desired;
  }

  function desiredHooks(source: Source, file: HarnessConfigFile<any>) {
    const desired: Record<string, Hook> = {};
    for (const [name, h] of Object.entries(source.hooks)) if (routes(h, file.target)) desired[name] = toHook(h);
    return desired;
  }

  const stateKey = (states: Record<string, SkillState | null>) => JSON.stringify(Object.entries(states).sort(([a], [b]) => (a < b ? -1 : 1)));

  async function inspectAll(dir: SkillsDir, names: string[]) {
    const out: Record<string, SkillState | null> = {};
    for (const name of names) out[name] = await deps.skills.inspect(join(dir.path, name));
    return out;
  }

  async function desiredSkills(source: Source, dir: SkillsDir, errors: string[]) {
    const desired: Record<string, DesiredSkill> = {};
    const realDir = (await deps.skills.realpath(dir.path)) ?? dir.path;
    for (const [name, k] of Object.entries(source.skills)) {
      if (!routes(k, dir.target)) continue;
      const src = sourceRelative(k.dir);
      const real = await deps.skills.realpath(src);
      if (real === null) {
        errors.push(`skill ${name}: directory ${k.dir} not found`);
        continue;
      }
      const skillFile = await deps.skills.inspect(join(real, "SKILL.md"));
      if (skillFile?.kind !== "file" && skillFile?.kind !== "link") {
        errors.push(`skill ${name}: ${k.dir} has no SKILL.md`);
        continue;
      }
      // Replacing the entry would delete the source itself.
      if (real === realDir || real.startsWith(realDir + sep)) {
        errors.push(`skill ${name}: ${k.dir} lies inside ${dir.path}`);
        continue;
      }
      const mode = k.mode ?? "link";
      const state: SkillState = mode === "link" ? { kind: "link", target: real } : (await deps.skills.inspect(real))!;
      desired[name] = { mode, source: src, state };
    }
    return desired;
  }

  function unsupportedPlan(source: Source, harnesses?: string[]): UnsupportedPlan[] {
    return select(unsupported.map((u) => ({ ...u, target: { harness: u.harness } })), harnesses).map((u) => ({
      target: `${u.harness}:${u.section}`,
      harness: u.harness,
      reason: u.reason,
      skipped: Object.entries<{ share: any }>(source[u.section])
        .filter(([, item]) => sharedWith(item.share, u.harness))
        .map(([name]) => name),
    }));
  }

  async function compute(p: PlanParams): Promise<Computed> {
    const source = await loadSource();
    const force = !!p.force;
    const targets: TargetPlan[] = [];
    const writes: Write[] = [];
    for (const file of select(files, p.harnesses)) {
      const tp: TargetPlan = { target: file.target.id, harness: file.target.harness, path: file.path, exists: false, diff: emptyDiff() };
      targets.push(tp);
      const before = await fs.read(file.path);
      tp.exists = before !== null;
      const errors: string[] = [];
      try {
        const current = file.read(before);
        const section = file.target.section;
        const declared = new Set(Object.keys(source[section]));
        const { diff, change } =
          section === "mcpServers"
            ? diffServers(await desiredServers(source, file, errors), current as Record<string, McpServer>, declared)
            : section === "hooks"
              ? diffHooks(desiredHooks(source, file), current as Record<string, Hook>, declared)
              : diffInstructions(await desiredInstructions(source, file, errors), current as Record<string, string>, declared);
        tp.diff = diff;
        if (errors.length) {
          tp.error = errors.join("; ");
          continue;
        }
        if (diffSize(diff) > 0) writes.push({ kind: "file", target: file.target, file, before, after: file.render(before, change as any, { force }) });
      } catch (err) {
        tp.error = message(err);
      }
    }
    for (const dir of select(skillDirs, p.harnesses)) {
      const tp: TargetPlan = { target: dir.target.id, harness: dir.target.harness, path: dir.path, exists: false, diff: emptyDiff() };
      targets.push(tp);
      const errors: string[] = [];
      try {
        tp.exists = (await deps.skills.realpath(dir.path)) !== null;
        const declared = new Set(Object.keys(source.skills));
        const present = (await deps.skills.names(dir.path)).filter((n) => declared.has(n));
        const current = Object.fromEntries(
          Object.entries(await inspectAll(dir, present)).filter((e): e is [string, SkillState] => e[1] !== null),
        );
        const { diff, change } = diffSkills(await desiredSkills(source, dir, errors), current, declared);
        tp.diff = diff;
        if (errors.length) {
          tp.error = errors.join("; ");
          continue;
        }
        const touched = [...Object.keys(change.upsert), ...change.remove];
        if (touched.length) writes.push({ kind: "skills", target: dir.target, dir, before: stateKey(await inspectAll(dir, touched)), change });
      } catch (err) {
        tp.error = message(err);
      }
    }
    const changes = targets.reduce((n, t) => n + diffSize(t.diff), 0);
    const pin = JSON.stringify({
      force,
      targets: targets.map((t) => [t.target, t.error ?? null]),
      writes: writes.map((w) =>
        w.kind === "file" ? [w.target.id, sha(w.before), sha(w.after)] : [w.target.id, sha(w.before), sha(JSON.stringify(w.change))],
      ),
    });
    const plan: Plan = {
      planId: createHash("sha256").update(pin).digest("hex").slice(0, 16),
      sourcePath: deps.sourcePath,
      ok: targets.every((t) => !t.error),
      changes,
      targets,
      unsupported: unsupportedPlan(source, p.harnesses),
    };
    return { plan, writes };
  }

  async function plan(p: PlanParams = {}): Promise<Plan> {
    return (await compute(p)).plan;
  }

  async function apply(p: ApplyParams) {
    if (typeof p?.approvalId !== "string" || !p.approvalId.trim()) throw new Error("approvalId is required: obtain kernel approval before apply");
    if (typeof p.planId !== "string" || !p.planId) throw new Error("planId is required: run plan first and apply the planId it returned");
    const { plan, writes } = await compute(p);
    if (plan.planId !== p.planId) throw new Error("plan is stale: source or harness files changed since plan; run plan again");
    const failed = plan.targets.filter((t) => t.error);
    if (failed.length) throw new Error(`refusing to apply: ${failed.map((t) => `${t.target}: ${t.error}`).join("; ")}`);
    const stamp = deps.clock.now().toISOString().replace(/[:.]/g, "-");
    const applied: { target: string; path: string; backup: string | null }[] = [];
    for (const w of writes) {
      if (w.kind === "skills") {
        applied.push({ target: w.target.id, path: w.dir.path, backup: await applySkills(w, stamp, applied.length) });
        continue;
      }
      // Last check right before writing: the file must still hold what we planned against.
      if ((await fs.read(w.file.path)) !== w.before) throw new Error(`${w.file.path} changed during apply; ${applied.length} file(s) already written`);
      const backup = w.before === null ? null : await fs.backup(w.file.path, `me-backup-${stamp}`);
      await fs.write(w.file.path, w.after);
      applied.push({ target: w.target.id, path: w.file.path, backup });
    }
    const summary = plan.targets
      .filter((t) => diffSize(t.diff) > 0)
      .map((t) => ({ target: t.target, added: t.diff.added.length, changed: t.diff.changed.length, removed: t.diff.removed.length }));
    await deps.events?.emit("applied", { planId: plan.planId, approvalId: p.approvalId, targets: summary });
    return { planId: plan.planId, approvalId: p.approvalId, applied };
  }

  /** Backs up every touched entry into one directory beside the skills directory, then installs or removes. */
  async function applySkills(w: Extract<Write, { kind: "skills" }>, stamp: string, done: number): Promise<string | null> {
    const touched = [...Object.keys(w.change.upsert), ...w.change.remove];
    if (stateKey(await inspectAll(w.dir, touched)) !== w.before) throw new Error(`${w.dir.path} changed during apply; ${done} target(s) already written`);
    let backupDir: string | null = null;
    for (const name of touched) {
      const b = await deps.skills.backup(w.dir.path, name, `me-backup-${stamp}`);
      if (b) backupDir = dirname(b);
    }
    for (const [name, d] of Object.entries(w.change.upsert)) await deps.skills.install(w.dir.path, name, d.source, d.mode);
    for (const name of w.change.remove) await deps.skills.remove(w.dir.path, name);
    return backupDir;
  }

  /** Reads every harness file's owned section, for import and draft.adopt. Values stay as read here. */
  async function readFound(harnesses?: string[]) {
    const found: Found[] = [];
    const foundInstr: FoundInstructions[] = [];
    const counts: Record<string, { entries: number } | { error: string }> = {};
    for (const file of select(files, harnesses)) {
      try {
        const entries = file.read(await fs.read(file.path));
        counts[file.target.id] = { entries: Object.keys(entries).length };
        if (file.target.section === "mcpServers")
          found.push({ harness: file.target.harness, scope: file.target.scope, servers: entries as Record<string, McpServer> });
        else if (file.target.section === "instructions") foundInstr.push({ harness: file.target.harness, blocks: entries as Record<string, string> });
      } catch (err) {
        counts[file.target.id] = { error: message(err) };
      }
    }
    // Skills and hooks are counted, not drafted: hooks only carry a name once me has written them,
    // and a skill directory is better declared by hand than copied.
    for (const dir of select(skillDirs, harnesses)) counts[dir.target.id] = { entries: (await deps.skills.names(dir.path)).length };
    return { found, foundInstr, counts };
  }

  /** Content fingerprint of every owned entry, so draft.adopt notices when files moved since import. */
  function fingerprintFound(found: Found[], foundInstr: FoundInstructions[]) {
    const fp: Record<string, string> = {};
    for (const f of found) for (const [n, s] of Object.entries(f.servers)) fp[`mcp:${f.harness}:${f.scope}:${n}`] = sha(JSON.stringify(s));
    for (const f of foundInstr) for (const [n, t] of Object.entries(f.blocks)) fp[`instructions:${f.harness}:${n}`] = sha(normText(t));
    return fp;
  }

  /** Read-only unless `write` is set; then writes source.draft.json (never source.json) and fragments. */
  async function importDraft(p: { write?: boolean; harnesses?: string[] } = {}) {
    const { found, foundInstr, counts } = await readFound(p.harnesses);
    const servers = importServers(found);
    const instr = importInstructions(foundInstr);
    const conflicts: Record<string, ImportConflict> = { ...servers.conflicts };
    for (const [name, c] of Object.entries(instr.conflicts)) conflicts[`instructions.${name}`] = c;
    const draft = {
      _import: {
        at: deps.clock.now().toISOString(),
        note: "Draft. Secret-looking env/header values are ${file:~/.config/me/secrets/mcp/...} references (written 0600 with --write), other values are kept as they are; conflicting names are left out. Skills and hooks are not imported; declare them by hand.",
        conflicts,
        harnesses: p.harnesses ?? null,
        fingerprint: fingerprintFound(found, foundInstr),
      },
      mcpServers: servers.mcpServers,
      instructions: Object.fromEntries(Object.entries(instr.instructions).map(([n, i]) => [n, { file: `instructions/${n}.md`, share: i.share }])),
    };
    let written: string | null = null;
    const secretsKept: string[] = [];
    if (p.write === true) {
      // Never overwrites source.json itself; the user reviews and renames the draft.
      const dir = dirname(deps.sourcePath);
      written = join(dir, "source.draft.json");
      for (const [n, i] of Object.entries(instr.instructions)) await fs.write(join(dir, "instructions", `${n}.md`), `${i.content}\n`);
      // New files are created 0600 by the FileSystem port. A different existing secret is kept, not overwritten.
      for (const sec of servers.secrets) {
        const path = join(deps.home, sec.path);
        const cur = await fs.read(path);
        if (cur === null) await fs.write(path, `${sec.value}\n`);
        else if (cur.replace(/\r?\n$/, "") !== sec.value) secretsKept.push(`~/${sec.path}`);
      }
      await fs.write(written, `${JSON.stringify(draft, null, 2)}\n`);
    }
    // Paths only: secret values never leave this function.
    return { draft, conflicts, counts, written, secrets: servers.secrets.map((x) => `~/${x.path}`), ...(secretsKept.length ? { secretsKept } : {}) };
  }

  async function list() {
    let source: Source | null = null;
    let sourceError: string | undefined;
    try {
      source = await loadSource();
    } catch (err) {
      sourceError = message(err);
    }
    const allTargets = [...files, ...skillDirs].map((x) => x.target);
    const items = (section: Section) =>
      Object.fromEntries(
        Object.entries<{ share: any; scope?: any }>(source?.[section] ?? {}).map(([name, item]) => [
          name,
          { share: item.share, targets: allTargets.filter((t) => t.section === section && routes(item, t)).map((t) => t.id) },
        ]),
      );
    const out = [];
    const entry = (target: Target, path: string, exists: boolean, names: string[]) => {
      const declared = new Set(Object.keys(source?.[target.section] ?? {}));
      return { target: target.id, path, exists, managed: names.filter((n) => declared.has(n)), unmanaged: names.filter((n) => !declared.has(n)) };
    };
    for (const file of files) {
      try {
        const text = await fs.read(file.path);
        out.push(entry(file.target, file.path, text !== null, Object.keys(file.read(text))));
      } catch (err) {
        out.push({ target: file.target.id, path: file.path, exists: false, error: message(err) });
      }
    }
    for (const dir of skillDirs) {
      try {
        out.push(entry(dir.target, dir.path, ((await deps.skills.realpath(dir.path)) ?? null) !== null, await deps.skills.names(dir.path)));
      } catch (err) {
        out.push({ target: dir.target.id, path: dir.path, exists: false, error: message(err) });
      }
    }
    return {
      sourcePath: deps.sourcePath,
      ...(sourceError ? { sourceError } : {}),
      source: { mcpServers: items("mcpServers"), instructions: items("instructions"), skills: items("skills"), hooks: items("hooks") },
      files: out,
      unsupported: source ? unsupportedPlan(source) : unsupported.map((u) => ({ target: `${u.harness}:${u.section}`, harness: u.harness, reason: u.reason, skipped: [] })),
    };
  }
  const stamp = () => deps.clock.now().toISOString().replace(/[:.]/g, "-");

  /**
   * The source with secret values redacted: `${env:...}` and `${file:...}` references stay readable
   * (they name no value), literal values become "<set>", URLs are redacted like in plan.
   * A hand-edited literal secret therefore never leaves this function.
   */
  function redactSource(source: Source): Source {
    const hide = (m: Record<string, string> | undefined) =>
      m === undefined ? undefined : Object.fromEntries(Object.entries(m).map(([k, v]) => [k, hasRef(v) ? v : "<set>"]));
    return {
      ...source,
      mcpServers: Object.fromEntries(
        Object.entries(source.mcpServers).map(([name, s]) => [
          name,
          { ...s, ...(s.url ? { url: redactUrl(s.url) } : {}), ...(s.env ? { env: hide(s.env)! } : {}), ...(s.headers ? { headers: hide(s.headers)! } : {}) },
        ]),
      ),
    };
  }

  async function getSource(): Promise<{ sourcePath: string; exists: boolean; source: Source }> {
    const text = await fs.read(deps.sourcePath);
    if (text === null) return { sourcePath: deps.sourcePath, exists: false, source: { mcpServers: {}, instructions: {}, skills: {}, hooks: {} } };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(`${deps.sourcePath} is not valid JSON: ${message(err)}`);
    }
    return { sourcePath: deps.sourcePath, exists: true, source: redactSource(validateSource(raw)) };
  }

  /** Stores placeholderized secrets 0600 under home. An existing different secret is kept, not overwritten. */
  async function storeSecrets(secrets: FoundSecret[]) {
    const paths: string[] = [];
    const kept: string[] = [];
    for (const sec of secrets) {
      const path = join(deps.home, sec.path);
      const cur = await fs.read(path);
      if (cur === null) await fs.write(path, `${sec.value}\n`);
      else if (cur.replace(/\r?\n$/, "") !== sec.value) kept.push(`~/${sec.path}`);
      paths.push(`~/${sec.path}`);
    }
    return { secrets: paths, ...(kept.length ? { secretsKept: kept } : {}) };
  }

  /** Builds one source server entry from screen fields. Pure: secrets come back separately for storing. */
  function buildServer(name: string, s: any, prev?: SourceServer): { entry: SourceServer; secrets: FoundSecret[] } {
    if (!s || typeof s !== "object") throw new Error(`${name}: server fields are required`);
    const share = validateShare(s.share, `${name}.share`);
    const scope = s.scope === undefined ? prev?.scope : s.scope;
    if (scope !== undefined && scope !== "user" && scope !== "project") throw new Error(`${name}: scope must be user or project`);
    // A blank value keeps the entry's current value (so a stored secret survives an edit untouched);
    // a key left out of the map is removed.
    const keep = (next: unknown, old: Record<string, string> | undefined, where: string) => {
      if (next === undefined) return old && Object.keys(old).length ? { ...old } : undefined;
      if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error(`${name}.${where} must map names to strings`);
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(next as Record<string, unknown>)) {
        if (typeof v !== "string") throw new Error(`${name}.${where}.${k} must be a string`);
        if (v === "") {
          if (old?.[k] !== undefined) out[k] = old[k]!;
        } else out[k] = v;
      }
      return Object.keys(out).length ? out : undefined;
    };
    let base: McpServer;
    if (s.kind === "command") {
      const command = typeof s.command === "string" ? s.command.trim() : "";
      if (!command) throw new Error(`${name}: command is required`);
      const args = s.args === undefined ? (prev?.args ?? []) : s.args;
      if (!Array.isArray(args) || !args.every((a: unknown) => typeof a === "string")) throw new Error(`${name}: args must be a list of strings`);
      base = { type: "stdio", command, ...(args.length ? { args } : {}) };
    } else if (s.kind === "url") {
      const url = typeof s.url === "string" ? s.url.trim() : "";
      if (!url) throw new Error(`${name}: url is required`);
      base = { type: "http", url };
    } else throw new Error(`${name}: kind must be command or url`);
    const env = keep(s.env, prev?.env, "env");
    const headers = keep(s.headers, prev?.headers, "headers");
    const { server, secrets } = placeholderize(name, { ...base, ...(env ? { env } : {}), ...(headers ? { headers } : {}) });
    return { entry: { ...server, share, ...(scope ? { scope } : {}) }, secrets };
  }

  async function updateSource(p: { op?: unknown; name?: unknown; share?: unknown; server?: unknown }) {
    if (!p || typeof p !== "object") throw new Error("op is required: setShare, remove or upsert");
    const op = (p as any).op;
    const name = (p as any).name;
    if (typeof name !== "string" || !/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("name may only use letters, digits, . _ -");
    const text = await fs.read(deps.sourcePath);
    let raw: any = { mcpServers: {}, instructions: {}, skills: {}, hooks: {} };
    if (text !== null) {
      try {
        raw = JSON.parse(text);
      } catch (err) {
        throw new Error(`${deps.sourcePath} is not valid JSON: ${message(err)}`);
      }
    }
    const source = validateSource(raw);
    let secrets: FoundSecret[] = [];
    if (op === "setShare") {
      const cur = source.mcpServers[name];
      if (!cur) throw new Error(`unknown server: ${name}`);
      source.mcpServers[name] = { ...cur, share: validateShare((p as any).share, `${name}.share`) };
    } else if (op === "remove") {
      if (!source.mcpServers[name]) throw new Error(`unknown server: ${name}`);
      delete source.mcpServers[name];
    } else if (op === "upsert") {
      const built = buildServer(name, (p as any).server, source.mcpServers[name]);
      source.mcpServers[name] = built.entry;
      secrets = built.secrets;
    } else throw new Error(`unknown op: ${String(op)} (setShare, remove or upsert)`);
    const next = validateSource(source);
    const stored = await storeSecrets(secrets);
    // Two edits in the same millisecond share a stamp; the next free suffix wins.
    let backup: string | null = null;
    if (text !== null) {
      const base = `me-backup-${stamp()}`;
      for (let i = 0; ; i++) {
        try {
          backup = await fs.backup(deps.sourcePath, i ? `${base}-${i}` : base);
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== "EEXIST" || i > 5) throw err;
        }
      }
    }
    await fs.write(deps.sourcePath, `${JSON.stringify(next, null, 2)}\n`);
    return { sourcePath: deps.sourcePath, backup, source: redactSource(next), ...stored };
  }

  async function adoptDraft(p: { resolutions?: Record<string, string> } = {}) {
    const dir = dirname(deps.sourcePath);
    const draftPath = join(dir, "source.draft.json");
    const draftText = await fs.read(draftPath);
    if (draftText === null) throw new Error(`no draft at ${draftPath}; run import with write first`);
    let draft: any;
    try {
      draft = JSON.parse(draftText);
    } catch (err) {
      throw new Error(`${draftPath} is not valid JSON: ${message(err)}`);
    }
    const draftConflicts: Record<string, ImportConflict> | undefined = draft?._import?.conflicts;
    if (!draftConflicts || typeof draftConflicts !== "object" || Array.isArray(draftConflicts))
      throw new Error(`${draftPath} has no import conflicts; run import again`);
    if ((await fs.read(deps.sourcePath)) !== null) throw new Error(`source already exists at ${deps.sourcePath}; edit it instead of adopting`);
    const harnesses = Array.isArray(draft?._import?.harnesses) ? draft._import.harnesses : undefined;
    const { found, foundInstr } = await readFound(harnesses);
    const liveServers = importServers(found);
    const liveInstr = importInstructions(foundInstr);
    const liveConflicts: Record<string, ImportConflict> = { ...liveServers.conflicts };
    for (const [n, c] of Object.entries(liveInstr.conflicts)) liveConflicts[`instructions.${n}`] = c;
    const before = Object.keys(draftConflicts).sort();
    const liveKeys = Object.keys(liveConflicts).sort();
    if (JSON.stringify(before) !== JSON.stringify(liveKeys)) throw new Error("draft is stale: harness files changed since import; run import again");
    const printed = draft?._import?.fingerprint;
    if (!printed || typeof printed !== "object") throw new Error("draft is stale: it has no content fingerprint; run import again");
    const canon = (o: Record<string, string>) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
    if (canon(printed) !== canon(fingerprintFound(found, foundInstr))) throw new Error("draft is stale: harness files changed since import; run import again");
    const resolutions = p?.resolutions ?? {};
    const unresolved = before.filter((k) => typeof resolutions[k] !== "string" || !liveConflicts[k]!.targets.includes(resolutions[k]!));
    if (unresolved.length) throw new Error(`unresolved conflicts: ${unresolved.join(", ")} (pick one side per conflict)`);
    const mcpServers: Record<string, unknown> = { ...(draft.mcpServers ?? {}) };
    const instructions: Record<string, unknown> = { ...(draft.instructions ?? {}) };
    const adopted: string[] = [];
    const pickedSecrets: FoundSecret[] = [];
    for (const key of before) {
      const pick = resolutions[key]!;
      if (key.startsWith("instructions.")) {
        const n = key.slice("instructions.".length);
        const side = foundInstr
          .flatMap((f) => Object.entries(f.blocks).map(([bn, text]) => ({ harness: f.harness, name: bn, text })))
          .find((e) => e.name === n && `${e.harness}:instructions` === pick);
        if (!side) throw new Error(`${key}: no such side: ${pick}`);
        await fs.write(join(dir, "instructions", `${n}.md`), `${normText(side.text)}\n`);
        instructions[n] = { file: `instructions/${n}.md`, share: [side.harness] };
      } else {
        const side = found
          .flatMap((f) => Object.entries(f.servers).map(([bn, server]) => ({ harness: f.harness, scope: f.scope, name: bn, server })))
          .find((e) => e.name === key && `${e.harness}:${e.scope}` === pick);
        if (!side) throw new Error(`${key}: no such side: ${pick}`);
        const { server, secrets } = placeholderize(key, side.server);
        pickedSecrets.push(...secrets);
        const item: Record<string, unknown> = { ...server, share: [side.harness] as Share };
        if (side.scope === "project") item.scope = "project";
        mcpServers[key] = item;
      }
      adopted.push(key);
    }
    const next = validateSource({ mcpServers, instructions, skills: {}, hooks: {} });
    const stored = await storeSecrets(pickedSecrets);
    await fs.write(deps.sourcePath, `${JSON.stringify(next, null, 2)}\n`);
    return { sourcePath: deps.sourcePath, adopted: adopted.sort(), ...stored };
  }

  /** At most one approval-gated apply is in flight; a second request refuses instead of stacking approvals. */
  let applyInflight: Promise<void> | null = null;

  async function requestApply(p: PlanParams = {}) {
    if (applyInflight) throw new Error("an apply is already waiting or running");
    const { plan } = await compute(p);
    const failed = plan.targets.filter((t) => t.error);
    if (failed.length) throw new Error(`refusing to apply: ${failed.map((t) => `${t.target}: ${t.error}`).join("; ")}`);
    if (plan.changes === 0) return { requested: false as const, reason: "nothing to change", plan };
    if (!deps.approvals) throw new Error("approvals are not available in this harness-config instance");
    const summary = `실행 도구 설정 적용: ${plan.changes}곳 바뀜`;
    const params = { harnesses: p.harnesses, force: p.force };
    const slot: { cur: Promise<void> | null } = { cur: null };
    slot.cur = (async () => {
      try {
        const decision = await deps.approvals!.request({ summary, risk: "medium", payload: { kind: "harness-config.apply", planId: plan.planId }, expiresInSec: 600 });
        if (decision.decision === "approve") await apply({ ...params, planId: plan.planId, approvalId: decision.approvalId });
      } catch (err) {
        console.error(`[harness-config] apply.request failed: ${message(err)}`);
      } finally {
        if (applyInflight === slot.cur) applyInflight = null;
      }
    })();
    applyInflight = slot.cur;
    return { requested: true as const, summary, plan };
  }

  return { plan, apply, import: importDraft, list, getSource, updateSource, adoptDraft, requestApply };
}

export type Service = ReturnType<typeof createService>;
