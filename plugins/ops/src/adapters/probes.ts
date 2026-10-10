// Probe adapters, one per check kind. All of them only look: GET requests, TCP connect-then-close,
// and read-only commands (`ps`, `launchctl print`, `herdr pane get`, and the user's own argv).
import { createConnection } from "node:net";
import type { CheckSpec, Observation } from "../domain/check.ts";
import { interpretCommand, interpretHerdrPane, interpretLaunchctl, interpretProcessList } from "../domain/interpret.ts";
import type { Exec, ExecResult, Probe } from "../ports/index.ts";

const SHELL_TIMEOUT_MS = 5_000;
const elapsed = (start: number) => performance.now() - start;
const errText = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 200);

/** Exec failures that say nothing about the target itself. */
function execTrouble(r: ExecResult, what: string, latencyMs: number): Observation | null {
  if (r.spawnError) return { status: "unknown", detail: `${what} could not start: ${r.spawnError.slice(0, 200)}`, latencyMs };
  if (r.timedOut) return { status: "unknown", detail: `${what} timed out`, latencyMs };
  return null;
}

export async function httpProbe(spec: Extract<CheckSpec, { kind: "http" }>, fetchFn: typeof fetch = fetch): Promise<Observation> {
  const start = performance.now();
  try {
    const res = await fetchFn(spec.url, { method: "GET", signal: AbortSignal.timeout(spec.timeoutMs), headers: { "user-agent": "me-ops/0.1" } });
    const body = spec.contains !== undefined ? await res.text() : (await res.body?.cancel(), "");
    const latencyMs = elapsed(start);
    if (res.status !== spec.expectStatus) return { status: "down", detail: `HTTP ${res.status} (expected ${spec.expectStatus})`, latencyMs };
    if (spec.contains !== undefined && !body.includes(spec.contains)) {
      return { status: "down", detail: `HTTP ${res.status}, body lacks "${spec.contains.slice(0, 60)}"`, latencyMs };
    }
    return { status: "up", detail: `HTTP ${res.status}`, latencyMs };
  } catch (err) {
    const latencyMs = elapsed(start);
    const name = (err as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") return { status: "down", detail: `timed out after ${spec.timeoutMs}ms`, latencyMs };
    return { status: "down", detail: errText(err), latencyMs };
  }
}

export function tcpProbe(spec: Extract<CheckSpec, { kind: "tcp" }>): Promise<Observation> {
  const start = performance.now();
  return new Promise((resolve) => {
    const socket = createConnection({ host: spec.host, port: spec.port });
    let settled = false;
    const done = (o: Observation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(o);
    };
    const timer = setTimeout(() => done({ status: "down", detail: `timed out after ${spec.timeoutMs}ms`, latencyMs: elapsed(start) }), spec.timeoutMs);
    socket.once("connect", () => done({ status: "up", detail: `connected to ${spec.host}:${spec.port}`, latencyMs: elapsed(start) }));
    socket.once("error", (err) => done({ status: "down", detail: errText(err), latencyMs: elapsed(start) }));
  });
}

export async function processProbe(spec: Extract<CheckSpec, { kind: "process" }>, exec: Exec): Promise<Observation> {
  const start = performance.now();
  const r = await exec.run(["ps", "-axo", "pid=,command="], SHELL_TIMEOUT_MS);
  const latencyMs = elapsed(start);
  const trouble = execTrouble(r, "ps", latencyMs);
  if (trouble) return trouble;
  if (r.code !== 0) return { status: "unknown", detail: `ps exited ${r.code}`, latencyMs };
  return interpretProcessList(r.stdout, spec.match, [process.pid, ...(r.pid ? [r.pid] : [])], latencyMs);
}

export async function launchdProbe(spec: Extract<CheckSpec, { kind: "launchd" }>, exec: Exec, uid: number | null, platform: string): Promise<Observation> {
  if (platform !== "darwin" || uid === null) return { status: "unknown", detail: "launchd checks need macOS", latencyMs: 0 };
  const start = performance.now();
  const r = await exec.run(["launchctl", "print", `gui/${uid}/${spec.label}`], SHELL_TIMEOUT_MS);
  const latencyMs = elapsed(start);
  return execTrouble(r, "launchctl", latencyMs) ?? interpretLaunchctl(r.code, r.stdout, r.stderr, latencyMs);
}

export async function herdrPaneProbe(spec: Extract<CheckSpec, { kind: "herdr-pane" }>, exec: Exec, herdrBin = "herdr"): Promise<Observation> {
  const start = performance.now();
  const r = await exec.run([herdrBin, "pane", "get", spec.paneId], SHELL_TIMEOUT_MS);
  const latencyMs = elapsed(start);
  return execTrouble(r, "herdr", latencyMs) ?? interpretHerdrPane(r.code, r.stdout, r.stderr, latencyMs);
}

export async function commandProbe(spec: Extract<CheckSpec, { kind: "command" }>, exec: Exec): Promise<Observation> {
  const start = performance.now();
  const r = await exec.run(spec.argv, spec.timeoutMs);
  const latencyMs = elapsed(start);
  if (r.spawnError) return { status: "down", detail: `could not start ${spec.argv[0]}: ${r.spawnError.slice(0, 200)}`, latencyMs };
  if (r.timedOut) return { status: "down", detail: `timed out after ${spec.timeoutMs}ms`, latencyMs };
  return interpretCommand(r.code, spec.expectExit, r.stdout, r.stderr, latencyMs);
}

export interface ProbeDeps {
  exec: Exec;
  fetch?: typeof fetch;
  uid?: number | null;
  platform?: string;
  herdrBin?: string;
}

/** One Probe that dispatches on spec.kind. */
export function createProbe(deps: ProbeDeps): Probe {
  const uid = deps.uid !== undefined ? deps.uid : (process.getuid?.() ?? null);
  const platform = deps.platform ?? process.platform;
  return async (spec) => {
    try {
      switch (spec.kind) {
        case "http":
          return await httpProbe(spec, deps.fetch);
        case "tcp":
          return await tcpProbe(spec);
        case "process":
          return await processProbe(spec, deps.exec);
        case "launchd":
          return await launchdProbe(spec, deps.exec, uid, platform);
        case "herdr-pane":
          return await herdrPaneProbe(spec, deps.exec, deps.herdrBin);
        case "command":
          return await commandProbe(spec, deps.exec);
      }
    } catch (err) {
      return { status: "unknown", detail: `probe failed: ${errText(err)}`, latencyMs: 0 };
    }
  };
}
