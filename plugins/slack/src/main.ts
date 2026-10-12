// Wires the Slack window: kernel SDK + Slack SDK adapters around the app. Both tokens are read from the
// files named in pluginConfig.slack and never logged.
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Ledger } from "@me/messenger";
import { RpcError, definePlugin } from "@me/sdk";
import { kernelPort } from "./adapters/kernel.ts";
import { slackSdkGateway, type SlackSdkGateway } from "./adapters/slack.ts";
import { sqliteCards } from "./adapters/sqlite-cards.ts";
import { createSlackApp, type SlackApp } from "./app/service.ts";
import { parseConfig } from "./domain/config.ts";

let app: SlackApp | null = null;
let gateway: SlackSdkGateway | null = null;
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
    void gateway?.disconnect().catch(() => {});
  },
  methods: {
    // One message to the configured default channel, for schedule delivery.
    notify: (p) => {
      if (!app) throw new RpcError(-32603, "slack이 시작되지 않았어요 (appTokenFile, botTokenFile, ownerId 설정을 확인하세요)");
      const text = (p as { text?: unknown } | null)?.text;
      if (typeof text !== "string" || !text.trim()) throw new RpcError(-32602, "slack.notify에는 {text}가 있어야 해요");
      return app.notify(text);
    },
  },
});

void plugin.run();
await ready;

const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** Reads a token file and checks its prefix; the error names the file, never the contents. */
function readToken(path: string, prefix: string): string {
  const token = readFileSync(expand(path), "utf8").trim();
  if (!token) throw new Error(`token file ${path} is empty`);
  if (!token.startsWith(prefix)) throw new Error(`token in ${path} does not start with ${prefix}`);
  return token;
}

// A missing or broken setup must not crash-loop the plugin (the kernel would quarantine it).
// Stay connected to the kernel, idle, and say why on stderr (the kernel's plugin log).
async function start(): Promise<void> {
  const config = parseConfig(plugin.config as Record<string, unknown>);
  const appToken = readToken(config.appTokenFile, "xapp-");
  const botToken = readToken(config.botTokenFile, "xoxb-");

  const dataDir = process.env.ME_DATA_DIR ?? ".";
  mkdirSync(dataDir, { recursive: true });
  const ledger = new Ledger(join(dataDir, "ledger.sqlite"));
  const sdk = slackSdkGateway({ appToken, botToken });
  const created = createSlackApp({ gateway: sdk, kernel: kernelPort(plugin, config), ledger, cards: sqliteCards(ledger.db), config });

  try {
    await sdk.connect();
    await created.start();
  } catch (err) {
    await sdk.disconnect().catch(() => {});
    throw err;
  }
  gateway = sdk;
  app = created;
  console.error(`[slack] connected as ${sdk.botUserId}`);
}

try {
  await start();
} catch (err: any) {
  console.error(`[slack] 대기 중: 시작하지 않았어요 (${err?.message ?? err}). pluginConfig.slack(appTokenFile, botTokenFile, ownerId)을 고치고 me를 다시 시작하세요.`);
}
