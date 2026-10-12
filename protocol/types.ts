// me plugin protocol v1 — type definitions only (no runtime).
// Spec: docs/PROTOCOL.md. Section numbers below refer to that document.
// Language-neutral source: spec/protocol.schema.json. spec/schema.test.ts fails when this file drifts from it.

export const PROTOCOL_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 framing (§1). One frame per NDJSON line.
// ---------------------------------------------------------------------------

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type RpcId = number | string;

export interface RpcRequest<M extends string = string, P = unknown> {
  jsonrpc: "2.0";
  id: RpcId;
  method: M;
  params: P;
}

export interface RpcNotification<M extends string = string, P = unknown> {
  jsonrpc: "2.0";
  method: M;
  params: P;
}

export interface RpcSuccess<R = unknown> {
  jsonrpc: "2.0";
  id: RpcId;
  result: R;
}

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: JsonValue;
}

export interface RpcFailure {
  jsonrpc: "2.0";
  id: RpcId | null;
  error: RpcErrorObject;
}

export type RpcFrame = RpcRequest | RpcNotification | RpcSuccess | RpcFailure;

// §11
export const ErrorCode = {
  PermissionDenied: -32001,
  TargetUnavailable: -32002,
  Timeout: -32003,
  Cancelled: -32004,
  ProtocolMismatch: -32005,
  SchemaViolation: -32006,
} as const;

// ---------------------------------------------------------------------------
// Manifest (§2). Read by the kernel before the plugin process starts.
// ---------------------------------------------------------------------------

/** Plugin ids are lowercase kebab-case; they are also the event/kind namespace. */
export type PluginId = string;

export type Permission =
  | "read-state"
  | `write-state:${string}`
  | "emit"
  | "subscribe"
  | `call:${PluginId}`
  | "call:*"
  | "approve.request"
  | "approve.decide"
  | "journal.read"
  | "shell"
  | "network";

export interface Manifest {
  id: PluginId;
  version: string;
  protocol: { min: number; max: number };
  run: { command: string[]; cwd?: string; env?: Record<string, string>; envPass?: string[] };
  permissions: Permission[];
  provides?: {
    methods?: string[];
    events?: string[];
    /** Entity kinds this plugin owns, without the namespace prefix. */
    kinds?: string[];
  };
  /** Other plugins allowed to write a kind this plugin owns: { kind: [pluginId] }. */
  allowWriters?: Record<string, PluginId[]>;
  /** Event name patterns, `*` matches one or more trailing segments. */
  subscribes?: string[];
  restart?: { policy: "never" | "on-failure" | "always"; maxRestarts: number; windowSec: number };
}

// ---------------------------------------------------------------------------
// Context attached by the kernel to everything it forwards (§4, §6, §10).
// ---------------------------------------------------------------------------

export interface FrameContext {
  /** Global journal sequence number of this frame. */
  seq: number;
  /** Groups everything started by one user turn. */
  traceId: string;
  /** seq of the journal entry that directly caused this one, if any. */
  causationId: number | null;
  source: PluginId | "kernel";
  ts: string; // ISO 8601
}

// ---------------------------------------------------------------------------
// Connect-in handshake (§1, §3). Exec mode B: the plugin dials the kernel socket
// and sends `hello` as its first frame (id 0); `initialize` follows on success.
// ---------------------------------------------------------------------------

export interface HelloParams {
  manifest: Manifest;
  /** Contents of $ME_HOME/connect.token. */
  token: string;
}
export interface HelloResult {
  protocolVersion: number;
  /** Declared permissions intersected with the kernel's connectPermissions. */
  grantedPermissions: Permission[];
}

// ---------------------------------------------------------------------------
// Kernel → plugin (§3, §4, §5, §6)
// ---------------------------------------------------------------------------

export interface InitializeParams {
  protocolVersion: number;
  pluginId: PluginId;
  grantedPermissions: Permission[];
  config: Record<string, JsonValue>;
}
export interface InitializeResult {
  protocolVersion: number;
  ready: true;
}

export interface ShutdownParams {
  reason: "user" | "restart" | "kernel-exit" | "quarantine";
}

/** A call routed to the plugin that provides `method`. */
export interface CallParams<P = unknown> {
  method: string;
  params: P;
  stream: boolean;
  /** Present when stream is true; the callee reports progress against it. */
  opId?: string;
  ctx: FrameContext & { caller: PluginId };
}

