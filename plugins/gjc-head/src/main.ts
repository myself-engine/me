// Wires the head's adapters into its use case. The head never touches code:
// every runner starts with no tools and --no-mcp (GJC) or --no-extensions +
// --no-skills (OMP), and any tool execution aborts the run. Plugin id stays
// gjc-head; only the harness inside is selectable (config `harness`, default
// "gjc").
import { definePlugin } from "@me/sdk";
import { createHead } from "./app/chat.ts";
import { checkHarness } from "./domain/settings.ts";
import type { Effort } from "./domain/types.ts";
import type { HeadHarness } from "@me/runner";
import { gjcBrain, gjcModels } from "./adapters/gjc-brain.ts";
import { ompBrain, ompModels } from "./adapters/omp-brain.ts";
import { brgrDelegator, entityStore, kernelApprovals, kernelEvents, kernelJudge, kernelNormalizer, kernelSummarizer } from "./adapters/kernel.ts";
import type { Brain } from "./ports/index.ts";

let head: ReturnType<typeof createHead>;

const plugin = definePlugin({
  async onInit() {
    const c = plugin.config;
    const dataDir = process.env.ME_DATA_DIR ?? ".";
    const gjc = gjcBrain({ dataDir });
    const omp = ompBrain({ dataDir });
    const brain: Brain = {
      reply: (p) => (p.harness === "omp" ? omp : gjc).reply(p),
      prepare: (p) => (p.harness === "omp" ? omp : gjc).prepare!(p),
    };
    const catalogs = { gjc: gjcModels(), omp: ompModels() };
    head = createHead(
      {
        brain,
        models: { list: (harness: HeadHarness) => catalogs[harness].list() },
        normalizer: kernelNormalizer(plugin),
        summarizer: kernelSummarizer(plugin),
        judge: kernelJudge(plugin),
        approvals: kernelApprovals(plugin),
        delegator: brgrDelegator(plugin),
        store: entityStore(plugin),
        events: kernelEvents(plugin),
      },
      {
        harnesses: (c.harnesses as string[]) ?? ["local.claude-code", "local.codex", "local.gjc"],
        harness: checkHarness({ harness: c.harness }).harness ?? "gjc",
        model: (c.model as string) ?? "openai-codex/gpt-5.6-luna",
        models: (c.models as Partial<Record<HeadHarness, string>>) ?? {},
        effort: (c.effort as Effort) ?? "off",
        favoriteModels: (c.favoriteModels as string[]) ?? [],
        workerModels: (c.workerModels as Record<string, string[]>) ?? {},
        simpleThreshold: (c.simpleThreshold as number) ?? 0.8,
        approvalExpiresSec: (c.approvalExpiresSec as number) ?? 1800,
        defaultProject: (c.defaultProject as string) ?? "",
        fallbackModels: (c.fallbackModels as string[]) ?? [],
        cooldownSec: (c.cooldownSec as number) ?? 600,
      },
    );
    await head.init();
  },
  methods: {
    "chat.send": (p, ctx) => head.send(p, { update: ctx.update, phase: ctx.phase, signal: ctx.signal, traceId: ctx.traceId }),
    "chat.settings": () => head.settings(),
    "chat.settings.set": (p) => head.setDefaults(p),
    "chat.favorites.set": (p) => head.setFavorite(p),
    "chat.thread.set": (p) => head.setThread(p),
    "chat.models": (p) => head.models(p),
  },
  async onEvent(name, data) {
    if (name.startsWith("brgr.task.")) await head.onTaskEvent(data);
  },
});

await plugin.run();
