// Plugin SDK: wraps the kernel protocol so a plugin only declares methods and handlers.
// Trace context (traceId, causationId) propagates automatically through AsyncLocalStorage.
import { AsyncLocalStorage } from "node:async_hooks";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Peer,
  RpcError,
  pumpLines,
  socketLineTransport,
  takeFirstLine,
  type ApprovalDecision,
  type ApprovalRequestParams,
  type CallParams,
  type EntityDoc,
  type EntityListParams,
  type EventParams,
  type FrameContext,
  type InitializeParams,
  type JournalEntry,
  type JournalQueryParams,
  type HelloResult,
  type JsonValue,
  type LineTransport,
  type Manifest,
} from "@me/protocol";

export { RpcError } from "@me/protocol";

export interface CallContext {
  traceId: string;
  seq: number;
  causationId: number | null;
  caller: string;
  /** Present for streaming calls. */
  opId?: string;
  /** Sends an op.update for streaming calls; no-op otherwise. */
  update(update: unknown): void;
  /** Aborted when the caller cancels a streaming call. */
  signal: AbortSignal;
}

export type MethodHandler = (params: any, ctx: CallContext) => unknown | Promise<unknown>;

export interface PluginDefinition {
  methods?: Record<string, MethodHandler>;
  onEvent?: (name: string, data: any, ctx: FrameContext) => void | Promise<void>;
  onInit?: (info: InitializeParams, plugin: Plugin) => void | Promise<void>;
  onShutdown?: () => void | Promise<void>;
}

export interface InvokeOptions {
  stream?: boolean;
  onUpdate?: (update: any) => void;
  timeoutMs?: number;
  /** Start a fresh trace instead of continuing the current one. */
  newTrace?: boolean;
}

interface OpWaiter {
  onUpdate?: (u: any) => void;
  resolve(v: unknown): void;
  reject(e: unknown): void;
}

export class Plugin {
  private peer!: Peer;
  private als = new AsyncLocalStorage<{ traceId: string; seq: number }>();
  private waiters = new Map<string, OpWaiter>();
  private early = new Map<string, { updates: unknown[]; end?: any }>();
  private aborts = new Map<string, AbortController>();
  info!: InitializeParams;

  constructor(private def: PluginDefinition) {}

  get id() {
    return this.info.pluginId;
  }

  get config(): Record<string, JsonValue> {
    return this.info.config;
  }

  /** Connects in over the kernel's Unix socket or TCP (exec mode B); see `connect`. */
  connect(opts: Omit<ConnectOptions, "plugin">) {
    return connect({ ...opts, plugin: this });
  }

  /** Connects over stdio (default) or a given transport. Resolves once the transport closes. */
  run(transport: LineTransport = stdioTransport()): Promise<void> {
    return new Promise((done) => {
      this.peer = new Peer(transport, {
        onRequest: (method, params) => this.onRequest(method, params),
        onNotification: (method, params) => this.onNotification(method, params),
        onClose: () => done(),
      });
    });
  }

  private async onRequest(method: string, params: any): Promise<unknown> {
    if (method === "initialize") {
      this.info = params as InitializeParams;
      await this.def.onInit?.(this.info, this);
      return { protocolVersion: this.info.protocolVersion, ready: true };
    }
    if (method === "shutdown") {
      await this.def.onShutdown?.();
      setTimeout(() => this.peer.close(), 10);
      return {};
    }
    if (method === "call") return this.onCall(params as CallParams);
    throw new RpcError(-32601, `unknown method: ${method}`);
  }

  private async onCall(p: CallParams): Promise<unknown> {
    const handler = this.def.methods?.[p.method];
    if (!handler) throw new RpcError(-32601, `${this.id} has no method ${p.method}`);
    const abort = new AbortController();
    const ctx: CallContext = {
      traceId: p.ctx.traceId,
      seq: p.ctx.seq,
      causationId: p.ctx.causationId,
      caller: p.ctx.caller,
      opId: p.opId,
      signal: abort.signal,
      update: (u) => {
        if (p.stream && p.opId) this.peer.notify("op.update", { opId: p.opId, update: u });
      },
    };
    const run = () => this.als.run({ traceId: p.ctx.traceId, seq: p.ctx.seq }, () => handler(p.params, ctx));
    if (!p.stream || !p.opId) return run();
    const opId = p.opId;
    this.aborts.set(opId, abort);
    void (async () => {
      try {
        const result = await run();
        this.peer.notify("op.end", { opId, result: result ?? null });
      } catch (err: any) {
        this.peer.notify("op.end", { opId, error: { code: err?.code ?? -32603, message: String(err?.message ?? err) } });
      } finally {
        this.aborts.delete(opId);
      }
    })();
    return { accepted: true };
  }

