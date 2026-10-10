// Simplicity judgement (DESIGN §6 step 3). Uses Jev via OpenRouter when a key file exists,
// otherwise a fallback judgement by the configured LLM through GJC. Both return the same shape.
// The question is fixed, English and positively phrased: Jev is weaker with Korean and negation.
import { homedir } from "node:os";
import { join } from "node:path";
import { definePlugin } from "@me/sdk";
import { parseJsonObject, runGjc } from "@me/gjc";
import { PROPOSITION, clamp, viaJevDecisions, type Judgement } from "./jev.ts";

const dataDir = process.env.ME_DATA_DIR ?? ".";
const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

async function viaFallback(model: string, state: object, signal: AbortSignal): Promise<Judgement> {
  const prompt = [
    "Estimate the probability that this proposition is true for the given request state.",
    `Proposition: ${PROPOSITION}`,
    `State: ${JSON.stringify(state)}`,
    'Reply ONLY with JSON: {"probability": number between 0 and 1, "confidence": number between 0 and 1}',
  ].join("\n");
  const res = await runGjc({ prompt, model, cwd: join(dataDir, "runs"), ephemeral: true, thinking: "off", signal });
  const out = parseJsonObject<{ probability: number; confidence?: number }>(res.text);
  return { simpleProb: clamp(out.probability), confidence: clamp(out.confidence ?? 0.5), source: "fallback", model };
}

const plugin = definePlugin({
  methods: {
    judge: async (p: { summaryEn: string; needsCodeChange: boolean; scope: string }, ctx) => {
      const state = { request: p.summaryEn, needsCodeChange: p.needsCodeChange, scope: p.scope };
      const keyFile = expand((plugin.config.openrouterKeyFile as string) ?? "~/.config/me/secrets/openrouter.key");
      if (await Bun.file(keyFile).exists()) {
        try {
          const key = (await Bun.file(keyFile).text()).trim();
          return await viaJevDecisions(key, (plugin.config.jevModel as string) ?? "~typesafe/jev-latest", state, ctx.signal);
        } catch (err) {
          console.error("[jev] openrouter failed, falling back:", err);
        }
      }
      return viaFallback((plugin.config.fallbackModel as string) ?? "openai-codex/gpt-5.6-luna", state, ctx.signal);
    },
  },
});
await plugin.run();
