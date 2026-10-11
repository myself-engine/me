// Model and effort choices for the head and for delegated workers. Pure functions only; no I/O.
import type { Effort, ModelInfo } from "./types.ts";

export const EFFORTS: Effort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Levels offered for workers; each harness maps them onto its own flag. */
export const WORKER_EFFORTS = ["low", "medium", "high", "xhigh"];

const ANTHROPIC_RE = /(anthropic|claude|opus|sonnet|haiku|fable)/i;
/** Claude may only run inside Claude Code (ToS), never inside GJC or another harness. */
export const isAnthropic = (model: string) => ANTHROPIC_RE.test(model);
export const isEffort = (e: unknown): e is Effort => EFFORTS.includes(e as Effort);

/** The model and effort a thread replies with: its own choice, else the defaults. */
export function brainChoice(thread: { model?: string | null; effort?: Effort | null }, defaults: { model: string; effort: Effort }) {
  return { model: thread.model || defaults.model, effort: thread.effort ?? defaults.effort };
}

/** Validates a head choice before it is stored. Unset fields are allowed. */
export function checkHeadChoice(p: { model?: unknown; effort?: unknown }) {
  if (p.model !== undefined && p.model !== null) {
    if (typeof p.model !== "string" || !p.model.trim()) throw new Error("모델 이름이 비어 있어요");
    if (isAnthropic(p.model)) throw new Error(`${p.model}은 대화 엔진(GJC)에서 쓸 수 없어요. Claude 모델은 Claude Code에서만 써요`);
  }
  if (p.effort !== undefined && p.effort !== null && !isEffort(p.effort)) throw new Error(`effort는 ${EFFORTS.join(", ")} 중 하나예요`);
}

/** Validates a worker choice made at approval. Anthropic models only go to Claude Code. */
export function checkWorkerChoice(p: { harness: string; model?: unknown; effort?: unknown }): { model?: string; effort?: string } {
  const out: { model?: string; effort?: string } = {};
  if (typeof p.model === "string" && p.model.trim()) {
    const model = p.model.trim();
    if (isAnthropic(model) && p.harness !== "local.claude-code") throw new Error(`${model}은 Claude Code에서만 쓸 수 있어요`);
    out.model = model;
  }
  if (typeof p.effort === "string" && p.effort) {
    if (!WORKER_EFFORTS.includes(p.effort)) throw new Error(`작업 effort는 ${WORKER_EFFORTS.join(", ")} 중 하나예요`);
    out.effort = p.effort;
  }
  return out;
}

/**
 * Reads the "Provider models" table of `gjc --list-models` (provider, model, context, max-out,
 * thinking, images). Anthropic models are dropped: the list feeds the head's picker.
 */
export function parseModelList(text: string): ModelInfo[] {
  const out: ModelInfo[] = [];
  const seen = new Set<string>();
  let inProviders = false;
  for (const line of text.split("\n")) {
    if (/^Provider models\s*$/.test(line)) {
      inProviders = true;
      continue;
    }
    if (!inProviders || !line.trim() || /^provider\s{2,}model\b/.test(line)) continue;
    if (/^\S.*models\s*$/.test(line)) break;
    const cols = line.trim().split(/\s{2,}/);
    if (cols.length < 5) continue;
    const id = `${cols[0]}/${cols[1]}`;
    if (isAnthropic(id) || seen.has(id)) continue;
    seen.add(id);
    const levels = cols[4]!.split(",").map((x) => x.trim()).filter(isEffort);
    out.push({ id, efforts: levels.length ? ["off", ...levels.filter((l) => l !== "off")] : /^(no|-)$/.test(cols[4]!) ? ["off"] : null });
  }
  return out;
}
