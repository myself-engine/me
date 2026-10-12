// Headless harness runners for the conversation head. GJC and OMP share the
// same CLI shape (-p, --mode json, --tools/--no-tools, --thinking, --model)
// and the same json event envelope (verified by a live OMP probe, 2026-10-13:
// session/message_update(tool/text deltas)/tool_execution_start/end/message_end
// with the assistant text in message.content). One consumer maps both.
// Safety stays mechanical for every runner: no tools unless explicitly
// allowed, and any tool execution outside `allowTools` aborts the run.
// OMP has no --no-mcp switch; --no-extensions + --no-skills + an explicit
// --tools whitelist is its equivalent.
import { mkdirSync } from "node:fs";
import { pumpLines } from "@me/protocol";

/** Which headless harness answers: GJC (default) or OMP. */
export type HeadHarness = "gjc" | "omp";
export const HEAD_HARNESSES: HeadHarness[] = ["gjc", "omp"];
export const isHeadHarness = (h: unknown): h is HeadHarness => h === "gjc" || h === "omp";
/** Display name for people. */
export const harnessName = (h: HeadHarness) => (h === "omp" ? "OMP" : "GJC");

export type RunnerUpdate =
  | { kind: "text_delta"; delta: string }
  | { kind: "thought_delta"; delta: string }
  | { kind: "tool_call"; toolCallId: string; toolName: string; intent?: string; args?: unknown }
  | { kind: "tool_result"; toolCallId: string; toolName: string; ok: boolean };

export interface RunnerOptions {
  prompt: string;
  model: string;
  /** Working directory. GJC binds sessions to it; OMP uses it for --cwd and --session-dir. */
  cwd: string;
  resume?: string;
  /** Tool names the run may execute. Empty means no tools at all. */
  allowTools?: string[];
  systemPrompt?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  onUpdate?: (u: RunnerUpdate) => void;
  signal?: AbortSignal;
  /** Retries on provider rate limits (429). */
  retries?: number;
  ephemeral?: boolean;
}

export interface RunnerResult {
  text: string;
  sessionId: string | null;
  stopReason: string | null;
  violation: { toolName: string; args?: unknown } | null;
}

const ANTHROPIC_RE = /(anthropic|claude|opus|sonnet|haiku|fable)/i;

export class RunnerError extends Error {
  constructor(
    message: string,
    readonly rateLimited = false,
  ) {
    super(message);
  }
}

/** Refuses Anthropic models on every head runner: Claude runs only in Claude Code (ToS). */
export function assertAllowedModel(model: string, harness: HeadHarness = "gjc") {
  if (ANTHROPIC_RE.test(model))
    throw new RunnerError(`model ${model} is not allowed inside ${harnessName(harness)} (Claude runs only in Claude Code)`);
}
/** One successful model switch: the configured primary failed with an eligible error. */
export interface ModelFallback {
  from: string;
  to: string;
  reason: string;
}

/**
 * Runs `run` against the primary model, falling back to each fallback model in
 * order when the failure looks transient or model-specific (the caller's
 * `isEligible` decides; it returns a short reason or null). Models still inside
 * their cooldown are skipped, and every model that fails eligibly is put in
 * cooldown for `cooldownSec`. Non-eligible failures abort at once. Throws the
 * last error when every attempted model fails. Domain-free: failure meanings
 * stay with the caller.
 */
export async function withModelFallback<T>(args: {
  primary: string;
  fallbackModels: string[];
  cooldownSec: number;
  cooldowns: Map<string, number>;
  now?: () => number;
  isEligible: (err: unknown) => string | null;
  run: (model: string) => Promise<T>;
  onFallback?: (f: ModelFallback) => void;
}): Promise<{ value: T; fallback: ModelFallback | null; primaryError: unknown | null }> {
  const nowMs = args.now ?? Date.now;
  const at = nowMs();
  for (const m of [...args.cooldowns.keys()]) {
    if ((args.cooldowns.get(m) ?? 0) <= at) args.cooldowns.delete(m);
  }
  const candidates = [args.primary, ...args.fallbackModels.filter((m) => m !== args.primary)];
  for (const m of candidates) assertAllowedModel(m);
  const cooling = (m: string) => (args.cooldowns.get(m) ?? 0) > at;
  const order = candidates.filter((m) => !cooling(m));
  // Always attempt something, even when everything is still cooling.
  if (!order.length) order.push(args.primary);
  let firstReason: string | null = null;
  let firstError: unknown | null = null;
  let lastError: unknown = null;
  for (const model of order) {
    try {
      const value = await args.run(model);
      if (model === args.primary && firstReason === null) return { value, fallback: null, primaryError: null };
      const fallback = { from: args.primary, to: model, reason: firstReason ?? "cooldown" };
      args.onFallback?.(fallback);
      return { value, fallback, primaryError: firstError };
    } catch (err) {
      lastError = err;
      const reason = args.isEligible(err);
      if (reason === null) throw err;
      firstReason ??= reason;
      firstError ??= err;
      args.cooldowns.set(model, at + args.cooldownSec * 1000);
    }
  }
  throw lastError;
}

