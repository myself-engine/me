// The head's own voice: GJC in json mode with --no-mcp and no tools (enforced by @me/gjc),
// which also refuses Anthropic models. Routing by harness happens above (main.ts);
// this adapter serves GJC turns and ignores the harness field it is handed.
import { join } from "node:path";
import { prepareGjc, runGjc } from "@me/gjc";
import { parseModelList } from "../domain/settings.ts";
import type { ModelInfo } from "../domain/types.ts";
import type { Brain } from "../ports/index.ts";

/** The head's persona, shared by every head runner. */
export const HEAD_SYSTEM = [
  "Your name is me (미, \"me\"), the user's personal orchestrator for coding agents.",
  "When you introduce yourself, say you are me (미). Never call yourself GJC, Devin, ChatGPT, Codex, Claude or any model or harness name.",
  "You only talk and cannot read, run, or edit files. Work requests are delegated to coding workers automatically. Never claim that workers are unavailable.",
  "If the user is asking for work to be done, reply with exactly this sentinel line and nothing else: [[DELEGATE]].",
  "For ordinary conversation and information questions, answer directly.",
  "Reply in natural Korean, short and direct, like a messenger chat. Use markdown when it helps.",
].join(" ");

export function gjcBrain(opts: { dataDir: string }): Brain {
  return {
    async reply(p) {
      const res = await runGjc({
        prompt: p.prompt,
        model: p.model,
        // Sessions are bound to their cwd, so every thread resumes from the same directory.
        cwd: join(opts.dataDir, "sessions"),
        resume: p.sessionId ?? undefined,
        systemPrompt: HEAD_SYSTEM,
        // The default is "off": reasoning adds latency variance (up to ~6s) to short chat replies.
        thinking: p.effort,
        signal: p.signal,
        onUpdate: p.onUpdate,
      });
      return { text: res.text, sessionId: res.sessionId, violation: res.violation ? { toolName: res.violation.toolName } : null };
    },
    prepare(p) {
      const warm = prepareGjc({ model: p.model, cwd: join(opts.dataDir, "sessions"), resume: p.sessionId ?? undefined, systemPrompt: HEAD_SYSTEM, thinking: p.effort });
      return {
        async reply(q) {
          const res = await warm.run(q.prompt, { onUpdate: q.onUpdate, signal: q.signal });
          return { text: res.text, sessionId: res.sessionId, violation: res.violation ? { toolName: res.violation.toolName } : null };
        },
        cancel: () => warm.cancel(),
      };
    },
  };
}

/** Models from `gjc --list-models`, cached: the list is slow (seconds) and rarely changes. */
export function gjcModels(opts: { ttlMs?: number } = {}): { list(): Promise<ModelInfo[]> } {
  const ttl = opts.ttlMs ?? 10 * 60_000;
  let cached: { at: number; list: Promise<ModelInfo[]> } | null = null;
  return {
    list() {
      if (cached && Date.now() - cached.at < ttl) return cached.list;
      const list = (async () => {
        const proc = Bun.spawn(["gjc", "--list-models"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
        const timer = setTimeout(() => proc.kill(), 60_000);
        try {
          return parseModelList(await new Response(proc.stdout).text());
        } finally {
          clearTimeout(timer);
        }
      })();
      cached = { at: Date.now(), list };
      list.catch(() => (cached = null));
      return list;
    },
  };
}
