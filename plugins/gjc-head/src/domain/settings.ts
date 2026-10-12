// Access mode and model/effort choices for the head and for delegated workers. Pure functions only; no I/O.
import { harnessName, isHeadHarness, parseGjcModelList, type HeadHarness } from "@me/runner";
import type { AccessMode, Effort, ModelInfo } from "./types.ts";

export const EFFORTS: Effort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Levels offered for workers; each harness maps them onto its own flag. */
export const WORKER_EFFORTS = ["low", "medium", "high", "xhigh"];

const ANTHROPIC_RE = /(anthropic|claude|opus|sonnet|haiku|fable)/i;
/** Claude may only run inside Claude Code (ToS), never inside GJC or another harness. */
export const isAnthropic = (model: string) => ANTHROPIC_RE.test(model);
/** Cooldown for a failed model before the primary is tried first again, in seconds. */
export const DEFAULT_COOLDOWN_SEC = 600;
/** The headless harness answering: "gjc" (default) or "omp". */
export const DEFAULT_HARNESS: HeadHarness = "gjc";

/** Validates the harness choice. */
export function checkHarness(p: { harness?: unknown }): { harness?: HeadHarness } {
  if (p.harness === undefined || p.harness === null) return {};
  if (!isHeadHarness(p.harness)) throw new Error("대화 엔진은 gjc, omp 중 하나예요");
  return { harness: p.harness };
}

export interface FallbackRef {
  harness: HeadHarness | null;
  model: string;
}
/** Splits "harness:model" cross-harness refs; bare ids inherit the run's harness. */
export function parseFallbackRef(ref: string): FallbackRef {
  const m = ref.match(/^(gjc|omp):([\s\S]*)$/);
  if (m) return { harness: m[1] as HeadHarness, model: m[2]!.trim() };
  return { harness: null, model: ref };
}
/** Storage key for cooldowns: always explicit so the same model id cools per harness. */
export const refKey = (harness: HeadHarness, model: string) => `${harness}:${model}`;
export function resolveFallbackRef(ref: string, harness: HeadHarness): { harness: HeadHarness; model: string } {
  const r = parseFallbackRef(ref);
  return { harness: r.harness ?? harness, model: r.model };
}

/**
 * Validates the per-harness default models. The old top-level `model` stays
 * the gjc default, so configs without `models` keep working.
 */
export function checkHeadModels(p: { model?: unknown; models?: unknown }): { model?: string; models?: Partial<Record<HeadHarness, string>> } {
  const out: { model?: string; models?: Partial<Record<HeadHarness, string>> } = {};
  if (p.model !== undefined && p.model !== null) {
    if (typeof p.model !== "string" || !p.model.trim()) throw new Error("모델 이름이 비어 있어요");
    if (isAnthropic(p.model)) throw new Error(`${p.model}은 대화 엔진(GJC)에서 쓸 수 없어요. Claude 모델은 Claude Code에서만 써요`);
    out.model = p.model.trim();
  }
  if (p.models !== undefined && p.models !== null) {
    if (typeof p.models !== "object" || Array.isArray(p.models)) throw new Error("models는 하네스별 기본 모델이에요");
    const m: Partial<Record<HeadHarness, string>> = {};
    for (const [k, v] of Object.entries(p.models)) {
      if (!isHeadHarness(k)) throw new Error("대화 엔진은 gjc, omp 중 하나예요");
      if (typeof v !== "string" || !v.trim()) throw new Error("모델 이름이 비어 있어요");
      if (isAnthropic(v)) throw new Error(`${v.trim()}은 대화 엔진(${harnessName(k)})에서 쓸 수 없어요. Claude 모델은 Claude Code에서만 써요`);
      m[k] = v.trim();
    }
    out.models = m;
  }
  return out;
}

/**
 * Validates the ordered fallback models. Empty means no fallback: fail as
 * today. Anthropic models are refused like every other head choice (ToS).
 */
