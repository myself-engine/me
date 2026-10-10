// Protocol conformance suite: acts as a fake kernel against one plugin process.
// Usage: bun spec/conformance/run.ts <plugin-dir> [<plugin-dir>...]
// A plugin in any language that passes this is compatible with the kernel (DECISIONS §8).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Peer, RpcError, pumpLines, type LineTransport } from "../../protocol/rpc.ts";
import { PROTOCOL_VERSION, type CallParams, type ShutdownParams } from "../../protocol/types.ts";
import { loadManifest } from "../../kernel/src/manifest.ts";
import { loadSchema, validate, validateDef, type Schema } from "../schema.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ConformanceResult {
  pluginId: string;
  dir: string;
  ok: boolean;
  checks: Check[];
  /** Tail of the plugin's stderr, for diagnosing failures. */
  stderr: string[];
}

export interface ConformanceOptions {
  initTimeoutMs?: number;
  callTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  /** How long to keep listening after op.end for a forbidden second one. */
  opEndGraceMs?: number;
}

const TIMEOUT = Symbol("timeout");

function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<typeof TIMEOUT>((r) => (timer = setTimeout(() => r(TIMEOUT), ms)))]).finally(() =>
    clearTimeout(timer),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Outcome of one request: a result, a JSON-RPC error, a timeout, or the process going away. */
type Outcome =
  | { kind: "result"; value: unknown }
  | { kind: "error"; code: number; message: string }
  | { kind: "timeout" }
  | { kind: "closed" };

function describe(o: Outcome) {
  switch (o.kind) {
    case "result":
      return `result ${JSON.stringify(o.value)?.slice(0, 60)}`;
    case "error":
      return `error ${o.code} ${o.message.slice(0, 60)}`;
    case "timeout":
      return "no response";
    case "closed":
      return "process exited";
  }
}

/** Canned answers to kernel methods a plugin may call while being tested. */
function fakeKernel(method: string): unknown {
  switch (method) {
    case "emit":
    case "subscribe":
    case "entity.registerKind":
    case "op.subscribe":
    case "op.cancel":
      return {};
    case "entity.upsert":
      return { updatedSeq: 1 };
    case "entity.get":
      return null;
    case "entity.list":
    case "approval.list":
    case "journal.query":
      return [];
    case "invoke":
    case "approval.request":
    case "approval.decide":
      throw new RpcError(-32002, `${method} is not available during a conformance run`);
  }
  throw new RpcError(-32601, `unknown kernel method: ${method}`);
}

export async function runConformance(pluginDir: string, opts: ConformanceOptions = {}): Promise<ConformanceResult> {
  const initTimeout = opts.initTimeoutMs ?? 10_000;
  const callTimeout = opts.callTimeoutMs ?? 10_000;
  const shutdownTimeout = opts.shutdownTimeoutMs ?? 5_000;
  const grace = opts.opEndGraceMs ?? 300;

  const dir = resolve(pluginDir);
  const schema = await loadSchema();
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });

  const manifestPath = join(dir, "plugin.json");
  let manifest: Awaited<ReturnType<typeof loadManifest>>;
  try {
    manifest = await loadManifest(manifestPath);
  } catch (err) {
    check("manifest", false, String(err instanceof Error ? err.message : err));
    return { pluginId: "?", dir, ok: false, checks, stderr: [] };
  }
  const manifestErrors = validateDef(schema, "Manifest", await Bun.file(manifestPath).json());
  check("manifest", manifestErrors.length === 0, manifestErrors.join("; "));

  // Spawn exactly like Kernel.startProcess (kernel/src/kernel.ts).
  const dataRoot = mkdtempSync(join(tmpdir(), "me-conformance-"));
  const stderr: string[] = [];
  const stdoutViolations: string[] = [];
  const frameViolations: string[] = [];
  const ops = new Map<string, { updates: number; updatesAfterEnd: number; ends: unknown[] }>();
  const opState = (opId: string) => {
    let s = ops.get(opId);
    if (!s) ops.set(opId, (s = { updates: 0, updatesAfterEnd: 0, ends: [] }));
    return s;
  };

  let proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
  try {
    proc = Bun.spawn(manifest.run.command, {
      cwd: resolve(manifest.dir, manifest.run.cwd ?? "."),
      env: {
        ...process.env,
        ...(manifest.run.env ?? {}),
        ME_PLUGIN_ID: manifest.id,
        ME_DATA_DIR: join(dataRoot, "plugins", manifest.id),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    check("spawn", false, String(err));
    rmSync(dataRoot, { recursive: true, force: true });
    return { pluginId: manifest.id, dir, ok: false, checks, stderr };
  }

  let exited = false;
  const exitedP = proc.exited.then((code) => {
    exited = true;
    return code;
  });
  const stderrDone = pumpLines(proc.stderr, (l) => {
    stderr.push(l);
    if (stderr.length > 40) stderr.shift();
  });

  const lineCbs: ((l: string) => void)[] = [];
  const closeCbs: (() => void)[] = [];
  const transport: LineTransport = {
    send: (line) => {
      try {
        proc.stdin.write(line + "\n");
        proc.stdin.flush();
      } catch {
        /* process gone */
      }
    },
    onLine: (cb) => lineCbs.push(cb),
    onClose: (cb) => closeCbs.push(cb),
    close: () => proc.kill(),
  };
  // Inspect every raw stdout line before Peer sees it: Peer answers bad lines with -32700 and moves on.
  const stdoutDone = pumpLines(proc.stdout, (line) => {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      stdoutViolations.push(`not JSON: ${line.slice(0, 80)}`);
      return;
    }
    const errs = validateDef(schema, "RpcFrame", frame);
    if (errs.length) {
      stdoutViolations.push(`not a JSON-RPC 2.0 frame: ${line.slice(0, 80)}`);
      return;
    }
    lineCbs.forEach((cb) => cb(line));
  });
  // Close only after stdout drains, so a response written just before exit still reaches Peer.
  void Promise.all([exitedP, stdoutDone]).then(() => closeCbs.forEach((cb) => cb()));

  const kernelParams = (method: string): Schema | undefined => {
    const entry = schema.$defs.PluginToKernel!.properties![method];
    return entry?.allOf?.[1]?.properties?.params;
  };
  const checkParams = (method: string, params: unknown) => {
    const s = kernelParams(method);
    if (!s) return;
    for (const e of validate(schema, s, params, method)) frameViolations.push(e);
  };

  const peer = new Peer(transport, {
    onRequest: (method, params) => {
      checkParams(method, params);
      return fakeKernel(method);
    },
    onNotification: (method, params) => {
      checkParams(method, params);
      if (method === "op.update") {
        const s = opState(params?.opId);
        s.updates++;
        if (s.ends.length) s.updatesAfterEnd++;
      } else if (method === "op.end") {
        opState(params?.opId).ends.push(params);
      }
    },
  });

  const request = async (method: string, params: unknown, ms: number): Promise<Outcome> => {
    const r = await within(
      peer.request(method, params, 0).then(
        (value): Outcome => ({ kind: "result", value }),
        (err): Outcome =>
          exited || peer.isClosed
            ? { kind: "closed" }
            : { kind: "error", code: err?.code ?? -32603, message: String(err?.message ?? err) },
      ),
      ms,
    );
    return r === TIMEOUT ? { kind: "timeout" } : r;
  };

  let seq = 0;
  const callParams = (method: string, stream: boolean, opId?: string): CallParams => ({
    method,
    params: {},
    stream,
    ...(opId ? { opId } : {}),
    ctx: { seq: ++seq, traceId: "conformance", causationId: null, source: "kernel", ts: new Date().toISOString(), caller: "conformance" },
  });

  const methods = manifest.provides?.methods ?? [];
  const unknownMethod = "conformance.no-such-method";

  try {
    // §3 initialize
    const init = await request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, pluginId: manifest.id, grantedPermissions: manifest.permissions, config: {} },
      initTimeout,
    );
    const initErrs = init.kind === "result" ? validateDef(schema, "InitializeResult", init.value) : [];
    const initOk = init.kind === "result" && initErrs.length === 0 && (init.value as any).protocolVersion === PROTOCOL_VERSION;
    check(
      "initialize",
      initOk,
      init.kind === "result" ? initErrs.join("; ") || (initOk ? "" : "wrong protocolVersion") : `${describe(init)} within ${initTimeout}ms`,
    );

    if (initOk) {
      // §4 every provided method answers a call
      for (const m of methods) {
        const o = await request("call", callParams(m, false), callTimeout);
        check(`call ${m}`, o.kind === "result" || o.kind === "error", describe(o));
      }

      const u = await request("call", callParams(unknownMethod, false), callTimeout);
      check("unknown method → error", u.kind === "error", describe(u));

      // §5 streaming: acknowledged, then exactly one op.end (order-agnostic: op.end may beat the ack)
      for (const m of [...methods, unknownMethod]) {
        const opId = `conformance-${m}-${seq + 1}`;
        const o = await request("call", callParams(m, true, opId), callTimeout);
        const name = m === unknownMethod ? "stream unknown method → error, no op.end" : `stream ${m}`;
        if (o.kind === "result") {
          if (m === unknownMethod) {
            check(name, false, `acknowledged: ${describe(o)}`);
            continue;
          }
          const deadline = Date.now() + callTimeout;
          while (opState(opId).ends.length === 0 && Date.now() < deadline && !exited) await sleep(10);
          await sleep(grace);
          const s = opState(opId);
          const ok = s.ends.length === 1 && s.updatesAfterEnd === 0;
          check(
            name,
            ok,
            s.ends.length === 0
              ? `no op.end within ${callTimeout}ms`
              : s.ends.length > 1
                ? `${s.ends.length} op.end frames`
                : s.updatesAfterEnd
                  ? `${s.updatesAfterEnd} op.update after op.end`
                  : `${s.updates} op.update, 1 op.end (${(s.ends[0] as any)?.error ? "error" : "result"})`,
          );
        } else if (o.kind === "error") {
          await sleep(grace);
          const ends = opState(opId).ends.length;
          check(name, ends === 0, ends ? `rejected but sent ${ends} op.end` : describe(o));
        } else {
          check(name, false, describe(o));
        }
      }
    }

    // §3 shutdown
    const reason: ShutdownParams = { reason: "user" };
    const sd = exited ? ({ kind: "closed" } as Outcome) : await request("shutdown", reason, shutdownTimeout);
    check("shutdown", sd.kind === "result", describe(sd));
    const code = await within(exitedP, shutdownTimeout);
    check("exits after shutdown", code !== TIMEOUT, code === TIMEOUT ? `still running after ${shutdownTimeout}ms` : `exit code ${code}`);
  } finally {
    if (!exited) proc.kill("SIGKILL");
    await exitedP;
    await Promise.all([stdoutDone, stderrDone]).catch(() => {});
    rmSync(dataRoot, { recursive: true, force: true });
  }

  check("stdout carries only protocol frames", stdoutViolations.length === 0, stdoutViolations.slice(0, 3).join("; "));
  check("plugin → kernel frames match schema", frameViolations.length === 0, frameViolations.slice(0, 3).join("; "));

  return { pluginId: manifest.id, dir, ok: checks.every((c) => c.ok), checks, stderr };
}

export function formatResult(r: ConformanceResult): string {
  const width = Math.max(...r.checks.map((c) => c.name.length), 5);
  const lines = [`${r.ok ? "PASS" : "FAIL"}  ${r.pluginId}  (${r.dir})`, `  ${"check".padEnd(width)}  result  detail`];
  for (const c of r.checks) lines.push(`  ${c.name.padEnd(width)}  ${c.ok ? "PASS  " : "FAIL  "}  ${c.detail}`);
  if (!r.ok && r.stderr.length) lines.push("  stderr (tail):", ...r.stderr.slice(-10).map((l) => `    ${l}`));
  return lines.join("\n");
}

if (import.meta.main) {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    console.error("usage: bun spec/conformance/run.ts <plugin-dir> [<plugin-dir>...]");
    process.exit(2);
  }
  let ok = true;
  for (const d of dirs) {
    const r = await runConformance(d);
    console.log(formatResult(r) + "\n");
    ok &&= r.ok;
  }
  process.exit(ok ? 0 : 1);
}
