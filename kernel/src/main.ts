// Kernel entry point: `bun run kernel/src/main.ts [config.json]`.
// Config lists plugin manifests (relative to the config file) and per-plugin config.
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Permission } from "@me/protocol";
import { Kernel, type JournalOptions } from "./kernel.ts";
import { validateEnvPass } from "@me/env";
import { isPermission, loadManifest } from "./manifest.ts";

interface Config {
  dataDir?: string;
  plugins: string[];
  pluginConfig?: Record<string, Record<string, any>>;
  /** Unix socket for connect-in plugins (exec mode B); default $ME_HOME/kernel.sock, false disables it. */
  socket?: string | false;
  /** Upper bound on what a connect-in plugin is granted; default ["read-state", "emit", "subscribe"]. */
  connectPermissions?: Permission[];
  /** TCP listener for plugins on other machines (tailnet servers); default false. */
  tcp?: false | { host: string; port: number; allowAnyHost?: boolean };
  /** Upper bound for TCP-connected plugins; default connectPermissions. */
  remotePermissions?: Permission[];
  /** User-only escape hatch: extra parent env names kept for every plugin child. Exact names or PREFIX_* globs, no "*". */
  env?: { pass?: string[] };
  /** Journal retention: { maxAgeDays, maxRows, pruneIntervalSec }; defaults 14 days, 200000 rows, hourly. */
  journal?: JournalOptions;
}

const configPath = resolve(process.argv[2] ?? process.env.ME_CONFIG ?? "me.config.json");
const config = (await Bun.file(configPath).json()) as Config;
const base = dirname(configPath);
// Machine-specific overrides (account names, ports) live in an uncommitted sibling file.
const localPath = join(base, "me.local.json");
if (await Bun.file(localPath).exists()) {
  const local = (await Bun.file(localPath).json()) as Partial<Config>;
  if (local.dataDir) config.dataDir = local.dataDir;
  if (local.plugins) config.plugins = local.plugins;
  if (local.socket !== undefined) config.socket = local.socket;
  if (local.connectPermissions) config.connectPermissions = local.connectPermissions;
  if (local.tcp !== undefined) config.tcp = local.tcp;
  if (local.remotePermissions) config.remotePermissions = local.remotePermissions;
  if (local.env !== undefined) config.env = local.env;
  if (local.journal) config.journal = { ...config.journal, ...local.journal };
  // Machine-specific plugins (e.g. from `me adapt`) are appended, not substituted.
  config.plugins = [...new Set([...config.plugins, ...(((local as any).extraPlugins as string[]) ?? [])])];
  for (const [id, cfg] of Object.entries(local.pluginConfig ?? {})) {
    config.pluginConfig = { ...config.pluginConfig, [id]: { ...config.pluginConfig?.[id], ...cfg } };
  }
}
const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : resolve(base, p));
const dataDir = expand(process.env.ME_HOME ?? config.dataDir ?? "~/.me");

if (config.env?.pass !== undefined) {
  try {
    validateEnvPass(config.env.pass);
  } catch (err) {
    throw new Error(`env.pass: ${(err as Error).message}`);
  }
}
const kernel = new Kernel({ dataDir, pluginConfig: config.pluginConfig, journal: config.journal, envPass: config.env?.pass });
console.error(`[kernel] data dir ${dataDir}`);

if (config.socket !== false) {
  const socketPath = config.socket ? expand(config.socket) : join(dataDir, "kernel.sock");
  for (const p of config.connectPermissions ?? []) if (!isPermission(p)) throw new Error(`connectPermissions: unknown permission ${p}`);
  await kernel.listen({ path: socketPath, tokenPath: join(dataDir, "connect.token"), permissions: config.connectPermissions });
  console.error(`[kernel] listening on ${socketPath}`);
}

if (config.tcp) {
  const remotePermissions = config.remotePermissions ?? config.connectPermissions;
  for (const p of remotePermissions ?? []) if (!isPermission(p)) throw new Error(`remotePermissions: unknown permission ${p}`);
  const { host, port, allowAnyHost } = config.tcp;
  const bound = await kernel.listenTcp({ host, port: port ?? 7421, allowAnyHost, tokenPath: join(dataDir, "connect.token"), permissions: remotePermissions });
  console.error(`[kernel] listening on tcp ${bound.address}:${bound.port}`);
}

for (const p of config.plugins) {
  const manifest = await loadManifest(join(expand(p), "plugin.json"));
  void kernel.spawn(manifest).then(() => console.error(`[kernel] ${manifest.id}: ${kernel.pluginState(manifest.id)}`));
}

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  console.error("[kernel] stopping");
  await kernel.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
