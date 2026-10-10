// brgr plugin: delegation through brgr's sealed-result contract.
// brgr must run from a Herdr pane with no agent in it; the kernel's own pane qualifies.
// Owner identity is a fixed non-agent session name (config.ownerSession).
// This file only wires ports to adapters; logic lives in domain/ and app/.
import { hostname } from "node:os";
import { definePlugin } from "@me/sdk";
import { brgrCli } from "./adapters/brgr-cli.ts";
import { gitCli } from "./adapters/git.ts";
import { KIND, kernelEvents, kernelTaskStore } from "./adapters/kernel.ts";
import { createService } from "./app/service.ts";

export type { Task, TaskState } from "./domain/task.ts";

const plugin = definePlugin({
  async onInit() {
    await plugin.entity.registerKind(KIND, { type: "object", required: ["taskId", "state", "harness"] });
    await service.resume();
  },
  methods: {
    "task.delegate": (p) => service.delegate(p),
    "task.result": (p) => service.result(p),
    "task.diff": (p) => service.diff(p),
    "task.accept": (p) => service.accept(p),
    "task.reject": (p) => service.reject(p),
    "task.cancel": (p) => service.cancel(p),
    "harness.list": () => (plugin.config.harnesses as string[]) ?? ["local.claude-code", "local.codex", "local.gjc", "local.opencode"],
  },
});

const owner = () => (plugin.config.ownerSession as string) ?? `me:${hostname().split(".")[0]}`;

const service = createService({
  brgr: brgrCli(owner),
  git: gitCli(),
  store: kernelTaskStore(plugin),
  events: kernelEvents(plugin),
  deadlineSeconds: () => Number(plugin.config.deadlineSeconds ?? 1800),
});

await plugin.run();
