// Wires the Discord window: kernel SDK + discord.js adapters around the app. The token is read from
// pluginConfig.discord.tokenFile and never logged.
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Ledger } from "@me/messenger";
import { RpcError, definePlugin } from "@me/sdk";
import { discordJsGateway } from "./adapters/discord-js.ts";
import { kernelPort } from "./adapters/kernel.ts";
import { sqliteCards } from "./adapters/sqlite-cards.ts";
import { createDiscordApp, type DiscordApp } from "./app/service.ts";
import { parseConfig } from "./domain/config.ts";

let app: DiscordApp | null = null;
let initialized!: () => void;
const ready = new Promise<void>((r) => (initialized = r));

const plugin = definePlugin({
  onInit: () => initialized(),
  onEvent(name, data) {
    // Events before start() are picked up by its backlog scan (approval.list, sealed tasks).
    app?.onKernelEvent(name, data);
  },
  onShutdown() {
    app?.stop();
  },
  methods: {
    // One message to the configured default channel, for schedule delivery.
    notify: (p) => {
      if (!app) throw new RpcError(-32603, "discord가 시작되지 않았어요 (tokenFile, ownerId 설정을 확인하세요)");
      const text = (p as { text?: unknown } | null)?.text;
      if (typeof text !== "string" || !text.trim()) throw new RpcError(-32602, "discord.notify에는 {text}가 있어야 해요");
      return app.notify(text);
    },
  },
});

void plugin.run();
await ready;

// A missing or broken setup must not crash-loop the plugin (the kernel would quarantine it).
// Stay connected to the kernel, idle, and say why on stderr (the kernel's plugin log).
async function start(): Promise<void> {
  const config = parseConfig(plugin.config as Record<string, unknown>);
  const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
  const token = readFileSync(expand(config.tokenFile), "utf8").trim();
  if (!token) throw new Error(`token file ${config.tokenFile} is empty`);

  const dataDir = process.env.ME_DATA_DIR ?? ".";
  mkdirSync(dataDir, { recursive: true });
  const ledger = new Ledger(join(dataDir, "ledger.sqlite"));
  const gateway = discordJsGateway(token);
  const created = createDiscordApp({ gateway, kernel: kernelPort(plugin, config), ledger, cards: sqliteCards(ledger.db), config });

  await gateway.connect();
  await created.start();
  app = created;
  console.error(`[discord] connected as ${gateway.botUserId}`);
}

try {
  await start();
} catch (err: any) {
  console.error(`[discord] idle: not started (${err?.message ?? err}). Fix pluginConfig.discord (tokenFile, ownerId) and restart me.`);
}
