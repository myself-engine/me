// Client side of the web plugin: bootstrap over HTTP, everything else over one WebSocket.

export interface Thread {
  id: string;
  title: string;
  project: string;
  updatedAt: string;
  createdAt: string;
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
  delegation?: { state: string; harness: string; suggestedHarness?: string; brief: string; criterion?: string; approvalId?: string; note?: string };
  error?: string;
}

export interface Task {
  taskId: string;
  harness: string;
  objective: string;
  project: string;
  state: string;
  outcome: string | null;
  resultText: string | null;
  error: string | null;
  commitSha?: string | null;
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
}

export interface Approval {
  approvalId: string;
  requester: string;
  summary: string;
  risk: "low" | "medium" | "high";
  payload?: any;
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
  checks: OpsCheck[];
  approvals: Approval[];
  config: { projects: string[]; defaultProject: string; githubRepo: string | null };
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
