// Runs GJC headless in json mode and normalizes its events (spikes/gjc-headless/FINDINGS.md).
// Safety: always --no-mcp; tools are disabled unless explicitly allowed, and any tool
// execution outside `allowTools` aborts the run (GJC's own whitelist leaks).
import { mkdirSync } from "node:fs";
import { pumpLines } from "@me/protocol";

export type GjcUpdate =
  | { kind: "text_delta"; delta: string }
  | { kind: "thought_delta"; delta: string }
  | { kind: "tool_call"; toolCallId: string; toolName: string; intent?: string; args?: unknown }
  | { kind: "tool_result"; toolCallId: string; toolName: string; ok: boolean };

export interface GjcRunOptions {
  prompt: string;
  model: string;
  /** Sessions are bound to their cwd; reuse the same cwd to resume. */
  cwd: string;
  resume?: string;
  /** Tool names GJC may execute. Empty means no tools at all. */
  allowTools?: string[];
  systemPrompt?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  onUpdate?: (u: GjcUpdate) => void;
  signal?: AbortSignal;
  /** Retries on provider rate limits (429). */
  retries?: number;
  ephemeral?: boolean;
}

export interface GjcRunResult {
  text: string;
  sessionId: string | null;
  stopReason: string | null;
  violation: { toolName: string; args?: unknown } | null;
}

const ANTHROPIC_RE = /(anthropic|claude|opus|sonnet|haiku|fable)/i;

export class GjcError extends Error {
  constructor(
    message: string,
    readonly rateLimited = false,
  ) {
    super(message);
  }
}

/** Refuses Anthropic models: Claude may only run inside Claude Code (ToS). */
export function assertAllowedModel(model: string) {
  if (ANTHROPIC_RE.test(model)) throw new GjcError(`model ${model} is not allowed inside GJC (Claude runs only in Claude Code)`);
}

export async function runGjc(opts: GjcRunOptions): Promise<GjcRunResult> {
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    try {
      return await runOnce(opts);
    } catch (err) {
      if (err instanceof GjcError && err.rateLimited && attempt < retries && !opts.signal?.aborted) {
        await Bun.sleep(5_000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

function argsFor(opts: Omit<GjcRunOptions, "prompt">): string[] {
  assertAllowedModel(opts.model);
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

interface Running {
  proc: ReturnType<typeof Bun.spawn>;
  /** Resolves once the process exits; updates go to whatever `onUpdate` is set when they arrive. */
  done: Promise<GjcRunResult>;
  setHandlers(h: { onUpdate?: (u: GjcUpdate) => void; signal?: AbortSignal }): void;
}

/** Spawns GJC and consumes its event stream. With `prompt` undefined, GJC waits for the prompt on stdin. */
function spawnGjc(opts: Omit<GjcRunOptions, "prompt">, prompt: string | undefined): Running {
  const allow = opts.allowTools ?? [];
  const args = argsFor(opts);
  if (prompt !== undefined) args.push(prompt);
  const proc = Bun.spawn(args, { cwd: opts.cwd, stdin: prompt === undefined ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe" });
  let onUpdate = opts.onUpdate;
  let signal = opts.signal;
  const kill = () => proc.kill();
  if (signal) signal.addEventListener("abort", kill, { once: true });

  const done = (async (): Promise<GjcRunResult> => {
    let sessionId: string | null = null;
    let stopReason: string | null = null;
    let errorMessage: string | null = null;
    let text = "";
    let violation: GjcRunResult["violation"] = null;
    await pumpLines(proc.stdout as ReadableStream<Uint8Array>, (line) => {
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      switch (e.type) {
        case "session":
          sessionId ??= e.id;
          break;
        case "message_update": {
          const a = e.assistantMessageEvent;
          if (a?.type === "text_delta") onUpdate?.({ kind: "text_delta", delta: a.delta });
          else if (a?.type === "thinking_delta") onUpdate?.({ kind: "thought_delta", delta: a.delta });
          break;
        }
        case "tool_execution_start":
          if (!allow.includes(e.toolName)) {
            violation = { toolName: e.toolName, args: e.args };
            kill();
          }
          onUpdate?.({ kind: "tool_call", toolCallId: e.toolCallId, toolName: e.toolName, intent: e.intent, args: e.args });
          break;
        case "tool_execution_end":
          onUpdate?.({ kind: "tool_result", toolCallId: e.toolCallId, toolName: e.toolName, ok: !e.isError });
          break;
        case "message_end":
          if (e.message?.role === "assistant") {
            stopReason = e.message.stopReason ?? null;
            if (e.message.errorMessage) errorMessage = String(e.message.errorMessage);
            const t = (e.message.content ?? [])
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("");
            if (t) text = t;
          }
          break;
      }
    });
    await proc.exited;
    signal?.removeEventListener("abort", kill);

    if (violation) return { text, sessionId, stopReason: "guard_violation", violation };
    if (signal?.aborted) throw new GjcError("aborted");
    if (stopReason === "error") {
      const msg = errorMessage ?? "unknown error";
      throw new GjcError(`gjc error: ${msg.slice(0, 300)}`, /429|rate.?limit|temporarily unavailable/i.test(msg));
    }
    if (proc.exitCode !== 0 && !text) {
      const err = (await new Response(proc.stderr as ReadableStream<Uint8Array>).text()).slice(0, 300);
      throw new GjcError(`gjc exited ${proc.exitCode}: ${err}`);
    }
    return { text, sessionId, stopReason, violation: null };
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

async function runOnce(opts: GjcRunOptions): Promise<GjcRunResult> {
  return spawnGjc(opts, opts.prompt).done;
}

export interface WarmGjc {
  /** Sends the prompt to the already running GJC. Falls back to a fresh run (with retries) on rate limits. */
  run(prompt: string, h: { onUpdate?: (u: GjcUpdate) => void; signal?: AbortSignal }): Promise<GjcRunResult>;
  /** Stops the waiting process when the prompt will never come (e.g. the message was delegated). */
  cancel(): void;
}

/**
 * Starts GJC before the prompt is known so process start, auth and session resume overlap with
 * whatever decides what to say (about 1–1.5s saved per reply, measured 2026-10-11).
 */
export function prepareGjc(opts: Omit<GjcRunOptions, "prompt" | "onUpdate" | "signal">): WarmGjc {
  const running = spawnGjc(opts, undefined);
  let used = false;
  running.done.catch(() => {});
  return {
    async run(prompt, h) {
      if (used) throw new GjcError("warm gjc already used");
      used = true;
      running.setHandlers(h);
      const stdin = running.proc.stdin as import("bun").FileSink;
      stdin.write(prompt);
      await stdin.end();
      try {
        return await running.done;
      } catch (err) {
        if (err instanceof GjcError && err.rateLimited && !h.signal?.aborted) {
          return runGjc({ ...opts, prompt, onUpdate: h.onUpdate, signal: h.signal });
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

/** Extracts the first JSON object from model text (tolerates code fences). */
export function parseJsonObject<T = any>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`no JSON object in model output: ${text.slice(0, 200)}`);
  return JSON.parse(body.slice(start, end + 1)) as T;
}
