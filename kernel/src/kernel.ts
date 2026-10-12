// The kernel: supervisor, router, permissions, journal, events, entities, ops, approvals.
// Spec: docs/PROTOCOL.md. The kernel knows no domain concepts — only plugins, frames and kinds.
import { mkdirSync, appendFileSync, chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, isIPv4, isIPv6, type AddressInfo, type Server, type Socket } from "node:net";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { Subprocess } from "bun";
import {
  ErrorCode,
  PROTOCOL_VERSION,
  Peer,
  RpcError,
  pumpLines,
  socketLineTransport,
  takeFirstLine,
  type ApprovalDecision,
  type ApprovalRequestParams,
  type EntityListParams,
  type FrameContext,
  type InvokeParams,
  type JournalQueryParams,
  type JsonValue,
  type KernelOpEntity,
  type KernelPluginEntity,
  type TraceNode,
  type TraceResult,
  type LineTransport,
  type OpEndParams,
  type OpUpdateParams,
  type Permission,
} from "@me/protocol";
import { hasPermission, matchPattern, validateManifest, type LoadedManifest } from "./manifest.ts";
import { childEnv } from "@me/env";
import { Store, type JournalType } from "./store.ts";
import { validateAgainstSchema } from "./schema.ts";

type HostState = KernelPluginEntity["state"];
type HostMode = KernelPluginEntity["mode"];

interface Host {
  manifest: LoadedManifest;
  lastError?: { at: string; method: string; message: string } | null;
  state: HostState;
  peer: Peer | null;
  proc: Subprocess<"pipe", "pipe", "pipe"> | null;
  restartTimes: number[];
  restarts: number;
  subscriptions: string[];
  ready: Promise<void>;
  markReady: () => void;
  /** Whether the current `ready` promise has resolved; a restart only re-arms a settled one. */
  readySettled: boolean;
  stopping: boolean;
  /** Only spawned plugins are respawned; attached and connected ones stop when their transport closes. */
  mode: HostMode;
  /** Peer address of a plugin connected in over TCP. */
  remote: RemoteAddress | null;
}

interface Op {
  id: string;
  caller: string;
  callee: string; // plugin id, or "kernel" for approvals
  subscribers: Set<string>;
  traceId: string;
  causationId: number;
  method: string;
  startedAt: string;
  state: KernelOpEntity["state"];
  phase: string | null;
  phaseLabel: string | null;
  progress: number | null;
  /** Stream deltas delivered live but not journaled yet; consecutive deltas of one kind are merged. */
  pending: { kind: string; delta: string; count: number }[];
  pendingBytes: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** seq of the op's latest journal entry. */
  lastSeq: number;
}

/** Recent ops kept as kernel.op entities after they end. */
const OP_HISTORY = 500;
/** Buffered deltas are journaled at least this often, and as soon as they exceed DELTA_MAX_BYTES. */
const DELTA_FLUSH_MS = 1_000;
const DELTA_MAX_BYTES = 64 * 1024;
const DAY_MS = 86_400_000;

/** A stream delta per PROTOCOL §5: `{kind: "<name>_delta", delta: string}` with nothing else. */
function isDelta(u: any): u is { kind: string; delta: string } {
  return (
    !!u && typeof u === "object" && typeof u.kind === "string" && u.kind.endsWith("_delta") && typeof u.delta === "string" &&
    Object.keys(u).length === 2
  );
}

interface Approval {
  id: string;
  opId: string;
  requester: string;
  params: ApprovalRequestParams;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface KernelOptions {
  dataDir: string;
  /** Called for diagnostics; defaults to console.error. */
  log?: (msg: string) => void;
  initializeTimeoutMs?: number;
  /** Per-plugin config passed in `initialize`. */
  pluginConfig?: Record<string, Record<string, JsonValue>>;
  /** Extra parent env names kept for every plugin child (config `env.pass`); appended to each manifest's `run.envPass`. */
  envPass?: string[];
  /** Journal retention and delta coalescing; see JournalOptions. */
  journal?: JournalOptions;
}

export interface JournalOptions {
  /** Entries older than this are deleted. Default 14; 0 keeps them forever. */
  maxAgeDays?: number;
  /** At most this many newest entries are kept. Default 200000; 0 means no limit. */
  maxRows?: number;
  /** How often pruning runs after the one at startup. Default 3600. */
  pruneIntervalSec?: number;
  /** Buffered stream deltas are journaled at least this often. Default 1000. */
  deltaFlushMs?: number;
}

export const DEFAULT_JOURNAL = { maxAgeDays: 14, maxRows: 200_000, pruneIntervalSec: 3600, deltaFlushMs: DELTA_FLUSH_MS };

/** What a connect-in plugin may be granted when config sets no `connectPermissions`. */
export const DEFAULT_CONNECT_PERMISSIONS: Permission[] = ["read-state", "emit", "subscribe"];

export interface ListenOptions {
  /** Unix socket path; created with mode 0600. */
  path: string;
  /** Shared secret file; created (0600, 32 random bytes hex) if missing. Defaults to <dataDir>/connect.token. */
  tokenPath?: string;
  /** Upper bound on a connect-in plugin's permissions: it gets the intersection with what it declares. */
  permissions?: Permission[];
  /** Time a new connection has to send `hello`. */
  helloTimeoutMs?: number;
}

export interface RemoteAddress {
  address: string;
  port: number;
}

export interface ListenTcpOptions {
  /** IP literal to bind. Must be loopback or a Tailscale address unless `allowAnyHost` is set. */
  host: string;
  /** 0 picks a free port; `listenTcp` returns the bound one. */
  port: number;
  /** Allows 0.0.0.0, ::, LAN addresses and host names. */
  allowAnyHost?: boolean;
  /** Same token file as the Unix socket. Defaults to <dataDir>/connect.token. */
  tokenPath?: string;
  /** Upper bound on a TCP plugin's permissions (config `remotePermissions`, default connectPermissions). */
  permissions?: Permission[];
  helloTimeoutMs?: number;
}

/** After this many failed hellos from one address within the window, its new connections are dropped for BAN_MS. */
const MAX_HELLO_FAILURES = 5;
const FAILURE_WINDOW_MS = 60_000;
const BAN_MS = 60_000;
/** An unauthenticated TCP peer may not send more than this before its hello line ends. */
const MAX_HELLO_BYTES = 1 << 20;

/** Strips the IPv4-mapped prefix node reports for dual-stack sockets (::ffff:1.2.3.4). */
function plainAddress(a: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  return m ? m[1]! : a;
}

/** Expands an IPv6 literal to eight 16-bit groups, or null if it is not one. */
function ipv6Groups(a: string): number[] | null {
  if (!isIPv6(a)) return null;
  let s = a.toLowerCase().split("%")[0]!;
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [, a1, b1, c1, d1] = v4.map(Number) as number[];
    s = s.slice(0, v4.index) + `${((a1! << 8) | b1!).toString(16)}:${((c1! << 8) | d1!).toString(16)}`;
  }
  const [head, tail] = s.includes("::") ? s.split("::") : [s, null];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return groups.map((g) => parseInt(g, 16));
}