/** A brain already started for one turn, waiting for its prompt. */
export interface WarmRunner {
  /** Sends the prompt to the already running harness. Falls back to a fresh run (with retries) on rate limits. */
  run(prompt: string, h: { onUpdate?: (u: RunnerUpdate) => void; signal?: AbortSignal }): Promise<RunnerResult>;
  /** Stops the waiting process when the prompt will never come (e.g. the message was delegated). */
  cancel(): void;
}

/**
 * One headless harness behind the head's internal event shape: send a turn,
 * stream updates, list models, cancel. GJC and OMP implement it; the head
 * picks one per turn and falls back across both.
 */
export interface HeadRunner {
  readonly harness: HeadHarness;
  run(opts: RunnerOptions): Promise<RunnerResult>;
  prepare(opts: Omit<RunnerOptions, "prompt" | "onUpdate" | "signal">): WarmRunner;
}

interface Running {
  proc: ReturnType<typeof Bun.spawn>;
  /** Resolves once the process exits; updates go to whatever `onUpdate` is set when they arrive. */
  done: Promise<RunnerResult>;
  setHandlers(h: { onUpdate?: (u: RunnerUpdate) => void; signal?: AbortSignal }): void;
}

/** Argument vector for a GJC headless run (exported as a test seam). */
export function gjcArgv(opts: Omit<RunnerOptions, "prompt">): string[] {
  assertAllowedModel(opts.model, "gjc");
  mkdirSync(opts.cwd, { recursive: true });
  const allow = opts.allowTools ?? [];
  const args = ["gjc", "--model", opts.model, "--mode", "json", "-p", "--no-title", "--no-mcp"];
  args.push(...(allow.length ? ["--tools", allow.join(",")] : ["--no-tools"]));
  if (opts.ephemeral) args.push("--no-session");
  if (opts.resume) args.push("--resume", opts.resume);
  if (opts.systemPrompt) args.push("--append-system-prompt", opts.systemPrompt);
  if (opts.thinking) args.push("--thinking", opts.thinking);
  return args;
}

/** Argument vector for an OMP headless run (exported as a test seam). */
export function ompArgv(opts: Omit<RunnerOptions, "prompt">): string[] {
  assertAllowedModel(opts.model, "omp");
  mkdirSync(opts.cwd, { recursive: true });
  const allow = opts.allowTools ?? [];
  // OMP has no --no-mcp: extensions and skills are its plugin surface, so both
  // stay off and only the explicit tool whitelist (if any) is enabled.
  const args = ["omp", "--model", opts.model, "--mode", "json", "-p", "--no-title", "--no-extensions", "--no-skills"];
  args.push(...(allow.length ? ["--tools", allow.join(",")] : ["--no-tools"]));
  // Sessions live under the caller's cwd so test kernels never touch the user's sessions.
  args.push("--cwd", opts.cwd, "--session-dir", opts.cwd);
  if (opts.ephemeral) args.push("--no-session");
  if (opts.resume) args.push("--resume", opts.resume);
  if (opts.systemPrompt) args.push("--append-system-prompt", opts.systemPrompt);
  if (opts.thinking) args.push("--thinking", opts.thinking);
  return args;
}

