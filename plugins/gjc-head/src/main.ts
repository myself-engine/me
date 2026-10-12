// Wires the head's adapters into its use case. The head never touches code: GJC runs with
// no tools and --no-mcp, and any tool execution aborts the run (adapters/gjc-brain.ts).
import { definePlugin } from "@me/sdk";
import { createHead } from "./app/chat.ts";
import type { Effort } from "./domain/types.ts";
import { gjcBrain, gjcModels } from "./adapters/gjc-brain.ts";
import { brgrDelegator, entityStore, kernelApprovals, kernelEvents, kernelJudge, kernelNormalizer, kernelSummarizer } from "./adapters/kernel.ts";

let head: ReturnType<typeof createHead>;

const plugin = definePlugin({
  async onInit() {
    const c = plugin.config;
    head = createHead(
      {
        brain: gjcBrain({ dataDir: process.env.ME_DATA_DIR ?? "." }),
        models: gjcModels(),
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
        model: (c.model as string) ?? "openai-codex/gpt-5.6-luna",
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
    "chat.models": () => head.models(),
  },
  async onEvent(name, data) {
    if (name.startsWith("brgr.task.")) await head.onTaskEvent(data);
  },
});

await plugin.run();
