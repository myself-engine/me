// Kernel entry point: `bun run kernel/src/main.ts [config.json]`.
// Config lists plugin manifests (relative to the config file) and per-plugin config.
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Kernel } from "./kernel.ts";
import { loadManifest } from "./manifest.ts";

interface Config {
  dataDir?: string;
  plugins: string[];
  pluginConfig?: Record<string, Record<string, any>>;
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
  // Machine-specific plugins (e.g. from `me adapt`) are appended, not substituted.
  config.plugins = [...new Set([...config.plugins, ...(((local as any).extraPlugins as string[]) ?? [])])];
  for (const [id, cfg] of Object.entries(local.pluginConfig ?? {})) {
    config.pluginConfig = { ...config.pluginConfig, [id]: { ...config.pluginConfig?.[id], ...cfg } };
  }
}
const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : resolve(base, p));
const dataDir = expand(process.env.ME_HOME ?? config.dataDir ?? "~/.me");

const kernel = new Kernel({ dataDir, pluginConfig: config.pluginConfig });
console.error(`[kernel] data dir ${dataDir}`);

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
