// Use cases of the harness-config plugin, written against ports only.
//   plan    per-target added/changed/removed (redacted) plus a planId that pins the exact bytes to write
//   apply   needs that planId and an approvalId; re-plans, refuses if anything moved, backs up, writes
//   import  builds a source.json draft from what the harness files hold now; never copies secrets;
//           read-only unless `write: true`
//   list    source items with their targets, and managed/unmanaged names per harness file
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import {
  diffInstructions,
  diffServers,
  diffSize,
  emptyDiff,
  importInstructions,
  importServers,
  type DesiredServer,
  type Found,
  type FoundInstructions,
  type ImportConflict,
  type SectionDiff,
} from "../domain/diff.ts";
import { isHarness, routes, toServer, validateSource, type HarnessId, type McpServer, type Source } from "../domain/model.ts";
import type { Clock, Events, FileSystem, HarnessConfigFile, SecretResolver } from "../ports/index.ts";

export interface ServiceDeps {
  fs: FileSystem;
  clock: Clock;
  secrets: SecretResolver;
  events?: Events;
  files: HarnessConfigFile<McpServer | string>[];
  /** Absolute path of source.json. */
  sourcePath: string;
  /** Used to expand `~/` in instruction fragment paths. */
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

export interface Plan {
  planId: string;
  sourcePath: string;
  ok: boolean;
  /** Total added + changed + removed across targets. */
  changes: number;
  targets: TargetPlan[];
}

interface Computed {
  plan: Plan;
  writes: { file: HarnessConfigFile<any>; before: string | null; after: string }[];
}

const sha = (s: string | null) => (s === null ? "-" : createHash("sha256").update(s).digest("hex"));
const message = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 500);

export function createService(deps: ServiceDeps) {
  const { fs, files } = deps;

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

  function selectFiles(harnesses?: string[]) {
    if (!harnesses?.length) return files;
    for (const h of harnesses) if (!isHarness(h)) throw new Error(`unknown harness: ${h}`);
    return files.filter((f) => harnesses.includes(f.target.harness));
  }

  const fragmentPath = (p: string) =>
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
      const text = await fs.read(fragmentPath(i.file));
      if (text === null) errors.push(`instruction ${name}: fragment ${i.file} not found`);
      else desired[name] = text;
    }
    return desired;
  }

  async function compute(p: PlanParams): Promise<Computed> {
    const source = await loadSource();
    const force = !!p.force;
    const targets: TargetPlan[] = [];
    const writes: Computed["writes"] = [];
    for (const file of selectFiles(p.harnesses)) {
      const tp: TargetPlan = { target: file.target.id, harness: file.target.harness, path: file.path, exists: false, diff: emptyDiff() };
      targets.push(tp);
      const before = await fs.read(file.path);
      tp.exists = before !== null;
      const errors: string[] = [];
      try {
        const current = file.read(before);
        const isMcp = file.target.section === "mcpServers";
        const declared = new Set(Object.keys(isMcp ? source.mcpServers : source.instructions));
        const { diff, change } = isMcp
          ? diffServers(await desiredServers(source, file, errors), current as Record<string, McpServer>, declared)
          : diffInstructions(await desiredInstructions(source, file, errors), current as Record<string, string>, declared);
        tp.diff = diff;
        if (errors.length) {
          tp.error = errors.join("; ");
          continue;
        }
        if (diffSize(diff) > 0) writes.push({ file, before, after: file.render(before, change as any, { force }) });
      } catch (err) {
        tp.error = message(err);
      }
    }
    const changes = targets.reduce((n, t) => n + diffSize(t.diff), 0);
    const pin = JSON.stringify({
      force,
      targets: targets.map((t) => [t.target, t.error ?? null]),
      writes: writes.map((w) => [w.file.target.id, sha(w.before), sha(w.after)]),
    });
    const plan: Plan = {
      planId: createHash("sha256").update(pin).digest("hex").slice(0, 16),
      sourcePath: deps.sourcePath,
      ok: targets.every((t) => !t.error),
      changes,
      targets,
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
      // Last check right before writing: the file must still hold what we planned against.
      if ((await fs.read(w.file.path)) !== w.before) throw new Error(`${w.file.path} changed during apply; ${applied.length} file(s) already written`);
      const backup = w.before === null ? null : await fs.backup(w.file.path, `me-backup-${stamp}`);
      await fs.write(w.file.path, w.after);
      applied.push({ target: w.file.target.id, path: w.file.path, backup });
    }
    const summary = plan.targets
      .filter((t) => diffSize(t.diff) > 0)
      .map((t) => ({ target: t.target, added: t.diff.added.length, changed: t.diff.changed.length, removed: t.diff.removed.length }));
    await deps.events?.emit("applied", { planId: plan.planId, approvalId: p.approvalId, targets: summary });
    return { planId: plan.planId, approvalId: p.approvalId, applied };
  }

  /** Read-only unless `write` is set; then writes source.draft.json (never source.json) and fragments. */
  async function importDraft(p: { write?: boolean; harnesses?: string[] } = {}) {
    const found: Found[] = [];
    const foundInstr: FoundInstructions[] = [];
    const counts: Record<string, { entries: number } | { error: string }> = {};
    for (const file of selectFiles(p.harnesses)) {
      try {
        const entries = file.read(await fs.read(file.path));
        counts[file.target.id] = { entries: Object.keys(entries).length };
        if (file.target.section === "mcpServers")
          found.push({ harness: file.target.harness, scope: file.target.scope, servers: entries as Record<string, McpServer> });
        else foundInstr.push({ harness: file.target.harness, blocks: entries as Record<string, string> });
      } catch (err) {
        counts[file.target.id] = { error: message(err) };
      }
    }
    const servers = importServers(found);
    const instr = importInstructions(foundInstr);
    const conflicts: Record<string, ImportConflict> = { ...servers.conflicts };
    for (const [name, c] of Object.entries(instr.conflicts)) conflicts[`instructions.${name}`] = c;
    const draft = {
      _import: {
        at: deps.clock.now().toISOString(),
        note: "Draft. env/header values are ${env:NAME} references, not the original values; conflicting names are left out.",
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
    const items = (section: "mcpServers" | "instructions") =>
      Object.fromEntries(
        Object.entries<{ share: any; scope?: any }>(source?.[section] ?? {}).map(([name, item]) => [
          name,
          { share: item.share, targets: files.filter((f) => f.target.section === section && routes(item, f.target)).map((f) => f.target.id) },
        ]),
      );
    const out = [];
    for (const file of files) {
      try {
        const names = Object.keys(file.read(await fs.read(file.path)));
        const declared = new Set(Object.keys(source?.[file.target.section] ?? {}));
        out.push({ target: file.target.id, path: file.path, managed: names.filter((n) => declared.has(n)), unmanaged: names.filter((n) => !declared.has(n)) });
      } catch (err) {
        out.push({ target: file.target.id, path: file.path, error: message(err) });
      }
    }
    return {
      sourcePath: deps.sourcePath,
      ...(sourceError ? { sourceError } : {}),
      source: { mcpServers: items("mcpServers"), instructions: items("instructions") },
      files: out,
    };
  }

  return { plan, apply, import: importDraft, list };
}

export type Service = ReturnType<typeof createService>;
