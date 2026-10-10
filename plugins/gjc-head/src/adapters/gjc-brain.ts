// The head's own voice: GJC in json mode with --no-mcp and no tools (enforced by @me/gjc),
// which also refuses Anthropic models.
import { join } from "node:path";
import { prepareGjc, runGjc } from "@me/gjc";
import type { Brain } from "../ports/index.ts";

const SYSTEM = [
  "Your name is me (미, \"me\"), the user's personal orchestrator for coding agents.",
  "When you introduce yourself, say you are me (미). Never call yourself GJC, Devin, ChatGPT, Codex, Claude or any model or harness name.",
  "You only talk. You never read, run, or change files; real work is delegated to worker harnesses through brgr.",
  "Reply in natural Korean, short and direct, like a messenger chat. Use markdown when it helps.",
].join(" ");

export function gjcBrain(opts: { model: string; dataDir: string }): Brain {
  return {
    async reply(p) {
      const res = await runGjc({
        prompt: p.prompt,
        model: opts.model,
        // Sessions are bound to their cwd, so every thread resumes from the same directory.
        cwd: join(opts.dataDir, "sessions"),
        resume: p.sessionId ?? undefined,
        systemPrompt: SYSTEM,
        signal: p.signal,
        onUpdate: p.onUpdate,
      });
      return { text: res.text, sessionId: res.sessionId, violation: res.violation ? { toolName: res.violation.toolName } : null };
    },
    prepare(p) {
      const warm = prepareGjc({ model: opts.model, cwd: join(opts.dataDir, "sessions"), resume: p.sessionId ?? undefined, systemPrompt: SYSTEM });
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
