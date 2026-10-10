// Runs one configured command as a child process: argv only, never a shell.
import { resolve } from "node:path";
import { ErrorCode, RpcError } from "@me/protocol";
import {
  DEFAULT_TIMEOUT_MS,
  STDERR_LIMIT,
  substituteArgv,
  substituteCwd,
  validateParams,
  type CommandSpec,
} from "./config.ts";

export interface RunResult {
  exitCode: number;
  stdout: unknown;
  stderr: string;
  stderrTruncated?: boolean;
}

export interface RunOptions {
  /** Base directory for a relative cwd. */
  baseCwd?: string;
  signal?: AbortSignal;
  /** Called for each stdout line when the command is configured with `stream: true`. */
  onLine?: (line: string) => void;
  /** Grace period between SIGTERM and SIGKILL. */
  killGraceMs?: number;
}

/** Children still running, so shutdown can kill them. */
export const liveChildren = new Set<{ kill(signal?: number | NodeJS.Signals): void }>();

function parseStdout(mode: CommandSpec["parse"], text: string, exitCode: number): unknown {
  if (mode === "lines") return text.split("\n").filter((l, i, all) => !(i === all.length - 1 && l === "")).map((l) => l.replace(/\r$/, ""));
  if (mode === "json") {
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      // A failed command often prints plain text; keep that a result rather than hide it.
      if (exitCode !== 0) return text;
      throw new RpcError(-32603, "stdout is not valid JSON", { stdout: text.slice(0, STDERR_LIMIT) });
    }
  }
  return text;
}

async function* chunks(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    yield value;
  }
}

/** Accumulates a child's stdout, optionally splitting it into lines as they arrive. */
async function collect(stream: ReadableStream<Uint8Array>, out: { text: string }, onLine?: (line: string) => void) {
  const decoder = new TextDecoder();
  let pending = "";
  const push = (s: string) => {
    out.text += s;
    if (!onLine) return;
    pending += s;
    let nl: number;
    while ((nl = pending.indexOf("\n")) >= 0) {
      onLine(pending.slice(0, nl).replace(/\r$/, ""));
      pending = pending.slice(nl + 1);
    }
  };
  for await (const chunk of chunks(stream)) push(decoder.decode(chunk, { stream: true }));
  push(decoder.decode());
  if (onLine && pending) onLine(pending);
}

/** Keeps the first `limit` bytes and drains the rest so the child never blocks on a full pipe. */
async function collectCapped(stream: ReadableStream<Uint8Array>, limit: number, out: { bytes: Uint8Array[]; kept: number; truncated: boolean }) {
  for await (const chunk of chunks(stream)) {
    if (out.kept >= limit) {
      out.truncated = true;
      continue;
    }
    const take = chunk.subarray(0, limit - out.kept);
    if (take.length < chunk.length) out.truncated = true;
    out.bytes.push(take);
    out.kept += take.length;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runCommand(name: string, cmd: CommandSpec, rawParams: unknown, opts: RunOptions = {}): Promise<RunResult> {
  let values;
  try {
    values = validateParams(cmd, rawParams);
  } catch (err) {
    throw new RpcError(-32602, `${name}: ${(err as Error).message}`);
  }
  const argv = substituteArgv(cmd.argv, values);
  const base = opts.baseCwd ?? process.cwd();
  const cwd = cmd.cwd !== undefined ? resolve(base, substituteCwd(cmd.cwd, values)) : base;
  const timeoutMs = cmd.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (opts.signal?.aborted) throw new RpcError(ErrorCode.Cancelled, `${name}: cancelled`);

  let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
  try {
    // stdin is ignored: the plugin's own stdin is the protocol pipe and must never reach the child.
    proc = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    throw new RpcError(-32603, `${name}: cannot start ${argv[0]}: ${(err as Error).message}`);
  }
  liveChildren.add(proc);

  let stopped: "timeout" | "cancelled" | null = null;
  let onStop = () => {};
  const stoppedP = new Promise<void>((r) => (onStop = r));
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (why: "timeout" | "cancelled") => {
    if (stopped) return;
    stopped = why;
    proc.kill("SIGTERM");
    killTimer = setTimeout(() => proc.kill("SIGKILL"), opts.killGraceMs ?? 1_000);
    onStop();
  };
  const timer = setTimeout(() => stop("timeout"), timeoutMs);
  const onAbort = () => stop("cancelled");
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const stdout = { text: "" };
  const stderr = { bytes: [] as Uint8Array[], kept: 0, truncated: false };
  const io = Promise.all([collect(proc.stdout, stdout, cmd.stream ? opts.onLine : undefined), collectCapped(proc.stderr, STDERR_LIMIT, stderr)]);
  try {
    const exitCode = await proc.exited;
    // A grandchild can keep the pipes open after the child exits; don't wait on it past the deadline.
    await Promise.race([io, stoppedP.then(() => sleep(200))]);
    if (stopped === "timeout") throw new RpcError(ErrorCode.Timeout, `${name}: timed out after ${timeoutMs}ms; process killed`);
    if (stopped === "cancelled") throw new RpcError(ErrorCode.Cancelled, `${name}: cancelled; process killed`);
    const result: RunResult = {
      exitCode,
      stdout: parseStdout(cmd.parse, stdout.text, exitCode),
      stderr: new TextDecoder().decode(Buffer.concat(stderr.bytes)),
    };
    if (stderr.truncated) result.stderrTruncated = true;
    if (exitCode !== 0 && cmd.failOnNonZero) {
      throw new RpcError(-32603, `${name}: exited with code ${exitCode}`, result as any);
    }
    return result;
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    opts.signal?.removeEventListener("abort", onAbort);
    liveChildren.delete(proc);
  }
}
