// me adapt v0: attach an outside thing to me without writing code.
// Stage order (DECISIONS §8): marketplace → generic bridge → agent-written adapter.
// v0 implements the bridge stage for MCP servers; the other stages report what is missing.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { createPipePair } from "@me/protocol";
import { definePlugin } from "@me/sdk";
import { Kernel, validateManifest } from "@me/kernel";
import { formatResult, runConformance } from "../../spec/conformance/run.ts";

const ID_RE = /^[a-z][a-z0-9-]*$/;

export interface AdaptResult {
  pluginId: string;
  manifestPath: string;
  tools: string[];
}

/** How the install-time permission gate asks for confirmation (DECISIONS §16). */
export interface GateOptions {
  /** Pre-approve the declared permissions (`--yes`). */
  yes?: boolean;
  /** Whether a person can answer a prompt. Default: stdin and stdout are TTYs. */
  interactive?: boolean;
  /** Asks one question and returns the answer. Default: a readline prompt on stdin/stdout. */
  ask?: (question: string) => Promise<string>;
  /** Where the permission summary goes. Default: stderr. */
  print?: (line: string) => void;
}

const RISKY: Record<string, string> = {
  shell: "may run any command on this machine",
  network: "may open network connections",
};

async function askTty(question: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** Shows the permissions a manifest declares and throws unless they are confirmed. Writes nothing. */
export async function confirmPermissions(pluginId: string, permissions: string[], opts: GateOptions = {}): Promise<void> {
  const print = opts.print ?? ((l: string) => console.error(l));
  const color = !opts.print && !!process.stderr.isTTY;
  const warn = (s: string) => (color ? `\x1b[1;33m${s}\x1b[0m` : s);
  print(`${pluginId} requests these permissions:`);
  for (const p of permissions) print(p in RISKY ? warn(`  ! ${p} — ${RISKY[p]}`) : `    ${p}`);
  if (permissions.length === 0) print("    (none)");
  if (opts.yes) return;
  const interactive = opts.interactive ?? (!!process.stdin.isTTY && !!process.stdout.isTTY);
  if (!interactive) throw new Error("permissions not confirmed: no TTY to ask on; re-run with --yes to approve them");
  const answer = (await (opts.ask ?? askTty)(`Grant ${permissions.join(", ") || "no permissions"} to ${pluginId}? [y/N] `)).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") throw new Error("permissions not confirmed");
}

export async function adaptMcp(
  root: string,
  name: string,
  command: string[],
  opts: { env?: Record<string, string>; cwd?: string; conformance?: typeof runConformance } & GateOptions = {},
): Promise<AdaptResult> {
  const pluginId = name.startsWith("mcp-") ? name : `mcp-${name}`;
  if (!ID_RE.test(pluginId)) throw new Error(`invalid name: ${name} (lowercase letters, digits, hyphens)`);
  if (command.length === 0) throw new Error("missing MCP server command after --");
  const dir = join(root, "plugins", pluginId);
  const manifestPath = join(dir, "plugin.json");
  if (existsSync(manifestPath)) throw new Error(`${relative(root, manifestPath)} already exists`);

  const bridgeMain = join(root, "bridges", "mcp", "src", "main.ts");
  const manifest = {
    id: pluginId,
    version: "0.1.0",
    protocol: { min: 1, max: 1 },
    run: { command: ["bun", relative(dir, bridgeMain)] },
    permissions: ["network", "shell"],
    provides: { methods: ["tools.list", "tools.call", "resources.list", "resources.read"] },
    restart: { policy: "on-failure", maxRestarts: 5, windowSec: 300 },
  };
  // Relative paths in the command are relative to where `me adapt` was run.
  const server = { command: command[0]!, args: command.slice(1), cwd: opts.cwd ?? process.cwd(), ...(opts.env ? { env: opts.env } : {}) };

  // Install-time permission gate, before anything is written.
  await confirmPermissions(pluginId, manifest.permissions, opts);

  // Contract check before registering: spawn through a scratch kernel and list tools,
  // then run the conformance suite against the generated plugin (DECISIONS §8).
  // The plugin directory must exist because it is the plugin's working directory.
  mkdirSync(dir, { recursive: true });
  let tools: string[];
  try {
    tools = await probe(manifest, dir, server);
    await Bun.write(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    const conformance = await (opts.conformance ?? runConformance)(dir, { config: { server }, initTimeoutMs: 30_000, callTimeoutMs: 30_000 });
    if (!conformance.ok) throw new Error(`conformance failed\n${formatResult(conformance)}`);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  await registerLocally(root, pluginId, server);
  return { pluginId, manifestPath, tools };
}

async function probe(manifest: object, dir: string, server: object): Promise<string[]> {
  const scratch = mkdtempSync(join(tmpdir(), "me-adapt-"));
  const kernel = new Kernel({ dataDir: scratch, log: () => {}, pluginConfig: { [(manifest as any).id]: { server } as any } });
  try {
    await kernel.spawn(validateManifest(manifest, dir));
    const state = kernel.pluginState((manifest as any).id);
    if (state !== "running") {
      const log = Bun.file(join(scratch, "logs", `${(manifest as any).id}.log`));
      const tail = (await log.exists()) ? (await log.text()).trim().split("\n").slice(-8).join("\n") : "(no log)";
      throw new Error(`bridge did not start (state: ${state})\n${tail}`);
    }
    const caller = definePlugin({});
    const [k, p] = createPipePair();
    void caller.run(p);
    await kernel.attach(
      validateManifest({ id: "adapt-probe", version: "0", protocol: { min: 1, max: 1 }, run: { command: ["true"] }, permissions: [`call:${(manifest as any).id}`] }, dir),
      k,
    );
    const tools = await caller.invoke<{ name: string }[]>((manifest as any).id, "tools.list", {}, { timeoutMs: 30_000 });
    return tools.map((t) => t.name);
  } finally {
    await kernel.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Machine-specific registration goes to me.local.json (uncommitted): extraPlugins + pluginConfig. */
async function registerLocally(root: string, pluginId: string, server: object) {
  const path = join(root, "me.local.json");
  const file = Bun.file(path);
  const local: any = (await file.exists()) ? await file.json() : {};
  local.extraPlugins = [...new Set([...(local.extraPlugins ?? []), `plugins/${pluginId}`])];
  local.pluginConfig = { ...(local.pluginConfig ?? {}), [pluginId]: { ...(local.pluginConfig?.[pluginId] ?? {}), server } };
  await Bun.write(path, JSON.stringify(local, null, 2) + "\n");
}

export function usage() {
  return [
    "usage: me adapt mcp [--yes] <name> -- <command> [args...]",
    "",
    "  Wraps an MCP server as plugin mcp-<name> through the generic MCP bridge,",
    "  checks it starts, lists tools and passes the conformance suite, then registers it in me.local.json.",
    "",
    "  The plugin's permissions (shell, network) must be confirmed first: a y/N prompt on a TTY,",
    "  or --yes. Without a TTY and without --yes, nothing is installed.",
    "",
    "  Not in v0: marketplace lookup, cli/http/acp bridges, agent-written adapters.",
  ].join("\n");
}
