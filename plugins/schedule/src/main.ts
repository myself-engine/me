// Wires the schedule plugin: kernel SDK around the runner service. Config jobs come
// from pluginConfig.schedule.jobs (read-only); runtime jobs live as schedule.job
// entities. A missing gjc-head or messenger plugin never crashes the timer: runs fail
// with an error and deliveries fall back to the web thread.
import { definePlugin } from "@me/sdk";
import { JOB_SCHEMA, kernelInvoker, kernelStore, RUN_SCHEMA, STATE_SCHEMA, systemClock } from "./adapters/kernel.ts";
import { createScheduleService, type ScheduleService } from "./app/service.ts";
import { parseScheduleConfig } from "./domain/schedule.ts";

let service: ScheduleService;

const plugin = definePlugin({
  async onInit() {
    const config = parseScheduleConfig((plugin.config ?? {}) as Record<string, unknown>);
    const store = kernelStore(plugin);
    service = createScheduleService({
      config,
      store,
      invoker: kernelInvoker(plugin, config.chatTimeoutMs),
      clock: systemClock(),
      // Alive watermark: the next start-up treats dues after this as missed while off.
      onTick: (nowMs) => void store.putState(new Date(nowMs).toISOString()).catch((err) => console.error("[schedule] putState failed:", err)),
    });
    await plugin.entity.registerKind("job", JOB_SCHEMA);
    await plugin.entity.registerKind("run", RUN_SCHEMA);
    await plugin.entity.registerKind("state", STATE_SCHEMA);
    await service.load(await store.getState());
    // The tick clock starts after initialize is answered, like the ops plugin.
    setTimeout(() => service.start(), 0);
  },
  onEvent(name, data) {
    if (name === "gjc-head.message.changed") {
      void service?.onMessageChanged(data as { id?: unknown; threadId?: unknown }).catch((err) => console.error("[schedule] onMessageChanged failed:", err));
    }
  },
  onShutdown() {
    service?.stop();
  },
  methods: {
    "schedule.add": (p) => service.add((p ?? {}) as Record<string, unknown>),
    "schedule.update": (p) => service.update((p ?? {}) as { id: string } & Record<string, unknown>),
    "schedule.remove": (p) => service.remove((p ?? {}) as { id: string }),
    "schedule.list": () => service.list(),
    "schedule.runNow": (p) => service.runNow((p ?? {}) as { id: string }),
  },
});

await plugin.run();
