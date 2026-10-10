// me adapt stages 1 and 3 (DECISIONS §8): marketplace recipes and agent-written adapters.
// Stage 2 (generic bridges) lives in adapt.ts (MCP) and cli.ts (CLI).
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { adaptMcp, type GateOptions } from "./adapt.ts";
import { adaptCli } from "./cli.ts";

export interface RecipeParam {
  description?: string;
  required?: boolean;
  default?: string;
}

export type Recipe =
  | { name: string; kind: "mcp"; description: string; command: string[]; params?: Record<string, RecipeParam> }
  | { name: string; kind: "cli"; description: string; commands: Record<string, unknown>; cwd?: string };

const NAME_RE = /^[a-z][a-z0-9-]*$/;

export async function listRecipes(root: string): Promise<Recipe[]> {
  const dir = join(root, "marketplace", "recipes");
  const out: Recipe[] = [];
  for await (const f of new Bun.Glob("*.json").scan({ cwd: dir })) out.push((await Bun.file(join(dir, f)).json()) as Recipe);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function findRecipe(root: string, name: string): Promise<Recipe | null> {
  if (!NAME_RE.test(name)) return null;
  const f = Bun.file(join(root, "marketplace", "recipes", `${name}.json`));
  return (await f.exists()) ? ((await f.json()) as Recipe) : null;
}

/** Fills {param} placeholders in an MCP recipe command; only declared params, whole-value substitution. */
export function fillCommand(recipe: Extract<Recipe, { kind: "mcp" }>, set: Record<string, string>): string[] {
  const params = recipe.params ?? {};
  for (const k of Object.keys(set)) if (!(k in params)) throw new Error(`unknown param for ${recipe.name}: ${k}`);
  const values: Record<string, string> = {};
  for (const [k, p] of Object.entries(params)) {
    const v = set[k] ?? p.default;
    if (v === undefined) {
      if (p.required) throw new Error(`missing --set ${k}=… (${p.description ?? "required"})`);
      continue;
    }
    values[k] = v.startsWith("~/") ? join(homedir(), v.slice(2)) : v;
  }
  return recipe.command.map((part) =>
    part.replace(/\{(\w+)\}/g, (_, k: string) => {
      if (!(k in values)) throw new Error(`recipe ${recipe.name} uses undeclared or unset param {${k}}`);
      return values[k]!;
    }),
  );
}

/** Stage 1: install a marketplace recipe through the matching generic bridge. */
export async function installRecipe(root: string, name: string, opts: GateOptions & { set?: Record<string, string> } = {}) {
  const recipe = await findRecipe(root, name);
  if (!recipe) throw new Error(`no marketplace recipe named ${name}`);
  if (recipe.kind === "mcp") {
    const r = await adaptMcp(root, recipe.name, fillCommand(recipe, opts.set ?? {}), opts);
    return { pluginId: r.pluginId, detail: `${r.tools.length} tools (${r.tools.join(", ") || "none"})`, manifestPath: r.manifestPath };
  }
  // CLI recipes hand their commands to adaptCli through a scratch file.
  const scratch = mkdtempSync(join(tmpdir(), "me-recipe-"));
  try {
    const file = join(scratch, "commands.json");
    await Bun.write(file, JSON.stringify({ commands: recipe.commands, ...(recipe.cwd ? { cwd: recipe.cwd } : {}) }));
    const r = await adaptCli(root, recipe.name, file, opts);
    return { pluginId: r.pluginId, detail: `${r.methods.length} commands (${r.methods.join(", ")})`, manifestPath: r.manifestPath };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Turns an adapted plugin back into a recipe so it returns to the marketplace.
 * Env values are dropped: recipes never carry secrets.
 */
export async function exportRecipe(root: string, pluginId: string, description: string): Promise<{ path: string; recipe: Recipe }> {
  const local: any = await Bun.file(join(root, "me.local.json")).json().catch(() => ({}));
  const cfg = local.pluginConfig?.[pluginId];
  if (!cfg) throw new Error(`no local config for ${pluginId}; only adapted plugins can be exported`);
  let recipe: Recipe;
  if (pluginId.startsWith("mcp-") && cfg.server) {
    recipe = { name: pluginId.slice(4), kind: "mcp", description, command: [cfg.server.command, ...(cfg.server.args ?? [])] };
  } else if (pluginId.startsWith("cli-") && cfg.commands) {
    recipe = { name: pluginId.slice(4), kind: "cli", description, commands: cfg.commands };
  } else {
    throw new Error(`${pluginId} is not a bridge-based plugin (mcp-*/cli-*)`);
  }
  const path = join(root, "marketplace", "recipes", `${recipe.name}.json`);
  if (await Bun.file(path).exists()) throw new Error(`recipe ${recipe.name} already exists`);
  await Bun.write(path, JSON.stringify(recipe, null, 2) + "\n");
  return { path, recipe };
}

/** Stage 3 brief: an agent writes a plugin that must pass the conformance suite. */
export function agentBrief(name: string, description: string): string {
  return [
    `Repository: "me", a Bun/TypeScript kernel + plugin system. Read docs/PROTOCOL.md, docs/DECISIONS.md section 8, sdk/src/index.ts, bridges/mcp and bridges/cli (generic bridges) and spec/conformance/run.ts first.`,
    ``,
    `Task: create a new plugin at plugins/${name}/ that adapts the following to me:`,
    description,
    ``,
    `Rules:`,
    `- If a generic bridge (bridges/mcp, bridges/cli) can express it, do not write a plugin; instead write marketplace/recipes/${name}.json in the existing recipe format and explain why.`,
    `- Otherwise write plugins/${name}/plugin.json with the minimum permissions it needs and the code in plugins/${name}/src/. Any language is fine; the plugin speaks the protocol over stdio.`,
    `- Never put secrets in files; read them from a file path given in plugin config.`,
    `- It must pass: bun spec/conformance/run.ts plugins/${name}`,
    `- Add tests that run without network access.`,
    `- Do not modify kernel/, protocol/, sdk/, spec/, other plugins or bridges.`,
    ``,
    `Verify with: bun install && bunx tsc --noEmit -p . && bun test && bun spec/conformance/run.ts plugins/${name}. Commit nothing.`,
  ].join("\n");
}

export interface Runner {
  (argv: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

const spawnRunner: Runner = async (argv, cwd) => {
  const p = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout, stderr };
};

/** Stage 3: delegate writing the adapter to a worker through brgr. Returns the brgr task id. */
export async function agentAdapt(root: string, name: string, description: string, opts: { harness?: string; run?: Runner } = {}) {
  if (!NAME_RE.test(name)) throw new Error(`invalid name: ${name}`);
  if (!description.trim()) throw new Error("describe what to adapt after --");
  const argv = [
    "brgr",
    "run",
    agentBrief(name, description),
    "--harness",
    opts.harness ?? "local.claude-code",
    "--criterion",
    `bun spec/conformance/run.ts plugins/${name} passes, or marketplace/recipes/${name}.json exists with a reason; bun test passes`,
    "--capture-diff",
    "--deadline-seconds",
    "3600",
    "--json",
  ];
  const r = await (opts.run ?? spawnRunner)(argv, root);
  if (r.code !== 0) throw new Error(`brgr run failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return JSON.parse(r.stdout).task_id as string;
}
