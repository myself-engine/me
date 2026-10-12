// budget plugin: stops unattended work from burning quota.
// No per-task token counts exist, so the budget is (a) provider quota from the local `meter` CLI and
// (b) counts of delegations. brgr calls budget.check before each delegation; the web shows budget.status.
// Permissions (plugin.json): read-state (own day/summary entities, brgr.task lookup), subscribe (brgr
// task events), shell (spawning `meter status --json` by argv, no shell, 5s timeout). Meter failures
// never block: they only surface as the status problem.
import { definePlugin, type Plugin } from "@me/sdk";
import { parseConfig } from "./budget.ts";
import { createBudgetService, type BudgetService, type BudgetStore, type DayRecord, type Exec } from "./service.ts";

const DAY_SCHEMA = {
  type: "object",
  required: ["id", "date", "delegations", "autoApplied", "updatedAt"],
  properties: {
    id: { type: "string" },
    date: { type: "string" },
    delegations: { type: "number" },
    autoApplied: { type: "number" },
    updatedAt: { type: "string" },
  },
};

const SUMMARY_SCHEMA = {
  type: "object",
  required: ["id", "date", "delegations", "dailyCap", "autoApplied", "autoApplyCap", "meters", "problem", "updatedAt"],
  properties: {
    id: { type: "string" },
    date: { type: "string" },
    delegations: { type: "number" },
    dailyCap: { type: "number" },
    autoApplied: { type: "number" },
    autoApplyCap: { type: "number" },
    meters: { type: "array" },
    problem: { type: ["string", "null"] },
    updatedAt: { type: "string" },
  },
};

function kernelStore(plugin: Plugin): BudgetStore {
  return {
    getDay: async (id) => (await plugin.entity.get<DayRecord>("budget.day", id).catch(() => null))?.data ?? null,
    putDay: async (d) => {
      await plugin.entity.upsert("budget.day", d.id, d);
    },
    getTask: async (taskId) =>
      (await plugin.entity.get<{ autoApply?: boolean }>("brgr.task", taskId).catch(() => null))?.data ?? null,
    putSummary: async (s) => {
      await plugin.entity.upsert("budget.summary", s.id, s);
    },
  };
}

/** Argv only (no shell), stdin closed, killed after the timeout. Same pattern as the ops exec adapter. */
function bunExec(): Exec {
  return {
    async run(argv, timeoutMs) {
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      } catch (err) {
        return { code: -1, stdout: "", stderr: "", timedOut: false, spawnError: String((err as Error)?.message ?? err) };
      }
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, timeoutMs);
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout as ReadableStream).text(),
          new Response(proc.stderr as ReadableStream).text(),
          proc.exited,
        ]);
        return { code, stdout, stderr, timedOut };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

let service: BudgetService;

const plugin = definePlugin({
  async onInit() {
    service = createBudgetService({ config: parseConfig(plugin.config), exec: bunExec(), store: kernelStore(plugin) });
    await plugin.entity.registerKind("day", DAY_SCHEMA);
    await plugin.entity.registerKind("summary", SUMMARY_SCHEMA);
  },
  async onEvent(name, data) {
    try {
      await service?.onEvent(name, data);
    } catch (err) {
      console.error(`[budget] onEvent ${name} failed:`, err);
    }
  },
  methods: {
    "budget.check": (p) => service.check(p ?? {}),
    "budget.status": () => service.status(),
  },
});

await plugin.run();