export interface EventParams<D = unknown> {
  name: string;
  data: D;
  ctx: FrameContext;
}

export interface KernelToPlugin {
  initialize: RpcRequest<"initialize", InitializeParams>;
  shutdown: RpcRequest<"shutdown", ShutdownParams>;
  call: RpcRequest<"call", CallParams>;
  event: RpcNotification<"event", EventParams>;
  "op.update": RpcNotification<"op.update", OpUpdateParams>;
  "op.end": RpcNotification<"op.end", OpEndParams>;
  "op.cancel": RpcNotification<"op.cancel", OpRefParams>;
}

// ---------------------------------------------------------------------------
// Plugin → kernel. Kernel methods are called directly; plugin methods go
// through `invoke`.
// ---------------------------------------------------------------------------

// §4, §5
export interface InvokeParams<P = unknown> {
  target: PluginId;
  method: string;
  params: P;
  stream?: boolean;
  timeoutMs?: number;
  /** Omit to start a new trace (only plugins that receive user input should). */
  traceId?: string;
  /** seq of the frame being handled when this call was made; the SDK fills it in. */
  causationId?: number;
}
export type InvokeResult<R = unknown> = { result: R } | { opId: string };

export interface OpUpdateParams<U = unknown> {
  opId: string;
  update: U;
}
export interface OpEndParams<R = unknown> {
  opId: string;
  result?: R;
  error?: RpcErrorObject;
}
/** Params of op.cancel and op.subscribe. */
export interface OpRefParams {
  opId: string;
}

// §6
export interface EmitParams<D = unknown> {
  /** Must start with `<own plugin id>.`. */
  name: string;
  data: D;
  traceId?: string;
  causationId?: number;
}

export interface SubscribeParams {
  /** Same pattern syntax as Manifest.subscribes. */
  pattern: string;
}

// §7
export interface EntityRegisterKindParams {
  kind: string;
  schema: JsonValue;
}
export interface EntityUpsertParams {
  kind: string;
  id: string;
  data: JsonValue;
}
export interface EntityGetParams {
  kind: string;
  id: string;
}

export interface EntityDoc<T = unknown> {
  kind: string; // namespaced, e.g. "brgr.task"
  id: string;
  data: T;
  updatedSeq: number;
}

export interface EntityListParams {
  kind: string;
  /** Top-level field equality only. */
  where?: Record<string, JsonValue>;
  limit?: number;
  after?: string;
}

// §9
export type Risk = "low" | "medium" | "high";

export interface ApprovalRequestParams {
  summary: string;
  risk: Risk;
  payload?: JsonValue;
  expiresInSec?: number;
}
export interface ApprovalDecision {
  decision: "approve" | "reject";
  note?: string;
  /** Changes the decider made to the request's payload (e.g. a different harness). Only meaningful on approve. */
  amend?: Record<string, JsonValue>;
}
export interface ApprovalDecideParams extends ApprovalDecision {
  approvalId: string;
}
export type ApprovalListParams = Record<string, never>;

// §10
export interface JournalQueryParams {
  traceId?: string;
  sinceSeq?: number;
  source?: PluginId | "kernel";
  limit: number;
}
export interface JournalEntry {
  seq: number;
  ts: string;
  source: PluginId | "kernel";
  traceId: string | null;
  causationId: number | null;
  type: "call" | "result" | "error" | "event" | "op.update" | "op.end" | "approval" | "permission.denied" | "lifecycle";
  body: JsonValue;
}

export interface PluginToKernel {
  /** Connect-in plugins only: the first frame on the socket, before `initialize`. */
  hello: RpcRequest<"hello", HelloParams>;
  invoke: RpcRequest<"invoke", InvokeParams>;
  "op.update": RpcNotification<"op.update", OpUpdateParams>;
  "op.end": RpcNotification<"op.end", OpEndParams>;
  "op.subscribe": RpcRequest<"op.subscribe", OpRefParams>;
  "op.cancel": RpcRequest<"op.cancel", OpRefParams>;
  emit: RpcRequest<"emit", EmitParams>;
  subscribe: RpcRequest<"subscribe", SubscribeParams>;
  "entity.registerKind": RpcRequest<"entity.registerKind", EntityRegisterKindParams>;
  "entity.upsert": RpcRequest<"entity.upsert", EntityUpsertParams>;
  "entity.get": RpcRequest<"entity.get", EntityGetParams>;
  "entity.list": RpcRequest<"entity.list", EntityListParams>;
  /** Long-running: returns { opId }, resolves via op.end with ApprovalDecision. */
  "approval.request": RpcRequest<"approval.request", ApprovalRequestParams>;
  "approval.decide": RpcRequest<"approval.decide", ApprovalDecideParams>;
  /** Pending approvals, for UIs that start after the pending event. Needs approve.decide. */
  "approval.list": RpcRequest<"approval.list", ApprovalListParams>;
  "journal.query": RpcRequest<"journal.query", JournalQueryParams>;
  /** The request's call tree with timings and phases, built from the journal. Needs journal.read. */
  "trace.get": RpcRequest<"trace.get", { traceId: string }>;
}

