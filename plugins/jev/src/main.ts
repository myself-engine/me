// Simplicity judgement (DESIGN §6 step 3). Uses Jev via OpenRouter when a key file exists,
// otherwise a fallback judgement by the configured LLM through GJC. Both return the same shape.
// The question is fixed, English and positively phrased: Jev is weaker with Korean and negation.
import { homedir } from "node:os";
import { join } from "node:path";
import { definePlugin } from "@myself/sdk";
import { parseJsonObject, runGjc } from "@myself/gjc";

export interface Judgement {
  /** Probability that the head can handle this alone with a short reply. */
  simpleProb: number;
  confidence: number;
  source: "jev" | "fallback";
  model: string;
}

const PROPOSITION =
  "The request can be fully satisfied by a short conversational reply, without reading, running, or changing any files or commands.";

const dataDir = process.env.MYSELF_DATA_DIR ?? ".";
const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

async function viaOpenRouter(keyFile: string, model: string, state: object, signal: AbortSignal): Promise<Judgement> {
  const key = (await Bun.file(keyFile).text()).trim();
  // Unverified against the live Jev API: OpenRouter exposes an OpenAI-compatible chat endpoint,
  // so the proposition and state are sent as a chat turn asking for a probability.
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: 'Judge the proposition about the state. Reply only JSON: {"probability": number 0..1, "confidence": number 0..1}' },
        { role: "user", content: JSON.stringify({ proposition: PROPOSITION, state }) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body: any = await res.json();
  const out = parseJsonObject<{ probability: number; confidence?: number }>(body.choices?.[0]?.message?.content ?? "");
  return { simpleProb: clamp(out.probability), confidence: clamp(out.confidence ?? 0.5), source: "jev", model };
}

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

const clamp = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

const plugin = definePlugin({
  methods: {
    judge: async (p: { summaryEn: string; needsCodeChange: boolean; scope: string }, ctx) => {
      const state = { request: p.summaryEn, needsCodeChange: p.needsCodeChange, scope: p.scope };
      const keyFile = expand((plugin.config.openrouterKeyFile as string) ?? "~/.config/myself-engine/secrets/openrouter.key");
      if (await Bun.file(keyFile).exists()) {
        try {
          return await viaOpenRouter(keyFile, (plugin.config.jevModel as string) ?? "typesafe/jev-router", state, ctx.signal);
        } catch (err) {
          console.error("[jev] openrouter failed, falling back:", err);
        }
      }
      return viaFallback((plugin.config.fallbackModel as string) ?? "openai-codex/gpt-5.6-luna", state, ctx.signal);
    },
  },
});
await plugin.run();
