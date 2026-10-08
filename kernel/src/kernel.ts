// The kernel: supervisor, router, permissions, journal, events, entities, ops, approvals.
// Spec: docs/PROTOCOL.md. The kernel knows no domain concepts — only plugins, frames and kinds.
import { mkdirSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import {
  ErrorCode,
  PROTOCOL_VERSION,
  Peer,
  RpcError,
  pumpLines,
  type ApprovalDecision,
  type ApprovalRequestParams,
  type EntityListParams,
  type FrameContext,
  type InvokeParams,
  type JournalQueryParams,
  type JsonValue,
  type KernelPluginEntity,
  type LineTransport,
  type OpEndParams,
  type OpUpdateParams,
  type Permission,
} from "@myself/protocol";
import { hasPermission, matchPattern, type LoadedManifest } from "./manifest.ts";
import { Store, type JournalType } from "./store.ts";
import { validateAgainstSchema } from "./schema.ts";

type HostState = KernelPluginEntity["state"];

interface Host {
  manifest: LoadedManifest;
  state: HostState;
  peer: Peer | null;
  proc: Subprocess<"pipe", "pipe", "pipe"> | null;
  restartTimes: number[];
  restarts: number;
  subscriptions: string[];
  ready: Promise<void>;
  markReady: () => void;
  stopping: boolean;
  /** In-memory plugins are attached by the host program and never respawned. */
  attached: boolean;
}

interface Op {
  id: string;
  caller: string;
  callee: string; // plugin id, or "kernel" for approvals
  subscribers: Set<string>;
  traceId: string;
  causationId: number;
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
}

const KERNEL = "kernel";

export class Kernel {
  readonly store: Store;
  private hosts = new Map<string, Host>();
  private ops = new Map<string, Op>();
  private approvals = new Map<string, Approval>();
  private log: (msg: string) => void;
  private stopped = false;

  constructor(private opts: KernelOptions) {
    mkdirSync(opts.dataDir, { recursive: true });
    mkdirSync(join(opts.dataDir, "logs"), { recursive: true });
    this.store = new Store(join(opts.dataDir, "myself.sqlite"));
    this.log = opts.log ?? ((m) => console.error(`[kernel] ${m}`));
    this.store.registerKind("kernel.plugin", KERNEL, { type: "object", required: ["id", "state"] });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Registers and spawns a plugin process (exec mode A). */
  async spawn(manifest: LoadedManifest): Promise<void> {
    const host = this.register(manifest, false);
    if (!host) return;
    this.startProcess(host);
    await host.ready.catch(() => {});
  }

  /** Attaches a plugin over an existing transport (tests, in-process plugins, later sockets). */
  async attach(manifest: LoadedManifest, transport: LineTransport): Promise<void> {
    const host = this.register(manifest, true);
    if (!host) return;
    this.connect(host, transport);
    await host.ready;
  }

  async stop(): Promise<void> {
    this.stopped = true;
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
    for (const a of this.approvals.values()) if (a.timer) clearTimeout(a.timer);
    this.store.close();
  }

  pluginState(id: string): HostState | null {
    return this.hosts.get(id)?.state ?? null;
  }

  private register(manifest: LoadedManifest, attached: boolean): Host | null {
    if (this.hosts.has(manifest.id)) throw new Error(`plugin already registered: ${manifest.id}`);
    let markReady!: () => void;
    const ready = new Promise<void>((r) => (markReady = r));
    const host: Host = {
      manifest,
      state: "starting",
      peer: null,
      proc: null,
      restartTimes: [],
      restarts: 0,
      subscriptions: [...(manifest.subscribes ?? [])],
      ready,
      markReady,
      stopping: false,
      attached,
    };
    this.hosts.set(manifest.id, host);
    if (PROTOCOL_VERSION < manifest.protocol.min || PROTOCOL_VERSION > manifest.protocol.max) {
      this.journal(KERNEL, "lifecycle", null, null, { pluginId: manifest.id, error: "protocol mismatch", supported: manifest.protocol });
      this.setState(host, "stopped");
      markReady();
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
        env: { ...process.env, ...(m.run.env ?? {}), MYSELF_PLUGIN_ID: m.id, MYSELF_DATA_DIR: join(this.opts.dataDir, "plugins", m.id) },
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
        if (host.attached) this.onExit(host, null);
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
    if (host.stopping || this.stopped || host.attached) {
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
    let markReady!: () => void;
    host.ready = new Promise<void>((r) => (markReady = r));
    host.markReady = markReady;
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
      pid: host.proc?.pid ?? null,
      restarts: host.restarts,
      permissions: m.permissions,
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
        return this.invoke(host, params as InvokeParams);

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
        this.resolveApproval(approval, { decision: params.decision, note: params.note }, id);
        return {};
      }

      case "approval.list":
        this.require(host, "approve.decide", method);
        return this.pendingApprovals();

      case "journal.query":
        this.require(host, "journal.read", method);
        return this.store.query(params as JournalQueryParams);

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
      this.ops.set(opId, { id: opId, caller, callee: p.target, subscribers: new Set([caller]), traceId, causationId: seq });
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
      const { seq } = this.journal(id, "op.update", op.traceId, op.causationId, { opId: op.id, update: p.update });
      for (const sub of op.subscribers) this.hosts.get(sub)?.peer?.notify("op.update", { opId: op.id, update: p.update, seq });
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

  private endOp(opId: string, p: OpEndParams, source: string) {
    const op = this.ops.get(opId);
    if (!op) return;
    this.ops.delete(opId);
    const { seq } = this.journal(source, "op.end", op.traceId, op.causationId, { opId, result: p.result, error: p.error });
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
    this.ops.set(opId, { id: opId, caller: id, callee: KERNEL, subscribers: new Set([id]), traceId, causationId: seq });
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

  /** Pending approvals, for UIs that connect after the pending event was published. */
  pendingApprovals() {
    return [...this.approvals.values()].map((a) => ({ approvalId: a.id, requester: a.requester, ...a.params }));
  }
}