// ---------------------------------------------------------------------------
// Kernel-published events and entities (§6, §12 flow 6)
// ---------------------------------------------------------------------------

export interface KernelEvents {
  "kernel.plugin.started": { pluginId: PluginId; pid: number };
  "kernel.plugin.stopped": { pluginId: PluginId; exitCode: number | null; signal: string | null };
  "kernel.plugin.quarantined": { pluginId: PluginId; restarts: number };
  "kernel.approval.pending": { approvalId: string; requester: PluginId } & ApprovalRequestParams;
  "kernel.approval.decided": { approvalId: string; decidedBy: PluginId } & ApprovalDecision;
  "kernel.permission.denied": { pluginId: PluginId; permission: Permission; method: string };
  "kernel.entity.changed": { kind: string; id: string; updatedSeq: number };
}

/** Exposed as entity kind "kernel.plugin" so UIs read plugin state like any other entity. */
export interface KernelPluginEntity {
  id: PluginId;
  version: string;
  state: "starting" | "running" | "stopped" | "quarantined";
  /** spawned: exec mode A; attached: in-process transport; connected: exec mode B over the kernel socket or TCP. */
  mode: "spawned" | "attached" | "connected";
  pid: number | null;
  restarts: number;
  /** Granted permissions; for connected plugins, capped by connectPermissions (remotePermissions over TCP). */
  permissions: Permission[];
  /** Peer address of a plugin connected in over TCP; absent otherwise. */
  remote?: { address: string; port: number };
  /** Streaming ops this plugin is serving right now. */
  activeOps?: number;
  /** Most recent error this plugin returned (call error or failed op). */
  lastError?: { at: string; method: string; message: string } | null;
}

/**
 * Standard progress update. A plugin serving a streaming op may send `op.update` with
 * `update: { kind: "phase", phase, label?, progress? }`; the kernel records it on the op.
 */
export interface PhaseUpdate {
  kind: "phase";
  /** Stable machine id, e.g. "judging". */
  phase: string;
  /** Human label for UIs, e.g. "판정 중". */
  label?: string;
  /** 0..1 when known. */
  progress?: number;
}

/**
 * Stream fragment, e.g. `{ kind: "text_delta", delta: "안" }`. `kind` ends in "_delta" and there are no other
 * fields. Subscribers get every fragment live; the journal merges consecutive fragments of one kind into one
 * `op.update` entry (with `coalesced: n`), written at least once a second and before any other update or op.end.
 */
export interface DeltaUpdate {
  kind: `${string}_delta`;
  delta: string;
}

/** Exposed as entity kind "kernel.op": live and recent streaming ops and approvals. */
export interface KernelOpEntity {
  opId: string;
  traceId: string;
  caller: PluginId;
  /** Plugin serving the op, or "kernel" for approvals. */
  callee: PluginId | "kernel";
  method: string;
  state: "running" | "waiting" | "done" | "failed" | "cancelled";
  phase: string | null;
  phaseLabel: string | null;
  progress: number | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  error: string | null;
}

/** One node of a request's timeline, built by the kernel from the journal (trace.get). */
export interface TraceNode {
  seq: number;
  type: "call" | "approval";
  caller: string;
  target: string;
  method: string;
  stream: boolean;
  status: "running" | "waiting" | "ok" | "error" | "cancelled";
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  phases: { phase: string; label: string | null; at: string }[];
  error: string | null;
  children: TraceNode[];
}

export interface TraceResult {
  traceId: string;
  startedAt: string | null;
  endedAt: string | null;
  nodes: TraceNode[];
}
