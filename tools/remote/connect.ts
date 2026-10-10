// Remote relay (`me connect`): runs an unmodified plugin on a server and connects it to a kernel over TCP.
// The plugin is spawned over stdio exactly as the kernel would spawn it; its frames are relayed verbatim to the
// kernel after `hello`, except `initialize`, whose config comes from this machine. Spec: docs/PROTOCOL.md §1, §3.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { ErrorCode, RpcError, pumpLines, type JsonValue, type LineTransport, type Manifest } from "@me/protocol";
import { dial } from "@me/sdk";
import { loadManifest, type LoadedManifest } from "../../kernel/src/manifest.ts";

export interface RemoteOptions {
  /** Folder with plugin.json. */
  pluginDir: string;
  /** Registers the plugin under another id (e.g. ops-rapi), so one plugin can run on several machines. */
  id?: string;
  /** The kernel's TCP listener (its tailnet address). */
  host: string;
  port: number;
  /** Connect token file copied from the kernel machine. Defaults to $ME_HOME/connect.token. */
  tokenPath?: string;
  /** The token itself, instead of `tokenPath`. */
  token?: string;
  /** Plugin config sent in `initialize` (the kernel's pluginConfig does not know remote plugins). */
  config?: Record<string, JsonValue>;
  /** Local data dir for ME_DATA_DIR and logs/<id>.log. Defaults to $ME_HOME or ~/.me. */
  dataDir?: string;
  /** Reconnect/respawn delay: doubles from initialMs up to maxMs, reset after a successful hello. */
  backoff?: { initialMs?: number; maxMs?: number };
  log?: (msg: string) => void;
}

export interface RemoteHandle {
  manifest: LoadedManifest;
  /** pid of the local plugin process, or null while it is down. */
  readonly pid: number | null;
  /** Whether the relay currently has a kernel connection past `hello`. */
  readonly connected: boolean;
  /** Resolves after `stop()`; rejects if the kernel refuses the hello for good (bad token, bad manifest, version). */
  done: Promise<void>;
  /** Disconnects and stops the local plugin. */
  stop(): Promise<void>;
}

/** Hello rejections that retrying cannot fix; a bad token retried would also trip the kernel's rate limit. */
const FATAL = new Set<number>([ErrorCode.PermissionDenied, ErrorCode.ProtocolMismatch, -32602]);

export async function runRemote(opts: RemoteOptions): Promise<RemoteHandle> {
  const loaded = await loadManifest(join(resolve(opts.pluginDir), "plugin.json"));
  if (opts.id !== undefined && !/^[a-z][a-z0-9-]*$/.test(opts.id)) throw new Error(`invalid --id ${opts.id}`);
  const manifest = opts.id ? { ...loaded, id: opts.id } : loaded;
  const { dir: _dir, ...wire } = manifest;
  const id = manifest.id;
  const dataDir = opts.dataDir ?? process.env.ME_HOME ?? join(homedir(), ".me");
  const logPath = join(dataDir, "logs", `${id}.log`);
  mkdirSync(join(dataDir, "logs"), { recursive: true });
  const log = opts.log ?? ((m: string) => console.error(`[remote ${id}] ${m}`));
  const initialMs = opts.backoff?.initialMs ?? 500;
  const maxMs = opts.backoff?.maxMs ?? 30_000;

  let proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  let kernel: LineTransport | null = null;
  let stopped = false;
  let wake: (() => void) | null = null;
  let resolveDone!: () => void;
  let rejectDone!: (e: unknown) => void;
  const done = new Promise<void>((res, rej) => ((resolveDone = res), (rejectDone = rej)));

  /** Same spawn as the kernel's exec mode A: cwd, env, stdio pipes, stderr to the plugin log. */
  const spawnPlugin = () => {
    const p = Bun.spawn(manifest.run.command, {
      cwd: resolve(manifest.dir, manifest.run.cwd ?? "."),
      env: { ...process.env, ...(manifest.run.env ?? {}), ME_PLUGIN_ID: id, ME_DATA_DIR: join(dataDir, "plugins", id) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc = p;
    void pumpLines(p.stderr, (line) => appendFileSync(logPath, line + "\n"));
    // Frames sent while no kernel is connected are dropped; the plugin's own request timeouts cover them.
    void pumpLines(p.stdout, (line) => kernel?.send(line));
    void p.exited.then((code) => {
      if (proc !== p) return;
      proc = null;
      if (!stopped) log(`plugin exited (${code}); restarting`);
      kernel?.close(); // the kernel marks it stopped and fails its in-flight ops
      wake?.();
    });
  };

  const toPlugin = (line: string) => {
    let out = line;
    try {
      const frame = JSON.parse(line);
      if (frame?.method === "initialize" && frame.params && typeof frame.params === "object") {
        out = JSON.stringify({ ...frame, params: { ...frame.params, config: opts.config ?? {} } });
      }
    } catch {
      /* not ours to judge; relay as is */
    }
    try {
      proc?.stdin.write(out + "\n");
      proc?.stdin.flush();
    } catch {
      /* process gone; its exit handler closes the kernel side */
    }
  };

  /** Relays until the kernel connection closes. */
  const session = (transport: LineTransport) =>
    new Promise<void>((res) => {
      kernel = transport;
      transport.onLine(toPlugin);
      transport.onClose(() => {
        if (kernel === transport) kernel = null;
        res();
      });
      if (!proc || stopped) transport.close();
    });

  const pause = (ms: number) =>
    new Promise<void>((res) => {
      const t = setTimeout(() => ((wake = null), res()), ms);
      wake = () => (clearTimeout(t), (wake = null), res());
    });

  void (async () => {
    let delay = initialMs;
    while (!stopped) {
      if (!proc) spawnPlugin();
      try {
        const { transport } = await dial({ tcp: { host: opts.host, port: opts.port }, token: opts.token, tokenPath: opts.tokenPath, manifest: wire as Manifest });
        if (stopped) {
          transport.close();
          break;
        }
        log(`connected to ${opts.host}:${opts.port}`);
        delay = initialMs;
        await session(transport);
        if (!stopped) log("kernel connection closed; reconnecting");
      } catch (err) {
        if (err instanceof RpcError && FATAL.has(err.code)) {
          log(`kernel refused hello: ${err.message}`);
          await shutdown();
          rejectDone(err);
          return;
        }
        if (!stopped) log(`connect failed: ${(err as Error).message}; retrying in ${delay}ms`);
      }
      if (stopped) break;
      await pause(delay);
      delay = Math.min(delay * 2, maxMs);
    }
    resolveDone();
  })();

  async function shutdown() {
    stopped = true;
    wake?.();
    kernel?.close();
    const p = proc;
    proc = null;
    if (p) {
      p.kill();
      await Promise.race([p.exited, Bun.sleep(5_000)]);
      if (p.exitCode === null && p.signalCode === null) p.kill(9);
    }
  }

  return {
    manifest,
    get pid() {
      return proc?.pid ?? null;
    },
    get connected() {
      return kernel !== null;
    },
    done,
    async stop() {
      if (!stopped) await shutdown();
      // A dial in flight to an unreachable host can take the OS connect timeout; don't wait for it.
      await Promise.race([done.catch(() => {}), Bun.sleep(2_000)]);
    },
  };
}