export function checkFallbackModels(p: { fallbackModels?: unknown }): { fallbackModels?: string[] } {
  if (p.fallbackModels === undefined || p.fallbackModels === null) return {};
  if (!Array.isArray(p.fallbackModels)) throw new Error("fallbackModels는 문자열 배열이에요");
  const out: string[] = [];
  for (const m of p.fallbackModels) {
    if (typeof m !== "string" || !m.trim()) throw new Error("모델 이름이 비어 있어요");
    const ref = m.trim();
    const { harness, model } = parseFallbackRef(ref);
    if (!model) throw new Error("모델 이름이 비어 있어요");
    if (isAnthropic(model)) throw new Error(`${model}은 대화 엔진(${harnessName(harness ?? "gjc")})에서 쓸 수 없어요. Claude 모델은 Claude Code에서만 써요`);
    if (!out.includes(ref)) out.push(ref);
  }
  return { fallbackModels: out };
}

/** Validates the cooldown: seconds a failed model stays out, 0 disables the wait. */
export function checkCooldownSec(p: { cooldownSec?: unknown }): { cooldownSec?: number } {
  if (p.cooldownSec === undefined || p.cooldownSec === null) return {};
  if (typeof p.cooldownSec !== "number" || !Number.isFinite(p.cooldownSec) || p.cooldownSec < 0) throw new Error("cooldownSec는 0 이상의 숫자예요");
  return { cooldownSec: p.cooldownSec };
}
export const isEffort = (e: unknown): e is Effort => EFFORTS.includes(e as Effort);

/** Access modes: "read" never delegates, "project" delegates at once and waits for review, "full" also auto-applies. */
export const ACCESS_MODES: AccessMode[] = ["read", "project", "full"];
/** The mode new threads and fresh settings start with: delegate at once, apply after review. */
export const DEFAULT_ACCESS: AccessMode = "project";
export const isAccessMode = (e: unknown): e is AccessMode => ACCESS_MODES.includes(e as AccessMode);

/**
 * Validates an access change before it is stored. Unset access is allowed.
 * Switching to "full" needs an explicit confirm, so a stray tap cannot arm auto-apply.
 */
export function checkAccess(p: { access?: unknown; confirm?: unknown }): { access?: AccessMode } {
  if (p.access === undefined || p.access === null) return {};
  if (!isAccessMode(p.access)) throw new Error(`모드는 ${ACCESS_MODES.join(", ")} 중 하나예요`);
  if (p.access === "full" && p.confirm !== true) throw new Error("전부 알아서 모드로 바꾸려면 확인이 필요해요");
  return { access: p.access };
}

/** The access mode a thread runs with: its own choice, else the default. */
export function accessOf(thread: { access?: AccessMode | null }, defaults: { access: AccessMode }): AccessMode {
  return thread.access ?? defaults.access;
}

/** The harness, model and effort a thread replies with: its own choice, else the defaults. */
export function brainChoice(
  thread: { model?: string | null; effort?: Effort | null },
  defaults: { harness: HeadHarness; model: string; models: Record<HeadHarness, string>; effort: Effort },
) {
  return { harness: defaults.harness, model: thread.model || defaults.models[defaults.harness] || defaults.model, effort: thread.effort ?? defaults.effort };
}

/** Validates a head choice before it is stored. Unset fields are allowed. */
export function checkHeadChoice(p: { model?: unknown; effort?: unknown }, harness: HeadHarness = "gjc") {
  if (p.model !== undefined && p.model !== null) {
    if (typeof p.model !== "string" || !p.model.trim()) throw new Error("모델 이름이 비어 있어요");
    if (isAnthropic(p.model)) throw new Error(`${p.model}은 대화 엔진(${harnessName(harness)})에서 쓸 수 없어요. Claude 모델은 Claude Code에서만 써요`);
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
 * The table parser lives in @me/runner next to the OMP one; this keeps the name.
 */
export function parseModelList(text: string): ModelInfo[] {
  return parseGjcModelList(text).map((m) => ({ id: m.id, efforts: m.efforts as ModelInfo["efforts"] }));
}
