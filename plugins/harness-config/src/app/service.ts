// Use cases of the harness-config plugin, written against ports only.
//   plan    per-target added/changed/removed (redacted) plus a planId that pins the exact bytes to write
//   apply   needs that planId and an approvalId; re-plans, refuses if anything moved, backs up, writes
//   import  builds a source.json draft from what the harness files hold now; never copies secrets;
//           read-only unless `write: true`
//   list    source items with their targets, and managed/unmanaged names per harness file
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
  importInstructions,
  importServers,
  type Change,
  type DesiredServer,
  type DesiredSkill,
  type Found,
  type FoundInstructions,
  type ImportConflict,
  type SectionDiff,
  type SkillState,
} from "../domain/diff.ts";
import {
  isHarness,
  routes,
  sharedWith,
  toHook,
  toServer,
  validateSource,
  type HarnessId,
  type Hook,
  type McpServer,
  type Section,
  type Source,
  type Target,
} from "../domain/model.ts";
import type { Clock, Events, FileSystem, HarnessConfigFile, SecretResolver, SkillsDir, SkillStore, Unsupported } from "../ports/index.ts";

export interface ServiceDeps {
  fs: FileSystem;
  clock: Clock;
  secrets: SecretResolver;
  events?: Events;
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

  async function resolveMap(m: Record<string, string> | undefined, where: string, errors: string[]) {
    if (!m) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(m)) {
      try {
        out[k] = await deps.secrets.resolve(v);
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
      if (display.env) resolved.env = await resolveMap(display.env, `${name}.env`, errors);
      if (display.headers) resolved.headers = await resolveMap(display.headers, `${name}.headers`, errors);
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

  /** Read-only unless `write` is set; then writes source.draft.json (never source.json) and fragments. */
  async function importDraft(p: { write?: boolean; harnesses?: string[] } = {}) {
    const found: Found[] = [];
    const foundInstr: FoundInstructions[] = [];
    const counts: Record<string, { entries: number } | { error: string }> = {};
    for (const file of select(files, p.harnesses)) {
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
    for (const dir of select(skillDirs, p.harnesses)) counts[dir.target.id] = { entries: (await deps.skills.names(dir.path)).length };
    const servers = importServers(found);
    const instr = importInstructions(foundInstr);
    const conflicts: Record<string, ImportConflict> = { ...servers.conflicts };
    for (const [name, c] of Object.entries(instr.conflicts)) conflicts[`instructions.${name}`] = c;
    const draft = {
      _import: {
        at: deps.clock.now().toISOString(),
        note: "Draft. env/header values are ${env:NAME} references, not the original values; conflicting names are left out. Skills and hooks are not imported; declare them by hand.",
        conflicts,
      },
      mcpServers: servers.mcpServers,
      instructions: Object.fromEntries(Object.entries(instr.instructions).map(([n, i]) => [n, { file: `instructions/${n}.md`, share: i.share }])),
    };
    let written: string | null = null;
    if (p.write === true) {
      // Never overwrites source.json itself; the user reviews and renames the draft.
      const dir = dirname(deps.sourcePath);
      written = join(dir, "source.draft.json");
      for (const [n, i] of Object.entries(instr.instructions)) await fs.write(join(dir, "instructions", `${n}.md`), `${i.content}\n`);
      await fs.write(written, `${JSON.stringify(draft, null, 2)}\n`);
    }
    return { draft, conflicts, counts, written };
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
    const entry = (target: Target, path: string, names: string[]) => {
      const declared = new Set(Object.keys(source?.[target.section] ?? {}));
      return { target: target.id, path, managed: names.filter((n) => declared.has(n)), unmanaged: names.filter((n) => !declared.has(n)) };
    };
    for (const file of files) {
      try {
        out.push(entry(file.target, file.path, Object.keys(file.read(await fs.read(file.path)))));
      } catch (err) {
        out.push({ target: file.target.id, path: file.path, error: message(err) });
      }
    }
    for (const dir of skillDirs) {
      try {
        out.push(entry(dir.target, dir.path, await deps.skills.names(dir.path)));
      } catch (err) {
        out.push({ target: dir.target.id, path: dir.path, error: message(err) });
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

  return { plan, apply, import: importDraft, list };
}

export type Service = ReturnType<typeof createService>;