/** Consumes the shared GJC/OMP json event stream. Pure enough to test on a saved fixture. */
export function feedRunnerEvent(
  e: any,
  s: { text: string; sessionId: string | null; stopReason: string | null; errorMessage: string | null; violation: RunnerResult["violation"] },
  f: { allow: string[]; onUpdate?: (u: RunnerUpdate) => void; kill: () => void },
): void {
  switch (e.type) {
    case "session":
      s.sessionId ??= e.id;
      break;
    case "message_update": {
      const a = e.assistantMessageEvent;
      if (a?.type === "text_delta") f.onUpdate?.({ kind: "text_delta", delta: a.delta });
      else if (a?.type === "thinking_delta") f.onUpdate?.({ kind: "thought_delta", delta: a.delta });
      break;
    }
    case "tool_execution_start":
      if (!f.allow.includes(e.toolName)) {
        s.violation = { toolName: e.toolName, args: e.args };
        f.kill();
      }
      f.onUpdate?.({ kind: "tool_call", toolCallId: e.toolCallId, toolName: e.toolName, intent: e.intent, args: e.args });
      break;
    case "tool_execution_end":
      f.onUpdate?.({ kind: "tool_result", toolCallId: e.toolCallId, toolName: e.toolName, ok: !e.isError });
      break;
    case "message_end":
      if (e.message?.role === "assistant") {
        s.stopReason = e.message.stopReason ?? null;
        if (e.message.errorMessage) s.errorMessage = String(e.message.errorMessage);
        const t = (e.message.content ?? [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("");
        if (t) s.text = t;
      }
      break;
  }
}

/** Spawns one headless run and consumes its event stream. With `prompt` undefined, the harness waits for the prompt on stdin. */
function spawnRunner(harness: HeadHarness, opts: Omit<RunnerOptions, "prompt">, prompt: string | undefined): Running {
  const allow = opts.allowTools ?? [];
  const args = harness === "omp" ? ompArgv(opts) : gjcArgv(opts);
  if (prompt !== undefined) args.push(prompt);
  const proc = Bun.spawn(args, { cwd: opts.cwd, stdin: prompt === undefined ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe" });
  let onUpdate = opts.onUpdate;
  let signal = opts.signal;
  const kill = () => proc.kill();
  if (signal) signal.addEventListener("abort", kill, { once: true });

  const done = (async (): Promise<RunnerResult> => {
    const s = { text: "", sessionId: null as string | null, stopReason: null as string | null, errorMessage: null as string | null, violation: null as RunnerResult["violation"] };
    await pumpLines(proc.stdout as ReadableStream<Uint8Array>, (line) => {
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      feedRunnerEvent(e, s, { allow, onUpdate: (u) => onUpdate?.(u), kill });
    });
    await proc.exited;
    signal?.removeEventListener("abort", kill);

    if (s.violation) return { text: s.text, sessionId: s.sessionId, stopReason: "guard_violation", violation: s.violation };
    if (signal?.aborted) throw new RunnerError("aborted");
    if (s.stopReason === "error") {
      const msg = s.errorMessage ?? "unknown error";
      throw new RunnerError(`${harness} error: ${msg.slice(0, 300)}`, /429|rate.?limit|temporarily unavailable/i.test(msg));
    }
    if (proc.exitCode !== 0 && !s.text) {
      const err = (await new Response(proc.stderr as ReadableStream<Uint8Array>).text()).slice(0, 300);
      throw new RunnerError(`${harness} exited ${proc.exitCode}: ${err}`);
    }
    return { text: s.text, sessionId: s.sessionId, stopReason: s.stopReason, violation: null };
  })();

  return {
    proc,
    done,
    setHandlers(h) {
      if (h.onUpdate) onUpdate = h.onUpdate;
      if (h.signal && h.signal !== signal) {
        signal = h.signal;
        if (signal.aborted) kill();
        else signal.addEventListener("abort", kill, { once: true });
      }
    },
  };
}

async function runOnce(harness: HeadHarness, opts: RunnerOptions): Promise<RunnerResult> {
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    try {
      return await spawnRunner(harness, opts, opts.prompt).done;
    } catch (err) {
      if (err instanceof RunnerError && err.rateLimited && attempt < retries && !opts.signal?.aborted) {
        await Bun.sleep(5_000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Starts the harness before the prompt is known so process start, auth and
 * session resume overlap with whatever decides what to say (about 1–1.5s
 * saved per reply on GJC, measured 2026-10-11; OMP also waits for the prompt
 * on stdin, verified 2026-10-13).
 */
function prepare(harness: HeadHarness, opts: Omit<RunnerOptions, "prompt" | "onUpdate" | "signal">): WarmRunner {
  const running = spawnRunner(harness, opts, undefined);
  let used = false;
  running.done.catch(() => {});
  return {
    async run(prompt, h) {
      if (used) throw new RunnerError(`warm ${harness} already used`);
      used = true;
      running.setHandlers(h);
      const stdin = running.proc.stdin as import("bun").FileSink;
      stdin.write(prompt);
      await stdin.end();
      try {
        return await running.done;
      } catch (err) {
        if (err instanceof RunnerError && err.rateLimited && !h.signal?.aborted) {
          return runOnce(harness, { ...opts, prompt, onUpdate: h.onUpdate, signal: h.signal });
        }
        throw err;
      }
    },
    cancel() {
      if (!used) {
        used = true;
        running.proc.kill();
      }
    },
  };
}

/** The GJC head runner: current behavior, unchanged. */
export function gjcRunner(): HeadRunner {
  return {
    harness: "gjc",
    run: (opts) => runOnce("gjc", opts),
    prepare: (opts) => prepare("gjc", opts),
  };
}

/** The OMP head runner: same shape as GJC, sessions under the caller's cwd. */
export function ompRunner(): HeadRunner {
  return {
    harness: "omp",
    run: (opts) => runOnce("omp", opts),
    prepare: (opts) => prepare("omp", opts),
  };
}

export function runnerFor(harness: HeadHarness): HeadRunner {
  return harness === "omp" ? ompRunner() : gjcRunner();
}

/** Sends one turn through the named harness. */
export function runHead(opts: RunnerOptions & { harness?: HeadHarness }): Promise<RunnerResult> {
  return runnerFor(opts.harness ?? "gjc").run(opts);
}

/** Starts the named harness early; see `prepare`. */
export function prepareHead(opts: Omit<RunnerOptions, "prompt" | "onUpdate" | "signal"> & { harness?: HeadHarness }): WarmRunner {
  return runnerFor(opts.harness ?? "gjc").prepare(opts);
}

/** Extracts the first JSON object from model text (tolerates code fences). */
export function parseJsonObject<T = any>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`no JSON object in model output: ${text.slice(0, 200)}`);
  return JSON.parse(body.slice(start, end + 1)) as T;
}

const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const isEffort = (e: unknown): e is string => EFFORTS.includes(e as string);

/** One model a head runner can use; `efforts` is null when the runner does not say which levels it takes. */
export interface RunnerModelInfo {
  id: string;
  efforts: string[] | null;
}

/**
 * Reads the "Provider models" table of `gjc --list-models` (provider, model, context, max-out,
 * thinking, images). Anthropic models are dropped: the list feeds the head's picker.
 */
export function parseGjcModelList(text: string): RunnerModelInfo[] {
  const out: RunnerModelInfo[] = [];
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
    if (ANTHROPIC_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const levels = cols[4]!.split(",").map((x) => x.trim()).filter(isEffort);
    out.push({ id, efforts: levels.length ? ["off", ...levels.filter((l) => l !== "off")] : /^(no|-)$/.test(cols[4]!) ? ["off"] : null });
  }
  return out;
}

/**
 * Reads `omp models --json` ({models: [{provider, id, selector, thinking}]}).
 * Anthropic models are dropped like every other head choice (ToS).
 */
export function parseOmpModelList(data: unknown): RunnerModelInfo[] {
  const out: RunnerModelInfo[] = [];
  const seen = new Set<string>();
  const models = (data as any)?.models;
  if (!Array.isArray(models)) return out;
  for (const m of models) {
    if (typeof m !== "object" || m === null) continue;
    const id = typeof m.selector === "string" && m.selector.includes("/") ? m.selector : typeof m.provider === "string" && typeof m.id === "string" ? `${m.provider}/${m.id}` : null;
    if (!id || ANTHROPIC_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const levels = Array.isArray(m.thinking) ? m.thinking.filter(isEffort) : [];
    out.push({ id, efforts: levels.length ? ["off", ...levels.filter((l: string) => l !== "off")] : ["off"] });
  }
  return out;
}

// Backwards-compatible names for the GJC-only surface (see lib/gjc).
export type { RunnerUpdate as GjcUpdate };
export type { RunnerOptions as GjcRunOptions };
export type { RunnerResult as GjcRunResult };
export type { WarmRunner as WarmGjc };
export { RunnerError as GjcError };
