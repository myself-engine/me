// me adapt, bridge stage for command-line tools: wraps configured commands as plugin cli-<name>
// through the generic CLI bridge (bridges/cli). No code is generated, only a manifest.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createPipePair } from "@me/protocol";
import { definePlugin } from "@me/sdk";
import { Kernel, validateManifest } from "@me/kernel";
import { renderManifest, validateConfig, type CliConfig } from "../../bridges/cli/src/config.ts";
import { confirmPermissions, registerLocally, type GateOptions } from "./adapt.ts";

const ID_RE = /^[a-z][a-z0-9-]*$/;

export interface AdaptCliResult {
  pluginId: string;
  manifestPath: string;
  methods: string[];
  /** Result of calling the first command, when it could be called without params. */
  probe?: unknown;
}

export async function adaptCli(root: string, name: string, configFile: string, opts: GateOptions = {}): Promise<AdaptCliResult> {
  const pluginId = name.startsWith("cli-") ? name : `cli-${name}`;
  if (!ID_RE.test(pluginId)) throw new Error(`invalid name: ${name} (lowercase letters, digits, hyphens)`);
  const dir = join(root, "plugins", pluginId);
  const manifestPath = join(dir, "plugin.json");
  if (existsSync(manifestPath)) throw new Error(`${relative(root, manifestPath)} already exists`);

  const file = resolve(configFile);
  const raw: any = await Bun.file(file).json();
  // Relative cwds in the file are relative to the file; with none, commands run where `me adapt` was run.
  const config: CliConfig = validateConfig({
    commands: raw?.commands,
    cwd: typeof raw?.cwd === "string" ? resolve(dirname(file), raw.cwd) : process.cwd(),
  });
  const manifest = renderManifest(pluginId, config, relative(dir, join(root, "bridges", "cli", "src", "main.ts")));

  // Install-time permission gate (the bridge runs commands, so it always declares shell).
  await confirmPermissions(pluginId, manifest.permissions, opts);

  // Contract check before registering; the plugin directory is the plugin's working directory.
  mkdirSync(dir, { recursive: true });
  let probe: unknown;
  try {
    probe = await probeCli(manifest, dir, config);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  await registerLocally(root, pluginId, { commands: config.commands, cwd: config.cwd });
  return { pluginId, manifestPath, methods: manifest.provides.methods, ...(probe !== undefined ? { probe } : {}) };
}

/** Starts the bridge in a scratch kernel; calls the first command if it needs no params. */
async function probeCli(manifest: ReturnType<typeof renderManifest>, dir: string, config: CliConfig): Promise<unknown> {
  const scratch = mkdtempSync(join(tmpdir(), "me-adapt-"));
  const kernel = new Kernel({ dataDir: scratch, log: () => {}, pluginConfig: { [manifest.id]: config as any } });
  try {
    await kernel.spawn(validateManifest(manifest, dir));
    const state = kernel.pluginState(manifest.id);
    if (state !== "running") {
      const log = Bun.file(join(scratch, "logs", `${manifest.id}.log`));
      const tail = (await log.exists()) ? (await log.text()).trim().split("\n").slice(-8).join("\n") : "(no log)";
      throw new Error(`bridge did not start (state: ${state})\n${tail}`);
    }
    const [first, cmd] = Object.entries(config.commands)[0]!;
    if (Object.values(cmd.params ?? {}).some((p) => p.required)) return undefined;
    const caller = definePlugin({});
    const [k, p] = createPipePair();
    void caller.run(p);
    await kernel.attach(
      validateManifest({ id: "adapt-probe", version: "0", protocol: { min: 1, max: 1 }, run: { command: ["true"] }, permissions: [`call:${manifest.id}`] }, dir),
      k,
    );
    return await caller.invoke(manifest.id, first, {}, { timeoutMs: (cmd.timeoutMs ?? 25_000) + 5_000 });
  } finally {
    await kernel.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function usage() {
  return [
    "usage: me adapt cli <name> <config.json>",
    "",
    "  Wraps the commands in <config.json> ({ \"commands\": { <method>: { argv, params, ... } } })",
    "  as plugin cli-<name> through the generic CLI bridge, checks it starts (and runs the first",
    "  command when it needs no params), then registers it in me.local.json.",
  ].join("\n");
}