/**
 * Whether the kernel may bind `host` for TCP connect-in: loopback, Tailscale CGNAT (100.64.0.0/10) or
 * Tailscale IPv6 (fd7a:115c:a1e0::/48). Anything else, including wildcards and host names, needs `allowAnyHost`.
 */
export function isAllowedTcpHost(host: string, allowAnyHost = false): boolean {
  if (allowAnyHost) return true;
  const h = plainAddress(host);
  if (isIPv4(h)) {
    const [a, b] = h.split(".").map(Number) as [number, number];
    return a === 127 || (a === 100 && b >= 64 && b <= 127);
  }
  const g = ipv6Groups(h);
  if (!g) return false;
  const loopback = g.slice(0, 7).every((x) => x === 0) && g[7] === 1;
  return loopback || (g[0] === 0xfd7a && g[1] === 0x115c && g[2] === 0xa1e0);
}

interface HelloContext {
  token: string;
  /** Permission cap for this listener. */
  allow: Permission[];
  /** Label used as the manifest's dir. */
  where: string;
  /** Set for TCP connections. */
  remote: RemoteAddress | null;
}

const KERNEL = "kernel";

/** Reads the connect token, creating it on first start. */
export function ensureConnectToken(path: string): string {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
    chmodSync(path, 0o600);
  }
  const token = readFileSync(path, "utf8").trim();
  if (!token) throw new Error(`connect token is empty: ${path}`);
  return token;
}

