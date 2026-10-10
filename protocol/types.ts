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
  run: { command: string[]; cwd?: string; env?: Record<string, string> };
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
  pid: number | null;
  restarts: number;
  permissions: Permission[];
}
