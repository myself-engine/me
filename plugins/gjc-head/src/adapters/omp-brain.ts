// The head's own voice through OMP: same shape as GJC (-p --mode json,
// explicit tool whitelist, no tools by default), same persona, same guard.
// OMP has no --no-mcp switch; --no-extensions + --no-skills + the explicit
// --tools whitelist is its equivalent (see @me/runner). Sessions live under
// "sessions-omp" next to GJC's "sessions" so the two never share state.
// Routing by harness happens above (main.ts); this adapter serves OMP turns.
import { join } from "node:path";
import { parseOmpModelList, prepareHead, runHead } from "@me/runner";
import type { ModelInfo } from "../domain/types.ts";
import type { Brain } from "../ports/index.ts";
import { HEAD_SYSTEM } from "./gjc-brain.ts";

export function ompBrain(opts: { dataDir: string }): Brain {
  const cwd = join(opts.dataDir, "sessions-omp");
  return {
    async reply(p) {
      const res = await runHead({
        harness: "omp",
        prompt: p.prompt,
        model: p.model,
        // Every thread resumes from the same directory, like GJC's sessions.
        cwd,
        resume: p.sessionId ?? undefined,
        systemPrompt: HEAD_SYSTEM,
        // The default is "off": reasoning adds latency variance to short chat replies.
        thinking: p.effort,
        signal: p.signal,
        onUpdate: p.onUpdate,
      });
      return { text: res.text, sessionId: res.sessionId, violation: res.violation ? { toolName: res.violation.toolName } : null };
    },
    prepare(p) {
      const warm = prepareHead({ harness: "omp", model: p.model, cwd, resume: p.sessionId ?? undefined, systemPrompt: HEAD_SYSTEM, thinking: p.effort });
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

/** Models from `omp models --json`, cached like the GJC list. */
export function ompModels(opts: { ttlMs?: number } = {}): { list(): Promise<ModelInfo[]> } {
  const ttl = opts.ttlMs ?? 10 * 60_000;
  let cached: { at: number; list: Promise<ModelInfo[]> } | null = null;
  return {
    list() {
      if (cached && Date.now() - cached.at < ttl) return cached.list;
      const list = (async () => {
        const proc = Bun.spawn(["omp", "models", "--json"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
        const timer = setTimeout(() => proc.kill(), 60_000);
        try {
          return parseOmpModelList(JSON.parse(await new Response(proc.stdout).text())).map((m) => ({ id: m.id, efforts: m.efforts as ModelInfo["efforts"] }));
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
