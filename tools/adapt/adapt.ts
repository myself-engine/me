// me adapt v0: attach an outside thing to me without writing code.
// Stage order (DECISIONS §8): marketplace → generic bridge → agent-written adapter.
// v0 implements the bridge stage for MCP servers; the other stages report what is missing.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createPipePair } from "@me/protocol";
import { definePlugin } from "@me/sdk";
import { Kernel, validateManifest } from "@me/kernel";

const ID_RE = /^[a-z][a-z0-9-]*$/;

export interface AdaptResult {
  pluginId: string;
  manifestPath: string;
  tools: string[];
}

export async function adaptMcp(
  root: string,
  name: string,
  command: string[],
  opts: { env?: Record<string, string>; cwd?: string } = {},
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

  // Contract check before registering: spawn through a scratch kernel and list tools.
  // The plugin directory must exist because it is the plugin's working directory.
  mkdirSync(dir, { recursive: true });
  let tools: string[];
  try {
    tools = await probe(manifest, dir, server);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
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
    "usage: me adapt mcp <name> -- <command> [args...]",
    "",
    "  Wraps an MCP server as plugin mcp-<name> through the generic MCP bridge,",
    "  checks it starts and lists tools, then registers it in me.local.json.",
    "",
    "  Not in v0: marketplace lookup, cli/http/acp bridges, agent-written adapters.",
  ].join("\n");
}