  private onNotification(method: string, params: any) {
    if (method === "event") {
      const e = params as EventParams;
      void this.als.run({ traceId: e.ctx.traceId, seq: e.ctx.seq }, async () => {
        try {
          await this.def.onEvent?.(e.name, e.data, e.ctx);
        } catch (err) {
          console.error(`[${this.id}] onEvent ${e.name} failed:`, err);
        }
      });
      return;
    }
    if (method === "op.update") {
      const w = this.waiters.get(params.opId);
      if (w) w.onUpdate?.(params.update);
      else this.bufferEarly(params.opId).updates.push(params.update);
      return;
    }
    if (method === "op.end") {
      const w = this.waiters.get(params.opId);
      if (w) this.finish(params.opId, w, params);
      else this.bufferEarly(params.opId).end = params;
      return;
    }
    if (method === "op.cancel") {
      this.aborts.get(params.opId)?.abort();
    }
  }

  private bufferEarly(opId: string) {
    let b = this.early.get(opId);
    if (!b) {
      b = { updates: [] };
      this.early.set(opId, b);
      setTimeout(() => this.early.delete(opId), 30_000);
    }
    return b;
  }

  private finish(opId: string, w: OpWaiter, end: any) {
    this.waiters.delete(opId);
    if (end.error) w.reject(new RpcError(end.error.code, end.error.message, end.error.data));
    else w.resolve(end.result);
  }

  private waitOp(opId: string, onUpdate?: (u: any) => void): Promise<any> {
    return new Promise((resolve, reject) => {
      const w: OpWaiter = { onUpdate, resolve, reject };
      this.waiters.set(opId, w);
      const early = this.early.get(opId);
      if (early) {
        this.early.delete(opId);
        early.updates.forEach((u) => onUpdate?.(u));
        if (early.end) this.finish(opId, w, early.end);
      }
    });
  }

  private trace(newTrace = false) {
    const cur = newTrace ? undefined : this.als.getStore();
    return { traceId: cur?.traceId || undefined, causationId: cur?.seq };
  }

  /** Runs `fn` inside a fresh trace; use when handling user input that is not a kernel call. */
  withTrace<T>(traceId: string, fn: () => T): T {
    return this.als.run({ traceId, seq: 0 }, fn);
  }

  // ---- kernel client --------------------------------------------------------

  async invoke<R = any>(target: string, method: string, params: unknown, opts: InvokeOptions = {}): Promise<R> {
    const t = this.trace(opts.newTrace);
    const res = await this.peer.request(
      "invoke",
      { target, method, params, stream: !!opts.stream, timeoutMs: opts.timeoutMs, traceId: t.traceId, causationId: t.causationId },
      (opts.timeoutMs ?? 30_000) + 1_000,
    );
    if (!opts.stream) return res.result as R;
    return this.waitOp(res.opId, opts.onUpdate);
  }

  /** Starts a streaming invoke and returns its opId without waiting; updates go to onUpdate. */
  async invokeStream(target: string, method: string, params: unknown, opts: Omit<InvokeOptions, "stream"> = {}) {
    const t = this.trace(opts.newTrace);
    const res = await this.peer.request("invoke", {
      target,
      method,
      params,
      stream: true,
      timeoutMs: opts.timeoutMs,
      traceId: t.traceId,
      causationId: t.causationId,
    });
    const done = this.waitOp(res.opId, opts.onUpdate);
    return { opId: res.opId as string, done };
  }

  emit(name: string, data: unknown) {
    const t = this.trace();
    return this.peer.request("emit", { name: name.startsWith(`${this.id}.`) ? name : `${this.id}.${name}`, data, ...t });
  }

  subscribe(pattern: string) {
    return this.peer.request("subscribe", { pattern });
  }

  subscribeOp(opId: string, onUpdate?: (u: any) => void) {
    const done = this.waitOp(opId, onUpdate);
    return this.peer.request("op.subscribe", { opId }).then(() => done);
  }

  cancelOp(opId: string) {
    return this.peer.request("op.cancel", { opId });
  }

  readonly entity = {
    registerKind: (kind: string, schema: JsonValue) =>
      this.peer.request("entity.registerKind", { kind: kind.includes(".") ? kind : `${this.id}.${kind}`, schema }),
    upsert: (kind: string, id: string, data: unknown) =>
      this.peer.request<{ updatedSeq: number }>("entity.upsert", { kind, id, data, ...this.trace() }),
    get: <T = any>(kind: string, id: string) => this.peer.request<EntityDoc<T> | null>("entity.get", { kind, id }),
    list: <T = any>(p: EntityListParams) => this.peer.request<EntityDoc<T>[]>("entity.list", p),
  };

