// Jev decisions call, kept apart from main.ts so it can be tested without starting the plugin.

export interface Judgement {
  /** Probability that the head can handle this alone with a short reply. */
  simpleProb: number;
  confidence: number;
  source: "jev" | "fallback";
  model: string;
}

/** Fixed, English and positively phrased: Jev is weaker with Korean and negation. */
export const PROPOSITION =
  "The request can be fully satisfied by a short conversational reply, without reading, running, or changing any files or commands.";

export const clamp = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Jev through OpenRouter's decisions endpoint (verified 2026-10-11). Jev is a decisions model, not a
 * chat model: `typesafe/jev-router` on /chat/completions only routes to other LLMs. A `noul` question
 * returns the probability that a proposition is true; Jev gives no separate confidence for noul, so
 * confidence is the distance from 0.5.
 */
export async function viaJevDecisions(key: string, model: string, state: object, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<Judgement> {
  const res = await fetcher("https://openrouter.ai/api/alpha/decisions", {
    method: "POST",
    signal,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, state, questions: { simple: { type: "noul", instructions: PROPOSITION } } }),
  });
  if (!res.ok) throw new Error(`jev ${res.status}: ${(await res.text()).replace(/"user_id":"[^"]+"/, "").slice(0, 200)}`);
  const body: any = await res.json();
  const p = body?.answers?.simple?.noul;
  if (typeof p !== "number") throw new Error(`jev: unexpected answer ${JSON.stringify(body?.answers).slice(0, 200)}`);
  return { simpleProb: clamp(p), confidence: clamp(Math.abs(p - 0.5) * 2), source: "jev", model: body.model ?? model };
}

