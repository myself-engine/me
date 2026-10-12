// Client side of the web plugin: bootstrap over HTTP, everything else over one WebSocket.
import type { KernelOpEntity, TraceNode, TraceResult } from "@me/protocol";

/** A live or recent streaming op (kernel.op entity): what is running right now and at which phase. */
export type Op = KernelOpEntity;
export type { TraceNode, TraceResult };

export type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Access mode per the head contract: read / project-write / full. The backend lands separately; the UI codes against the contract. */
export type Access = "read" | "project" | "full";

export interface Thread {
  id: string;
  title: string;
  project: string;
  /** The head's model and effort for this thread; unset follows HeadSettings. */
  model?: string | null;
  effort?: Effort | null;
  /** Access mode for this thread; unset follows HeadSettings. */
  access?: Access | null;
  updatedAt: string;
  createdAt: string;
}

/** gjc-head.settings: the head's defaults and the choices offered for the head and for workers. */
export interface HeadSettings {
  /** Which headless harness answers: "gjc" (default) or "omp". Absent on settings stored before harness selection existed. */
  harness?: "gjc" | "omp";
  /** Per-harness default models. Absent on settings stored before harness selection existed. */
  models?: { gjc: string; omp: string };
  model: string;
  effort: Effort;
  /** Default access mode for new threads. Absent on settings stored before access modes existed. */
  access?: Access;
  favorites: string[];
  /** Models the user starred in the picker. Absent on settings stored before favourites existed. */
  userFavorites?: string[];
  /** Favourites from config; the picker never removes them. Absent on old stored settings. */
  configFavorites?: string[];
  efforts: Effort[];
  workers: { models: Record<string, string[]>; efforts: string[] };
}
/** One model the head can run; `efforts` is null when unknown. */
export interface ModelInfo {
  id: string;
  efforts: Effort[] | null;
}

export interface Message {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  text: string;
  ts: string;
  traceId: string;
  status: "pending" | "streaming" | "done" | "error";
  understood?: { normalized: string; replaced: { from: string; to: string }[] };
  summary?: { summaryEn: string; brief: string; needsCodeChange: boolean; scope: string; harness: string; harnessReason: string; criterion?: string };
  judgement?: { simpleProb: number; confidence: number; source: string; model: string };
  route?: "direct" | "delegate";
  taskId?: string | null;
  delegation?: { state: string; harness: string; suggestedHarness?: string; brief: string; criterion?: string; approvalId?: string; note?: string; model?: string; effort?: string };
  error?: string;
}

export interface Task {
  taskId: string;
  harness: string;
  objective: string;
  project: string;
  criterion?: string;
  /** Worker model and effort asked for at delegation. */
  model?: string;
  effort?: string;
  state: string;
  outcome: string | null;
  resultText: string | null;
  error: string | null;
  commitSha?: string | null;
  decisionReason?: string | null;
  /** Undo of the applied commit; null until task.revert runs. */
  revert?: { commit: string; at: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface PluginInfo {
  id: string;
  version: string;
  state: "starting" | "running" | "stopped" | "quarantined";
  pid: number | null;
  restarts: number;
  permissions: string[];
  mode?: "spawned" | "attached" | "connected";
  remote?: { address: string; port: number };
  /** Streaming ops this plugin is serving right now. */
  activeOps?: number;
  lastError?: { at: string; method: string; message: string } | null;
}

export interface OpsCheck {
  id: string;
  kind: string;
  ok: boolean;
  status: "up" | "down" | "unknown";
  detail: string;
  latencyMs: number;
  checkedAt: string;
  since: string;
  /** ops instance that reported it: "ops" for this Mac, "ops-<server>" for connected servers. */
  source?: string;
  /** Human name for people; the UI falls back to id when absent. */
  name?: string;
  /** What to do next, in the check's own words; the UI falls back to generic help. */
  hint?: string;
  /** True when the conversation path needs this check; the UI then warns chat may break. */
  affectsChat?: boolean;
}

export interface Approval {
  approvalId: string;
  requester: string;
  summary: string;
  risk: "low" | "medium" | "high";
  payload?: any;
}

/** gjc-head.alert: the latest blocking problem per cause; only active ones block. */
export interface HeadAlert {
  id: string;
  cause: string;
  title: string;
  fix: string;
  detail?: string;
  active: boolean;
  ts: string;
  updatedAt: string;
  threadId?: string;
  messageId?: string;
}

/** Who is viewing: set when the request came through `tailscale serve`, null for localhost. */
export interface Viewer {
  login: string;
  name: string;
}

export interface Bootstrap {
  token: string;
  viewer: Viewer | null;
  threads: Thread[];
  messages: Message[];
  tasks: Task[];
  plugins: PluginInfo[];
  ops: Op[];
  checks: OpsCheck[];
  approvals: Approval[];
  headSettings?: HeadSettings | null;
  alerts?: HeadAlert[];
  config: { projects: string[]; addedProjects?: string[]; defaultProject: string; githubRepo: string | null };
}

export type ServerMsg =
  | { type: "reply"; replyTo: string; ok: boolean; result?: any; error?: string }
  | { type: "entity"; kind: string; id: string; data: any }
  | { type: "approval"; event: string; data: any; traceId: string }
  | { type: "op.update"; opId: string; update: any; traceId: string }
  | { type: "op.end"; opId: string; result?: any; error?: string; traceId: string }
  | { type: "notice"; event: string; data: any };

export class Connection {
  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private queue: string[] = [];
  onMessage: (m: ServerMsg) => void = () => {};
  onStatus: (s: "connecting" | "open" | "closed") => void = () => {};

  constructor(private token: string) {}

  connect() {
    this.onStatus("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${this.token}`);
    this.ws = ws;
    ws.onopen = () => {
      this.onStatus("open");
      this.queue.splice(0).forEach((s) => ws.send(s));
    };
    ws.onclose = () => {
      this.onStatus("closed");
      for (const p of this.pending.values()) p.reject(new Error("연결이 끊겼어요"));
      this.pending.clear();
      setTimeout(() => this.connect(), 1500);
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data) as ServerMsg;
      if (m.type === "reply") {
        const p = this.pending.get(m.replyTo);
        if (!p) return;
        this.pending.delete(m.replyTo);
        m.ok ? p.resolve(m.result) : p.reject(new Error(m.error ?? "요청 실패"));
        return;
      }
      this.onMessage(m);
    };
  }

  request<T = any>(type: string, body: Record<string, unknown> = {}): Promise<T> {
    const id = crypto.randomUUID();
    const s = JSON.stringify({ id, type, ...body });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(s);
      else this.queue.push(s);
    });
  }
}

export async function fetchBootstrap(): Promise<Bootstrap> {
  const res = await fetch("/api/bootstrap");
  if (!res.ok) throw new Error(`bootstrap ${res.status}`);
  return res.json();
}
