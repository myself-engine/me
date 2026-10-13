// Ports: what the watch plugin needs from the outside world. Polling only reads;
// it never sends keys or prompts to a pane.
export interface HerdrAgent {
  exec(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface Clock {
  now(): number;
  every(ms: number, fn: () => void): () => void;
}

export interface AgentStore {
  list(): Promise<import("../domain/watch.ts").WatchAgent[]>;
  put(agent: import("../domain/watch.ts").WatchAgent): Promise<void>;
  remove(pane: string): Promise<void>;
  getStatus(): Promise<WatchStatus | null>;
  putStatus(status: WatchStatus): Promise<void>;
}

export interface WatchStatus {
  state: "ok" | "problem";
  problem: string | null;
  checkedAt: string;
}

export interface WatchEvents {
  /** `name` is relative to the plugin, e.g. `stalled` becomes `watch.stalled`. */
  emit(name: string, data: unknown): Promise<void>;
}
