// Wires the head's adapters into its use case. The head never touches code: GJC runs with
// no tools and --no-mcp, and any tool execution aborts the run (adapters/gjc-brain.ts).
import { definePlugin } from "@me/sdk";
import { createHead } from "./app/chat.ts";
import { gjcBrain } from "./adapters/gjc-brain.ts";
import { brgrDelegator, entityStore, kernelApprovals, kernelEvents, kernelJudge, kernelNormalizer, kernelSummarizer } from "./adapters/kernel.ts";

let head: ReturnType<typeof createHead>;

const plugin = definePlugin({
  async onInit() {
    const c = plugin.config;
    head = createHead(
      {
        brain: gjcBrain({ model: (c.model as string) ?? "openai-codex/gpt-5.6-luna", dataDir: process.env.ME_DATA_DIR ?? "." }),
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
        simpleThreshold: (c.simpleThreshold as number) ?? 0.8,
        approvalExpiresSec: (c.approvalExpiresSec as number) ?? 1800,
        defaultProject: (c.defaultProject as string) ?? "",
      },
    );
    await head.registerKinds();
  },
  methods: {
    "chat.send": (p, ctx) => head.send(p, { update: ctx.update, phase: ctx.phase, signal: ctx.signal, traceId: ctx.traceId }),
  },
  async onEvent(name, data) {
    if (name.startsWith("brgr.task.")) await head.onTaskEvent(data);
  },
});

await plugin.run();
