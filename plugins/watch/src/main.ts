// Read-only Herdr agent status feed and stall notifications.
import { hostname } from "node:os";
import { definePlugin } from "@me/sdk";
import { commandExec } from "./adapters/exec.ts";
import { AGENT_KIND, AGENT_SCHEMA, kernelEvents, kernelStore, STATUS_KIND, STATUS_SCHEMA } from "./adapters/kernel.ts";
import { createWatchService } from "./app/service.ts";

type Config = { intervalSec?: number; stallMinutes?: number; herdrBin?: string; brgrBin?: string; ownerSession?: string };
let service: ReturnType<typeof createWatchService> | null = null;

const plugin = definePlugin({
  async onInit() {
    const config = (plugin.config ?? {}) as Config;
    const ownerSession = config.ownerSession ?? `me:${hostname().split(".")[0]}`;
    service = createWatchService({
      herdr: commandExec(config.herdrBin ?? "herdr"),
      brgr: { exec: (args, timeoutMs) => commandExec(config.brgrBin ?? "brgr").exec([...args, "--owner-session", ownerSession], timeoutMs) },
      store: kernelStore(plugin),
      events: kernelEvents(plugin),
      clock: {
        now: () => Date.now(),
        every: (ms, fn) => {
          const timer = setInterval(fn, ms);
          return () => clearInterval(timer);
        },
      },
      herdrEnv: process.env.HERDR_ENV === "1",
      config,
    });
    await plugin.entity.registerKind(AGENT_KIND, AGENT_SCHEMA);
    await plugin.entity.registerKind(STATUS_KIND, STATUS_SCHEMA);
    setTimeout(() => void service?.start().catch((error) => console.error("[watch] start failed:", error)), 0);
  },
  onShutdown() {
    service?.stop();
  },
  methods: {
    "watch.list": () => service?.list() ?? { agents: [], problem: "상태 피드가 아직 시작되지 않았어요", checkedAt: null },
    "watch.get": (p) => service?.get(String((p as { pane?: unknown } | null)?.pane ?? "")) ?? null,
  },
});

await plugin.run();