  readonly approval = {
    /** Resolves when the user decides. */
    request: async (p: ApprovalRequestParams): Promise<ApprovalDecision & { approvalId: string }> => {
      const res = await this.peer.request("approval.request", { ...p, ...this.trace() });
      const decision = await this.waitOp(res.opId);
      return { ...decision, approvalId: res.approvalId };
    },
    decide: (approvalId: string, decision: ApprovalDecision) => this.peer.request("approval.decide", { approvalId, ...decision }),
    list: () =>
      this.peer.request<({ approvalId: string; requester: string } & ApprovalRequestParams)[]>("approval.list", {}),
  };

  journal(q: JournalQueryParams) {
    return this.peer.request<JournalEntry[]>("journal.query", q);
  }
}

export function definePlugin(def: PluginDefinition) {
  return new Plugin(def);
}

/** stdio transport; stdout is reserved for protocol frames, so console.log goes to stderr. */
export function stdioTransport(): LineTransport {
  console.log = (...args: unknown[]) => console.error(...args);
  const lineCbs: ((l: string) => void)[] = [];
  const closeCbs: (() => void)[] = [];
  void pumpLines(Bun.stdin.stream(), (l) => lineCbs.forEach((cb) => cb(l))).then(() => closeCbs.forEach((cb) => cb()));
  return {
    send: (line) => void process.stdout.write(line + "\n"),
    onLine: (cb) => lineCbs.push(cb),
    onClose: (cb) => closeCbs.push(cb),
    close: () => process.exit(0),
  };
}

/** NDJSON over a Unix domain socket. */
export function socketTransport(path: string): LineTransport {
  return socketLineTransport(createConnection(path));
}

/** NDJSON over TCP (a kernel listening on a tailnet address). */
export function tcpTransport(host: string, port: number): LineTransport {
  const sock = createConnection({ host, port });
  sock.setNoDelay(true);
  return socketLineTransport(sock);
}

export interface DialOptions {
  /** Defaults to $ME_HOME/kernel.sock (ME_HOME defaults to ~/.me). Ignored when `tcp` is set. */
  socketPath?: string;
  /** Dial a kernel's TCP listener instead of the Unix socket. */
  tcp?: { host: string; port: number };
  /** The connect token itself; otherwise it is read from `tokenPath`. */
  token?: string;
  /** Defaults to $ME_HOME/connect.token. */
  tokenPath?: string;
  /** Sent in `hello`; the kernel validates it like a plugin.json and caps its permissions. */
  manifest: Manifest;
}

export interface ConnectOptions extends DialOptions {
  plugin: Plugin | PluginDefinition;
}

export interface Connection {
  /** What the kernel actually granted (declared ∩ its connectPermissions or remotePermissions). */
  grantedPermissions: HelloResult["grantedPermissions"];
  /** Resolves when the socket closes; the plugin may then connect again under the same id. */
  done: Promise<void>;
}

/**
 * Dials the kernel and performs `hello`. Returns the transport positioned after the handshake; the kernel
 * sends `initialize` on it next. Rejects with the kernel's RpcError if the hello is refused, or a plain Error
 * if the kernel closes without answering (e.g. a rate-limited address).
 */
export async function dial(opts: DialOptions): Promise<{ transport: LineTransport; grantedPermissions: HelloResult["grantedPermissions"] }> {
  const home = process.env.ME_HOME ?? join(homedir(), ".me");
  const token = opts.token ?? (await Bun.file(opts.tokenPath ?? join(home, "connect.token")).text()).trim();
  const socketPath = opts.socketPath ?? join(home, "kernel.sock");
  const where = opts.tcp ? `${opts.tcp.host}:${opts.tcp.port}` : socketPath;
  const raw = opts.tcp ? tcpTransport(opts.tcp.host, opts.tcp.port) : socketTransport(socketPath);
  const { first, rest } = takeFirstLine(raw);
  raw.send(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "hello", params: { manifest: opts.manifest, token } }));
  let reply: any;
  try {
    reply = JSON.parse(await first);
  } catch (err) {
    raw.close();
    throw new Error(`no hello reply from kernel at ${where}: ${(err as Error).message}`);
  }
  if (reply.error) {
    raw.close();
    throw new RpcError(reply.error.code, reply.error.message, reply.error.data);
  }
  return { transport: rest, grantedPermissions: (reply.result as HelloResult).grantedPermissions };
}

/**
 * Exec mode B: dials the kernel (Unix socket, or TCP with `tcp`), sends `hello` with the manifest and connect
 * token, then runs the plugin over the connection. Rejects with the kernel's RpcError if the hello is refused.
 */
export async function connect(opts: ConnectOptions): Promise<Connection> {
  const plugin = opts.plugin instanceof Plugin ? opts.plugin : definePlugin(opts.plugin);
  const { transport, grantedPermissions } = await dial(opts);
  return { grantedPermissions, done: plugin.run(transport) };
}