function sameSecret(a: string, b: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** Removes a socket file left by a dead kernel; refuses if a live kernel still answers on it. */
async function clearStaleSocket(path: string) {
  if (!existsSync(path)) return;
  const live = await new Promise<boolean>((res) => {
    const probe = createConnection(path);
    probe.once("connect", () => (probe.destroy(), res(true)));
    probe.once("error", () => res(false));
  });
  if (live) throw new Error(`another kernel is listening on ${path}`);
  rmSync(path, { force: true });
}

export class Kernel {
  readonly store: Store;
  private hosts = new Map<string, Host>();
  private ops = new Map<string, Op>();
  private approvals = new Map<string, Approval>();
  private log: (msg: string) => void;
  private stopped = false;
  private server: { server: Server; path: string } | null = null;
  private tcpServer: Server | null = null;
  /** Failed TCP hellos per remote address, for rate limiting. */
  private helloFailures = new Map<string, { times: number[]; bannedUntil: number }>();
  /** Open connect-in sockets, resolved when each closes. */
  private sockets = new Map<Socket, Promise<void>>();
  private journalOpts: Required<JournalOptions>;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private opts: KernelOptions) {
    mkdirSync(opts.dataDir, { recursive: true });
    mkdirSync(join(opts.dataDir, "logs"), { recursive: true });
    this.store = new Store(join(opts.dataDir, "me.sqlite"));
    this.log = opts.log ?? ((m) => console.error(`[kernel] ${m}`));
    this.store.registerKind("kernel.plugin", KERNEL, { type: "object", required: ["id", "state"] });
    this.store.registerKind("kernel.op", KERNEL, { type: "object", required: ["opId", "state", "method"] });
    // Ops that were live when the last kernel stopped can never finish now.
    for (const doc of this.store.list("kernel.op", { state: "running" }, 1000).concat(this.store.list("kernel.op", { state: "waiting" }, 1000))) {
      const op = doc.data as KernelOpEntity;
      this.store.upsert("kernel.op", op.opId, { ...op, state: "failed", error: "kernel restarted", endedAt: op.updatedAt }, doc.updatedSeq);
    }
    this.store.prune("kernel.op", OP_HISTORY);
    this.journalOpts = { ...DEFAULT_JOURNAL, ...opts.journal };
    this.pruneJournal();
    if (this.journalOpts.pruneIntervalSec > 0) {
      this.pruneTimer = setInterval(() => this.pruneJournal(), this.journalOpts.pruneIntervalSec * 1000);
      this.pruneTimer.unref?.();
    }
  }

  /** Applies the retention limits, then checkpoints the WAL so the file shrinks back. */
  pruneJournal(now = Date.now()): number {
    const { maxAgeDays, maxRows } = this.journalOpts;
    const deleted = this.store.pruneJournal({
      before: maxAgeDays > 0 ? new Date(now - maxAgeDays * DAY_MS).toISOString() : null,
      maxRows: maxRows > 0 ? maxRows : null,
    });
    if (deleted > 0) this.log(`journal: pruned ${deleted} entries`);
    return deleted;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Registers and spawns a plugin process (exec mode A). */
  async spawn(manifest: LoadedManifest): Promise<void> {
    const host = this.register(manifest, "spawned");
    if (!host) return;
    this.startProcess(host);
    await host.ready.catch(() => {});
  }

  /** Attaches a plugin over an existing transport (tests, in-process plugins, connect-in sockets). */
  async attach(
    manifest: LoadedManifest,
    transport: LineTransport,
    mode: "attached" | "connected" = "attached",
    remote: RemoteAddress | null = null,
  ): Promise<void> {
    const host = this.register(manifest, mode, remote);
    if (!host) return;
    this.connect(host, transport);
    await host.ready;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    await Promise.all(
      [...this.hosts.values()].map(async (h) => {
        h.stopping = true;
        if (h.peer && !h.peer.isClosed) {
          await h.peer.request("shutdown", { reason: "kernel-exit" }, 5_000).catch(() => {});
        }
        const proc = h.proc;
        if (proc) {
          proc.kill();
          await Promise.race([proc.exited, Bun.sleep(5_000)]);
          if (proc.exitCode === null) proc.kill(9);
        } else h.peer?.close();
      }),
    );
    if (this.server) {
      this.server.server.close();
      rmSync(this.server.path, { force: true });
    }
    this.tcpServer?.close();
    // Wait for socket close handlers so they run before the store closes.
    const closing = [...this.sockets.values()];
    for (const sock of this.sockets.keys()) sock.destroy();
    await Promise.race([Promise.all(closing), Bun.sleep(2_000)]);
    for (const a of this.approvals.values()) if (a.timer) clearTimeout(a.timer);
    for (const op of this.ops.values()) this.flushDeltas(op);
    this.store.close();
  }

  pluginState(id: string): HostState | null {
    return this.hosts.get(id)?.state ?? null;
  }

  // -------------------------------------------------------------------------
  // Exec mode B: plugins that connect in over a Unix socket
  // -------------------------------------------------------------------------

  /** Accepts connect-in plugins on a Unix socket (mode 0600). Each must send `hello` with the connect token first. */
  async listen(o: ListenOptions): Promise<void> {
    if (this.server) throw new Error(`already listening on ${this.server.path}`);
    const token = ensureConnectToken(o.tokenPath ?? join(this.opts.dataDir, "connect.token"));
    const allow = o.permissions ?? DEFAULT_CONNECT_PERMISSIONS;
    mkdirSync(dirname(o.path), { recursive: true });
    await clearStaleSocket(o.path);
    const ctx: HelloContext = { token, allow, where: o.path, remote: null };
    const server = createServer((sock) => this.accept(sock, ctx, o.helloTimeoutMs ?? 10_000));
    const umask = process.umask(0o177); // no window where the socket is group/world accessible
    try {
      await new Promise<void>((res, rej) => {
        server.once("error", rej);
        server.listen(o.path, () => {
          server.off("error", rej);
          res();
        });
      });
    } finally {
      process.umask(umask);
    }
    chmodSync(o.path, 0o600);
    this.server = { server, path: o.path };
  }

  /**
   * Accepts connect-in plugins over TCP, e.g. from servers on the user's tailnet. Same hello, token and
   * permission cap as the Unix socket; refuses hosts that are not loopback or Tailscale unless `allowAnyHost`.
   */
  async listenTcp(o: ListenTcpOptions): Promise<RemoteAddress> {
    if (this.tcpServer) throw new Error("already listening on TCP");
    if (!isAllowedTcpHost(o.host, o.allowAnyHost)) {
      throw new Error(`refusing to listen on ${o.host}: only loopback and Tailscale addresses (100.64.0.0/10, fd7a:115c:a1e0::/48) are allowed without tcp.allowAnyHost`);
    }
    const token = ensureConnectToken(o.tokenPath ?? join(this.opts.dataDir, "connect.token"));
    const allow = o.permissions ?? DEFAULT_CONNECT_PERMISSIONS;
    const helloTimeoutMs = o.helloTimeoutMs ?? 10_000;
    const server = createServer((sock) => {
      const remote = { address: plainAddress(sock.remoteAddress ?? "unknown"), port: sock.remotePort ?? 0 };
      if (this.isBanned(remote.address)) return void sock.destroy();
      this.accept(sock, { token, allow, where: "", remote }, helloTimeoutMs);
    });
    await new Promise<void>((res, rej) => {
      server.once("error", rej);
      server.listen(o.port, o.host, () => {
        server.off("error", rej);
        res();
      });
    });
    this.tcpServer = server;
    const bound = server.address() as AddressInfo;
    return { address: bound.address, port: bound.port };
  }

  private isBanned(address: string) {
    const f = this.helloFailures.get(address);
    return !!f && f.bannedUntil > Date.now();
  }

  private recordHelloFailure(remote: RemoteAddress) {
    const now = Date.now();
    const f = this.helloFailures.get(remote.address) ?? { times: [], bannedUntil: 0 };
    f.times = f.times.filter((t) => now - t < FAILURE_WINDOW_MS);
    f.times.push(now);
    if (f.times.length >= MAX_HELLO_FAILURES) {
      f.times = [];
      f.bannedUntil = now + BAN_MS;
      this.journal(KERNEL, "lifecycle", null, null, { connect: "rate-limited", remote, forSec: BAN_MS / 1000 });
    }
    this.helloFailures.set(remote.address, f);
    // Forget quiet addresses so scanners cannot grow the map without bound.
    for (const [addr, x] of this.helloFailures) {
      if (x.bannedUntil <= now && x.times.every((t) => now - t >= FAILURE_WINDOW_MS)) this.helloFailures.delete(addr);
    }
  }

  private accept(sock: Socket, ctx: HelloContext, helloTimeoutMs: number) {
    if (this.stopped) return void sock.destroy();
    this.sockets.set(sock, new Promise((r) => sock.once("close", () => (this.sockets.delete(sock), r()))));
    const where = ctx.remote ? `tcp://${ctx.remote.address}:${ctx.remote.port}` : ctx.where;
    let helloDone = false;
    if (ctx.remote) {
      let bytes = 0;
      const guard = (chunk: string | Buffer) => {
        bytes += chunk.length;
        if (!helloDone && bytes > MAX_HELLO_BYTES) sock.destroy();
        if (helloDone || bytes > MAX_HELLO_BYTES) sock.off("data", guard);
      };
      sock.on("data", guard);
    }
    const raw = socketLineTransport(sock);
    const { first, rest } = takeFirstLine(raw);
    const timer = setTimeout(() => {
      if (ctx.remote) this.recordHelloFailure(ctx.remote);
      raw.close();
    }, helloTimeoutMs);
    first.then(
      (line) => {
        helloDone = true;
        clearTimeout(timer);
        this.hello(line, raw, rest, { ...ctx, where });
      },
      () => clearTimeout(timer),
    );
  }

  /** Validates the first frame of a connect-in socket and, if it is a good `hello`, attaches the plugin. */
  private hello(line: string, raw: LineTransport, rest: LineTransport, { token, allow, where, remote }: HelloContext) {
    let frame: any;
    let rid: unknown = null;
    let pluginId: string | null = null;
    const via = remote ? { remote } : {};
    const reject = (code: number, message: string) => {
      raw.send(JSON.stringify({ jsonrpc: "2.0", id: rid, error: { code, message } }));
      this.journal(KERNEL, "lifecycle", null, null, { connect: "rejected", pluginId, reason: message, ...via });
      if (remote) this.recordHelloFailure(remote);
      raw.close();
    };
    try {
      frame = JSON.parse(line);
    } catch {
      return reject(-32700, "parse error");
    }
    rid = typeof frame?.id === "number" || typeof frame?.id === "string" ? frame.id : null;
    if (frame?.jsonrpc !== "2.0" || frame.method !== "hello" || rid === null) return reject(-32600, "first frame must be a hello request");
    if (this.stopped) return reject(ErrorCode.TargetUnavailable, "kernel is stopping");
    const params = frame.params ?? {};
    if (typeof params.token !== "string" || !sameSecret(params.token, token)) return reject(ErrorCode.PermissionDenied, "bad connect token");
    let manifest: LoadedManifest;
    try {
      manifest = validateManifest(params.manifest, where);
    } catch (err) {
      return reject(-32602, (err as Error).message);
    }
    pluginId = manifest.id;
    if (PROTOCOL_VERSION < manifest.protocol.min || PROTOCOL_VERSION > manifest.protocol.max) {
      return reject(ErrorCode.ProtocolMismatch, `kernel speaks protocol ${PROTOCOL_VERSION}`);
    }
    const existing = this.hosts.get(manifest.id);
    if (existing) {
      if (existing.mode !== "connected") return reject(-32600, `${manifest.id} is registered by the kernel`);
      if (existing.state !== "stopped") return reject(-32600, `${manifest.id} is already ${existing.state}`);
      this.hosts.delete(manifest.id); // reconnect under the same id
    }
    const declared = manifest.permissions;
    const granted = declared.filter((p) => hasPermission(allow, p));
    manifest = { ...manifest, permissions: granted };
    this.journal(KERNEL, "lifecycle", null, null, { pluginId, connect: "accepted", declared, granted, ...via });
    raw.send(JSON.stringify({ jsonrpc: "2.0", id: rid, result: { protocolVersion: PROTOCOL_VERSION, grantedPermissions: granted } }));
    void this.attach(manifest, rest, "connected", remote);
  }

  private register(manifest: LoadedManifest, mode: HostMode, remote: RemoteAddress | null = null): Host | null {
    if (this.hosts.has(manifest.id)) throw new Error(`plugin already registered: ${manifest.id}`);
    let resolveReady!: () => void;
    const ready = new Promise<void>((r) => (resolveReady = r));
    const host: Host = {
      manifest,
      state: "starting",
      peer: null,
      proc: null,
      restartTimes: [],
      restarts: 0,
      subscriptions: [...(manifest.subscribes ?? [])],
      ready,
      markReady: () => {
        host.readySettled = true;
        resolveReady();
      },
      readySettled: false,
      stopping: false,
      mode,
      remote,
    };
    this.hosts.set(manifest.id, host);
    if (PROTOCOL_VERSION < manifest.protocol.min || PROTOCOL_VERSION > manifest.protocol.max) {
      this.journal(KERNEL, "lifecycle", null, null, { pluginId: manifest.id, error: "protocol mismatch", supported: manifest.protocol });
      this.setState(host, "stopped");
      host.markReady();
      return null;
    }
    for (const kind of manifest.provides?.kinds ?? []) {
      const full = `${manifest.id}.${kind}`;
      if (!this.store.kind(full)) this.store.registerKind(full, manifest.id, { type: "object" });
    }
    this.setState(host, "starting");
    return host;
  }

  private startProcess(host: Host) {
    const m = host.manifest;
    const logPath = join(this.opts.dataDir, "logs", `${m.id}.log`);
    let proc: Subprocess<"pipe", "pipe", "pipe">;
    try {
      proc = Bun.spawn(m.run.command, {
        cwd: resolve(m.dir, m.run.cwd ?? "."),
        env: {
          // Children get the allowlist only: base names plus the global
          // env.pass and this plugin's run.envPass. run.env values are set
          // explicitly and always win.
          ...childEnv([...(this.opts.envPass ?? []), ...(m.run.envPass ?? [])], m.run.env ?? {}),
          ME_PLUGIN_ID: m.id,
          ME_DATA_DIR: join(this.opts.dataDir, "plugins", m.id),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      this.log(`spawn failed for ${m.id}: ${err}`);
      this.onExit(host, null);
      return;
    }
    host.proc = proc;
    void pumpLines(proc.stderr, (line) => appendFileSync(logPath, line + "\n"));
    const closeCbs: (() => void)[] = [];
    const lineCbs: ((l: string) => void)[] = [];
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
    void pumpLines(proc.stdout, (line) => lineCbs.forEach((cb) => cb(line)));
    void proc.exited.then((code) => {
      closeCbs.forEach((cb) => cb());
      this.onExit(host, code);
    });
    this.connect(host, transport);
  }

  private connect(host: Host, transport: LineTransport) {
    const id = host.manifest.id;
    const peer = new Peer(transport, {
      onRequest: (method, params) => this.handleRequest(host, method, params),
      onNotification: (method, params) => this.handleNotification(host, method, params),
      onClose: () => {
        if (host.mode !== "spawned") this.onExit(host, null);
      },
    });
    host.peer = peer;
    peer
      .request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          pluginId: id,
          grantedPermissions: host.manifest.permissions,
          config: this.opts.pluginConfig?.[id] ?? {},
        },
        this.opts.initializeTimeoutMs ?? 10_000,
      )
      .then(() => {
        this.setState(host, "running");
        host.markReady();
      })
      .catch((err) => {
        this.log(`initialize failed for ${id}: ${err.message}`);
        if (host.proc) host.proc.kill();
        else peer.close();
      });
  }

  private onExit(host: Host, code: number | null) {
    const id = host.manifest.id;
    if (host.state === "stopped" || host.state === "quarantined") return;
    host.peer = null;
    host.proc = null;
    this.failOpsOf(id);
    if (host.stopping || this.stopped || host.mode !== "spawned") {
      this.setState(host, "stopped", { exitCode: code });
      host.markReady();
      return;
    }
    const policy = host.manifest.restart ?? { policy: "on-failure", maxRestarts: 5, windowSec: 300 };
    const shouldRestart = policy.policy === "always" || (policy.policy === "on-failure" && code !== 0);
    if (!shouldRestart) {
      this.setState(host, "stopped", { exitCode: code });
      host.markReady();
      return;
    }
    const now = Date.now();
    host.restartTimes = host.restartTimes.filter((t) => now - t < policy.windowSec * 1000);
    if (host.restartTimes.length >= policy.maxRestarts) {
      this.setState(host, "quarantined", { exitCode: code });
      this.publish(KERNEL, "kernel.plugin.quarantined", { pluginId: id, restarts: host.restarts }, null, null);
      host.markReady();
      return;
    }
    host.restartTimes.push(now);
    host.restarts++;
    this.setState(host, "starting", { exitCode: code, restart: host.restarts });
    // Callers already waiting on an unsettled `ready` keep waiting for this restart.
    if (host.readySettled) {
      let resolveReady!: () => void;
      host.ready = new Promise<void>((r) => (resolveReady = r));
      host.readySettled = false;
      host.markReady = () => {
        host.readySettled = true;
        resolveReady();
      };
    }
    const delay = Math.min(250 * 2 ** (host.restartTimes.length - 1), 5_000);
    setTimeout(() => {
      if (!this.stopped) this.startProcess(host);
    }, delay);
  }

  private setState(host: Host, state: HostState, extra: Record<string, unknown> = {}) {
    const prev = host.state;
    host.state = state;
    const m = host.manifest;
    const entity: KernelPluginEntity = {
      id: m.id,
      version: m.version,
      state,
      mode: host.mode,
      pid: host.proc?.pid ?? null,
      restarts: host.restarts,
      permissions: m.permissions,
      ...(host.remote ? { remote: host.remote } : {}),
      activeOps: [...this.ops.values()].filter((o) => o.callee === m.id).length,
      lastError: host.lastError ?? null,
    };
    const { seq } = this.journal(KERNEL, "lifecycle", null, null, { pluginId: m.id, from: prev, to: state, ...extra });
    this.store.upsert("kernel.plugin", m.id, entity, seq);
    this.deliver("kernel.entity.changed", { kind: "kernel.plugin", id: m.id, updatedSeq: seq }, this.ctx(KERNEL, seq, null, null));
    if (state === "running" && prev !== "running") {
      this.publish(KERNEL, "kernel.plugin.started", { pluginId: m.id, pid: host.proc?.pid ?? 0 }, null, seq);
    }
    if (state === "stopped") {
      this.publish(KERNEL, "kernel.plugin.stopped", { pluginId: m.id, exitCode: (extra.exitCode as number) ?? null, signal: null }, null, seq);
    }
  }

  // -------------------------------------------------------------------------
  // Journal and event delivery
  // -------------------------------------------------------------------------

  private journal(source: string, type: JournalType, traceId: string | null, causationId: number | null, body: unknown) {
    return this.store.append({ source, type, traceId, causationId, body });
  }

  private ctx(source: string, seq: number, traceId: string | null, causationId: number | null): FrameContext {
    return { seq, traceId: traceId ?? "", causationId, source, ts: new Date().toISOString() };
  }

  /** Journals then delivers an event. Nothing is delivered that is not journaled. */
  private publish(source: string, name: string, data: unknown, traceId: string | null, causationId: number | null) {
    const { seq } = this.journal(source, "event", traceId, causationId, { name, data });
    this.deliver(name, data, this.ctx(source, seq, traceId, causationId));
    return seq;
  }

  private deliver(name: string, data: unknown, ctx: FrameContext) {
    for (const h of this.hosts.values()) {
      if (h.state !== "running" || !h.peer || h.manifest.id === ctx.source) continue;
      if (!hasPermission(h.manifest.permissions, "subscribe")) continue;
      if (!h.subscriptions.some((p) => matchPattern(p, name))) continue;
      h.peer.notify("event", { name, data, ctx });
    }
  }

  private deny(host: Host, permission: Permission, method: string, traceId: string | null = null): never {
    const id = host.manifest.id;
    this.journal(KERNEL, "permission.denied", traceId, null, { pluginId: id, permission, method });
    this.publish(KERNEL, "kernel.permission.denied", { pluginId: id, permission, method }, traceId, null);
    throw new RpcError(ErrorCode.PermissionDenied, `${id} lacks permission ${permission} for ${method}`);
  }

  private require(host: Host, permission: Permission, method: string, traceId: string | null = null) {
    if (!hasPermission(host.manifest.permissions, permission)) this.deny(host, permission, method, traceId);
  }

  // -------------------------------------------------------------------------
  // Plugin → kernel requests
  // -------------------------------------------------------------------------

  private async handleRequest(host: Host, method: string, params: any): Promise<unknown> {
    const id = host.manifest.id;
    switch (method) {
      case "invoke":
        // `await` keeps bun test from reporting a denied invoke as an unhandled rejection when the frame came off a socket.
        return await this.invoke(host, params as InvokeParams);

      case "op.subscribe": {
        this.require(host, "subscribe", method);
        const op = this.ops.get(params.opId);
        if (!op) throw new RpcError(ErrorCode.TargetUnavailable, `unknown op: ${params.opId}`);
        op.subscribers.add(id);
        return {};
      }

      case "op.cancel": {
        const op = this.ops.get(params.opId);
        if (!op) return {};
        if (op.caller !== id) throw new RpcError(ErrorCode.PermissionDenied, "only the caller may cancel an op");
        this.journal(id, "lifecycle", op.traceId, op.causationId, { cancel: op.id });
        const approval = [...this.approvals.values()].find((a) => a.opId === op.id);
        if (approval) this.resolveApproval(approval, { decision: "reject", note: "cancelled" }, id);
        else this.hosts.get(op.callee)?.peer?.notify("op.cancel", { opId: op.id });
        return {};
      }

      case "emit": {
        this.require(host, "emit", method, params.traceId ?? null);
        if (typeof params.name !== "string" || !params.name.startsWith(`${id}.`)) {
          throw new RpcError(ErrorCode.PermissionDenied, `${id} may only emit events named ${id}.*`);
        }
        const seq = this.publish(id, params.name, params.data, params.traceId ?? null, params.causationId ?? null);
        return { seq };
      }

      case "subscribe": {
        this.require(host, "subscribe", method);
        if (typeof params.pattern !== "string") throw new RpcError(-32602, "pattern is required");
        if (!host.subscriptions.includes(params.pattern)) host.subscriptions.push(params.pattern);
        return {};
      }

      case "entity.registerKind": {
        const kind: string = params.kind;
        const short = kind.startsWith(`${id}.`) ? kind.slice(id.length + 1) : null;
        if (!short || !(host.manifest.provides?.kinds ?? []).includes(short)) {
          throw new RpcError(ErrorCode.PermissionDenied, `${id} does not provide kind ${kind}`);
        }
        this.store.registerKind(kind, id, params.schema ?? { type: "object" });
        this.journal(id, "lifecycle", null, null, { registerKind: kind });
        return {};
      }

      case "entity.upsert":
        return this.upsertEntity(host, params);

      case "entity.get":
        this.require(host, "read-state", method);
        return this.store.get(params.kind, params.id);

      case "entity.list": {
        this.require(host, "read-state", method);
        const p = params as EntityListParams;
        return this.store.list(p.kind, p.where, p.limit, p.after);
      }

      case "approval.request":
        return this.requestApproval(host, params as ApprovalRequestParams & { traceId?: string; causationId?: number });

      case "approval.decide": {
        this.require(host, "approve.decide", method);
        const approval = this.approvals.get(params.approvalId);
        if (!approval) throw new RpcError(ErrorCode.TargetUnavailable, `unknown approval: ${params.approvalId}`);
        if (approval.requester === id) throw new RpcError(ErrorCode.PermissionDenied, "a plugin cannot decide its own approval");
        if (params.decision !== "approve" && params.decision !== "reject") throw new RpcError(-32602, "decision must be approve or reject");
        if (params.amend !== undefined && (typeof params.amend !== "object" || params.amend === null || Array.isArray(params.amend))) {
          throw new RpcError(-32602, "amend must be an object");
        }
        this.resolveApproval(approval, { decision: params.decision, note: params.note, ...(params.amend ? { amend: params.amend } : {}) }, id);
        return {};
      }

      case "approval.list":
        this.require(host, "approve.decide", method);
        return this.pendingApprovals();

      case "journal.query":
        this.require(host, "journal.read", method);
        return this.store.query(params as JournalQueryParams);

      case "trace.get":
        this.require(host, "journal.read", method);
        if (typeof params?.traceId !== "string" || !params.traceId) throw new RpcError(-32602, "traceId is required");
        return this.trace(params.traceId);

      default:
        throw new RpcError(-32601, `unknown kernel method: ${method}`);
    }
  }

  private async invoke(host: Host, p: InvokeParams): Promise<unknown> {
    const caller = host.manifest.id;
    const traceId = p.traceId || crypto.randomUUID();
    this.require(host, `call:${p.target}` as Permission, `invoke ${p.target}.${p.method}`, traceId);
    const target = this.hosts.get(p.target);
    if (!target) throw new RpcError(ErrorCode.TargetUnavailable, `no such plugin: ${p.target}`);
    if (!(target.manifest.provides?.methods ?? []).includes(p.method)) {
      throw new RpcError(ErrorCode.TargetUnavailable, `${p.target} does not provide ${p.method}`);
    }
    const timeoutMs = p.timeoutMs ?? 30_000;
    if (target.state === "starting") {
      await Promise.race([target.ready, Bun.sleep(Math.min(timeoutMs, 15_000))]);
    }
    if (target.state !== "running" || !target.peer) {
      throw new RpcError(ErrorCode.TargetUnavailable, `${p.target} is ${target.state}`);
    }
    const { seq } = this.journal(caller, "call", traceId, p.causationId ?? null, {
      target: p.target,
      method: p.method,
      params: p.params as JsonValue,
      stream: !!p.stream,
    });
    const ctx = { ...this.ctx(caller, seq, traceId, p.causationId ?? null), caller };

    if (p.stream) {
      const opId = crypto.randomUUID();
      const op: Op = this.newOp(opId, caller, p.target, p.method, traceId, seq, "running");
      this.ops.set(opId, op);
      this.saveOp(op, seq);
      target.peer
        .request("call", { method: p.method, params: p.params, stream: true, opId, ctx }, timeoutMs)
        .catch((err: RpcError) => {
          if (this.ops.has(opId)) this.endOp(opId, { opId, error: { code: err.code ?? -32603, message: err.message } }, p.target);
        });
      return { opId };
    }

    try {
      const result = await target.peer.request("call", { method: p.method, params: p.params, stream: false, ctx }, timeoutMs);
      this.journal(p.target, "result", traceId, seq, { method: p.method, result });
      return { result };
    } catch (err: any) {
      this.journal(p.target, "error", traceId, seq, { method: p.method, code: err.code ?? -32603, message: err.message });
      this.noteError(p.target, p.method, String(err?.message ?? err));
      throw err instanceof RpcError ? err : new RpcError(-32603, String(err?.message ?? err));
    }
  }

  private upsertEntity(host: Host, params: { kind: string; id: string; data: JsonValue; traceId?: string; causationId?: number }) {
    const id = host.manifest.id;
    const kind = this.store.kind(params.kind);
    if (!kind) throw new RpcError(ErrorCode.TargetUnavailable, `unknown kind: ${params.kind}`);
    if (kind.owner !== id) {
      const owner = this.hosts.get(kind.owner)?.manifest;
      const short = params.kind.slice(kind.owner.length + 1);
      const allowed =
        hasPermission(host.manifest.permissions, `write-state:${params.kind}` as Permission) &&
        (owner?.allowWriters?.[short] ?? []).includes(id);
      if (!allowed) this.deny(host, `write-state:${params.kind}` as Permission, "entity.upsert");
    }
    const problem = validateAgainstSchema(kind.schema, params.data);
    if (problem) throw new RpcError(ErrorCode.SchemaViolation, `${params.kind}: ${problem}`);
    // An upsert that changes nothing is neither journaled nor announced.
    const prev = this.store.getRaw(params.kind, params.id);
    if (prev && prev.data === JSON.stringify(params.data)) return { updatedSeq: prev.updatedSeq };
    const { seq } = this.journal(id, "event", params.traceId ?? null, params.causationId ?? null, {
      name: "kernel.entity.changed",
      data: { kind: params.kind, id: params.id, entity: params.data },
    });
    this.store.upsert(params.kind, params.id, params.data, seq);
    this.deliver(
      "kernel.entity.changed",
      { kind: params.kind, id: params.id, updatedSeq: seq },
      this.ctx(id, seq, params.traceId ?? null, params.causationId ?? null),
    );
    return { updatedSeq: seq };
  }

  // -------------------------------------------------------------------------
  // Ops (streaming) and approvals
  // -------------------------------------------------------------------------

  private handleNotification(host: Host, method: string, params: any) {
    const id = host.manifest.id;
    if (method === "op.update") {
      const p = params as OpUpdateParams;
      const op = this.ops.get(p.opId);
      if (!op || op.callee !== id) return;
      if (isDelta(p.update)) {
        // Delivered live as is; journaled later, merged with its neighbours (seq is the op's latest entry).
        this.bufferDelta(op, p.update);
        for (const sub of op.subscribers) this.hosts.get(sub)?.peer?.notify("op.update", { opId: op.id, update: p.update, seq: op.lastSeq });
        return;
      }
      this.flushDeltas(op);
      const { seq } = this.journal(id, "op.update", op.traceId, op.causationId, { opId: op.id, update: p.update });
      op.lastSeq = seq;
      for (const sub of op.subscribers) this.hosts.get(sub)?.peer?.notify("op.update", { opId: op.id, update: p.update, seq });
      const u = p.update as any;
      if (u && u.kind === "phase" && typeof u.phase === "string") {
        op.phase = u.phase;
        op.phaseLabel = typeof u.label === "string" ? u.label : null;
        op.progress = typeof u.progress === "number" ? Math.min(1, Math.max(0, u.progress)) : null;
        this.saveOp(op, seq);
      }
      return;
    }
    if (method === "op.end") {
      const p = params as OpEndParams;
      const op = this.ops.get(p.opId);
      if (!op || op.callee !== id) return;
      this.endOp(op.id, p, id);
      return;
    }
    this.log(`ignored notification ${method} from ${id}`);
  }

  private bufferDelta(op: Op, u: { kind: string; delta: string }) {
    const last = op.pending.at(-1);
    if (last && last.kind === u.kind) {
      last.delta += u.delta;
      last.count++;
    } else op.pending.push({ kind: u.kind, delta: u.delta, count: 1 });
    op.pendingBytes += u.delta.length;
    // While stopping, no timer: it could fire after the store has closed.
    if (op.pendingBytes >= DELTA_MAX_BYTES || this.stopped) this.flushDeltas(op);
    else if (!op.flushTimer) {
      op.flushTimer = setTimeout(() => this.flushDeltas(op), this.journalOpts.deltaFlushMs);
      op.flushTimer.unref?.();
    }
  }

  /** Journals buffered deltas, one entry per run of one kind, in arrival order. */
  private flushDeltas(op: Op) {
    if (op.flushTimer) clearTimeout(op.flushTimer);
    op.flushTimer = null;
    if (op.pending.length === 0) return;
    for (const d of op.pending) {
      op.lastSeq = this.journal(op.callee, "op.update", op.traceId, op.causationId, {
        opId: op.id,
        update: { kind: d.kind, delta: d.delta },
        coalesced: d.count,
      }).seq;
    }
    op.pending = [];
    op.pendingBytes = 0;
  }

  private endOp(opId: string, p: OpEndParams, source: string) {
    const op = this.ops.get(opId);
    if (!op) return;
    this.flushDeltas(op);
    this.ops.delete(opId);
    const { seq } = this.journal(source, "op.end", op.traceId, op.causationId, { opId, result: p.result, error: p.error });
    op.state = p.error ? (p.error.code === ErrorCode.Cancelled ? "cancelled" : "failed") : "done";
    this.saveOp(op, seq, p.error?.message ?? null);
    if (p.error && op.callee !== KERNEL) this.noteError(op.callee, op.method, p.error.message);
    for (const sub of op.subscribers) {
      this.hosts.get(sub)?.peer?.notify("op.end", { opId, ...(p.error ? { error: p.error } : { result: p.result }), seq });
    }
  }

  private failOpsOf(pluginId: string) {
    for (const op of [...this.ops.values()]) {
      if (op.callee === pluginId) {
        this.endOp(op.id, { opId: op.id, error: { code: ErrorCode.TargetUnavailable, message: `${pluginId} exited` } }, KERNEL);
      } else op.subscribers.delete(pluginId);
    }
  }

  private requestApproval(host: Host, params: ApprovalRequestParams & { traceId?: string; causationId?: number }) {
    const id = host.manifest.id;
    const traceId = params.traceId || crypto.randomUUID();
    this.require(host, "approve.request", "approval.request", traceId);
    if (!["low", "medium", "high"].includes(params.risk)) throw new RpcError(-32602, "risk must be low, medium or high");
    const approvalId = crypto.randomUUID();
    const opId = crypto.randomUUID();
    const { seq } = this.journal(id, "approval", traceId, params.causationId ?? null, { approvalId, state: "pending", ...params });
    const op = this.newOp(opId, id, KERNEL, "approval", traceId, seq, "waiting");
    op.phaseLabel = params.summary;
    this.ops.set(opId, op);
    this.saveOp(op, seq);
    const approval: Approval = { id: approvalId, opId, requester: id, params, timer: null };
    if (params.expiresInSec && params.expiresInSec > 0) {
      approval.timer = setTimeout(() => this.resolveApproval(approval, { decision: "reject", note: "expired" }, KERNEL), params.expiresInSec * 1000);
    }
    this.approvals.set(approvalId, approval);
    this.publish(
      KERNEL,
      "kernel.approval.pending",
      { approvalId, requester: id, summary: params.summary, risk: params.risk, payload: params.payload ?? null, expiresInSec: params.expiresInSec ?? null },
      traceId,
      seq,
    );
    return { opId, approvalId };
  }

  private resolveApproval(approval: Approval, decision: ApprovalDecision, decidedBy: string) {
    if (!this.approvals.has(approval.id)) return;
    this.approvals.delete(approval.id);
    if (approval.timer) clearTimeout(approval.timer);
    const op = this.ops.get(approval.opId);
    const traceId = op?.traceId ?? null;
    const { seq } = this.journal(decidedBy, "approval", traceId, op?.causationId ?? null, {
      approvalId: approval.id,
      state: "decided",
      ...decision,
    });
    this.publish(KERNEL, "kernel.approval.decided", { approvalId: approval.id, decidedBy, ...decision }, traceId, seq);
    if (op) this.endOp(op.id, { opId: op.id, result: decision as unknown as JsonValue }, KERNEL);
  }

  // -------------------------------------------------------------------------
  // Op state, plugin health, traces
  // -------------------------------------------------------------------------

  private newOp(id: string, caller: string, callee: string, method: string, traceId: string, causationId: number, state: Op["state"]): Op {
    return { id, caller, callee, subscribers: new Set([caller]), traceId, causationId, method, startedAt: new Date().toISOString(), state, phase: null, phaseLabel: null, progress: null, pending: [], pendingBytes: 0, flushTimer: null, lastSeq: causationId };
  }

  /** Mirrors an op into the kernel.op entity and refreshes its plugin's activeOps. */
  private saveOp(op: Op, seq: number, error: string | null = null) {
    const now = new Date().toISOString();
    const ended = op.state === "done" || op.state === "failed" || op.state === "cancelled";
    const entity: KernelOpEntity = {
      opId: op.id,
      traceId: op.traceId,
      caller: op.caller,
      callee: op.callee,
      method: op.method,
      state: op.state,
      phase: op.phase,
      phaseLabel: op.phaseLabel,
      progress: op.progress,
      startedAt: op.startedAt,
      updatedAt: now,
      endedAt: ended ? now : null,
      durationMs: ended ? Date.parse(now) - Date.parse(op.startedAt) : null,
      error,
    };
    this.store.upsert("kernel.op", op.id, entity, seq);
    this.deliver("kernel.entity.changed", { kind: "kernel.op", id: op.id, updatedSeq: seq }, this.ctx(KERNEL, seq, op.traceId, op.causationId));
    if (ended) this.store.prune("kernel.op", OP_HISTORY);
    const host = this.hosts.get(op.callee);
    if (host && (op.state === "running" || ended)) this.refreshPlugin(host, seq);
  }

  private noteError(pluginId: string, method: string, message: string) {
    const host = this.hosts.get(pluginId);
    if (!host) return;
    host.lastError = { at: new Date().toISOString(), method, message: message.slice(0, 300) };
    this.refreshPlugin(host, this.journal(KERNEL, "lifecycle", null, null, { pluginId, lastError: host.lastError }).seq);
  }

  /** Re-publishes a plugin's entity without a state change (health fields only). */
  private refreshPlugin(host: Host, seq: number) {
    const m = host.manifest;
    const prev = this.store.get("kernel.plugin", m.id)?.data as KernelPluginEntity | undefined;
    if (!prev) return;
    const entity: KernelPluginEntity = {
      ...prev,
      activeOps: [...this.ops.values()].filter((o) => o.callee === m.id).length,
      lastError: host.lastError ?? null,
    };
    if (JSON.stringify(entity) === JSON.stringify(prev)) return;
    this.store.upsert("kernel.plugin", m.id, entity, seq);
    this.deliver("kernel.entity.changed", { kind: "kernel.plugin", id: m.id, updatedSeq: seq }, this.ctx(KERNEL, seq, null, null));
  }

  /** Builds the call tree of one request from the journal: calls, streaming ops, phases, approvals. */
  trace(traceId: string): TraceResult {
    const entries = this.store.query({ traceId, limit: 1000 });
    const nodes = new Map<number, TraceNode & { parent: number | null }>();
    const opNode = new Map<string, TraceNode>();
    const approvalNode = new Map<string, TraceNode>();
    for (const e of entries) {
      const b: any = e.body;
      if (e.type === "call") {
        nodes.set(e.seq, {
          seq: e.seq,
          type: "call",
          caller: e.source,
          target: b.target,
          method: b.method,
          stream: !!b.stream,
          status: "running",
          startedAt: e.ts,
          endedAt: null,
          durationMs: null,
          phases: [],
          error: null,
          children: [],
          parent: e.causationId,
        });
      } else if ((e.type === "result" || e.type === "error") && e.causationId !== null && nodes.has(e.causationId)) {
        const n = nodes.get(e.causationId)!;
        n.status = e.type === "result" ? "ok" : "error";
        n.endedAt = e.ts;
        n.durationMs = Date.parse(e.ts) - Date.parse(n.startedAt);
        if (e.type === "error") n.error = String(b.message ?? "");
      } else if (e.type === "op.update" && b?.update?.kind === "phase") {
        const n = (e.causationId !== null ? nodes.get(e.causationId) : undefined) ?? approvalNode.get(b.opId);
        if (n) n.phases.push({ phase: String(b.update.phase), label: b.update.label ?? null, at: e.ts });
        if (n) opNode.set(b.opId, n);
      } else if (e.type === "op.end") {
        const n = opNode.get(b.opId) ?? (e.causationId !== null ? nodes.get(e.causationId) : undefined);
        if (n) {
          n.status = b.error ? (b.error.code === ErrorCode.Cancelled ? "cancelled" : "error") : n.type === "approval" ? "ok" : "ok";
          n.endedAt = e.ts;
          n.durationMs = Date.parse(e.ts) - Date.parse(n.startedAt);
          if (b.error) n.error = String(b.error.message ?? "");
        }
      } else if (e.type === "approval" && b.state === "pending") {
        const n: TraceNode & { parent: number | null } = {
          seq: e.seq,
          type: "approval",
          caller: e.source,
          target: KERNEL,
          method: "approval",
          stream: true,
          status: "waiting",
          startedAt: e.ts,
          endedAt: null,
          durationMs: null,
          phases: [{ phase: "waiting", label: b.summary ?? null, at: e.ts }],
          error: null,
          children: [],
          parent: e.causationId,
        };
        nodes.set(e.seq, n);
        approvalNode.set(b.approvalId, n);
      } else if (e.type === "approval" && b.state === "decided") {
        const n = approvalNode.get(b.approvalId);
        if (n) {
          n.status = b.decision === "approve" ? "ok" : "cancelled";
          n.endedAt = e.ts;
          n.durationMs = Date.parse(e.ts) - Date.parse(n.startedAt);
          n.phases.push({ phase: b.decision, label: b.note ?? null, at: e.ts });
        }
      }
    }
    // Stream calls end through op.end, whose causationId is the call's seq.
    for (const e of entries) {
      if (e.type !== "op.end") continue;
      const n = e.causationId !== null ? nodes.get(e.causationId) : undefined;
      if (n && n.type === "call" && n.endedAt === null) {
        const b: any = e.body;
        n.status = b.error ? (b.error.code === ErrorCode.Cancelled ? "cancelled" : "error") : "ok";
        n.endedAt = e.ts;
        n.durationMs = Date.parse(e.ts) - Date.parse(n.startedAt);
      }
    }
    const roots: TraceNode[] = [];
    for (const n of nodes.values()) {
      const parent = n.parent !== null ? nodes.get(n.parent) : undefined;
      if (parent && parent !== n) parent.children.push(n);
      else roots.push(n);
    }
    const strip = (n: TraceNode & { parent?: number | null }): TraceNode => {
      const { parent: _p, ...rest } = n;
      return { ...rest, children: n.children.map(strip) };
    };
    const ts = entries.map((e) => e.ts);
    return { traceId, startedAt: ts[0] ?? null, endedAt: ts.at(-1) ?? null, nodes: roots.map(strip) };
  }

  /** Pending approvals, for UIs that connect after the pending event was published. */
  pendingApprovals() {
    return [...this.approvals.values()].map((a) => ({ approvalId: a.id, requester: a.requester, ...a.params }));
  }
}
