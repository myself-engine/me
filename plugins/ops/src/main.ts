// ops plugin: health checks for things the user runs (web apps, servers, Discord bots, local services), plus
// configured actions (restart a service, run a command) that run only after the user approves them.
// Permissions (plugin.json):
// - read-state, emit: store `ops.check` records and announce status changes and action results.
// - network: http and tcp probes.
// - shell: process (`ps`), launchd (`launchctl print`), herdr-pane (`herdr pane get`) and command probes spawn
//   programs. All are spawned by argv without a shell; the first three are read-only queries, and command checks
//   run exactly the argv the user configured. Actions spawn their configured argv the same way.
// - approve.request: every action asks the kernel approval gate first. A remote instance needs it in the kernel's
//   remotePermissions; without it, actions fail before running anything.
// This file only wires ports to adapters; logic lives in domain/ and app/.
import { hostname } from "node:os";
import { definePlugin } from "@me/sdk";
import { bunExec } from "./adapters/exec.ts";
import { KIND_SCHEMA, kernelApprovals, kernelCheckStore, kernelEvents, kindFor, systemClock } from "./adapters/kernel.ts";
import { createProbe } from "./adapters/probes.ts";
import { createService, type OpsService } from "./app/service.ts";
import { parseConfig } from "./domain/check.ts";

export type { CheckRecord, CheckSpec, Status } from "./domain/check.ts";

let service: OpsService;

const plugin = definePlugin({
  async onInit() {
    const config = parseConfig(plugin.config, { uid: process.getuid?.() ?? null });
    for (const e of config.errors) console.error(`[ops] check #${e.index}${e.id ? ` (${e.id})` : ""} ignored: ${e.error}`);
    const exec = bunExec();
    service = createService({
      config,
      probe: createProbe({ exec }),
      exec,
      approvals: kernelApprovals(plugin),
      machine: `${hostname()} (${plugin.id})`,
      clock: systemClock(),
      store: kernelCheckStore(plugin),
      events: kernelEvents(plugin),
    });
    await plugin.entity.registerKind(kindFor(plugin.id), KIND_SCHEMA);
    await service.load();
    // Start after initialize has been answered, so the first round of upserts does not race the handshake.
    setTimeout(() => service.start(), 0);
  },
  onShutdown() {
    service?.stop();
  },
  methods: {
    "checks.list": () => service.list(),
    "checks.run": (p) => service.run(p ?? {}),
    "checks.history": (p) => service.history(p ?? {}),
    "actions.run": (p) => service.runAction(p ?? {}),
  },
});

await plugin.run();
