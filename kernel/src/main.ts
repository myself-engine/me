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

const configPath = resolve(process.argv[2] ?? process.env.MYSELF_CONFIG ?? "myself.config.json");
const config = (await Bun.file(configPath).json()) as Config;
const base = dirname(configPath);
const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : resolve(base, p));
const dataDir = expand(process.env.MYSELF_HOME ?? config.dataDir ?? "~/.myself");

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
