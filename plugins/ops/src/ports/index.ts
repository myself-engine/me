// Ports: what the ops plugin needs from the outside world. Every port is read-only toward the things it checks.
import type { CheckRecord, CheckSpec, Observation } from "../domain/check.ts";

/** Runs one check and reports what it saw. Must not throw; failures become `down` or `unknown` observations. */
export type Probe = (spec: CheckSpec) => Promise<Observation>;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the program could not be started at all (e.g. not installed). */
  spawnError?: string;
  /** Pid of the spawned program, when it started. */
  pid?: number;
}

/** Runs a program by argv, never through a shell. */
export interface Exec {
  run(argv: string[], timeoutMs: number): Promise<ExecResult>;
}

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Calls `fn` every `ms` until the returned function is called. */
  every(ms: number, fn: () => void): () => void;
}

export interface CheckStore {
  list(): Promise<CheckRecord[]>;
  put(record: CheckRecord): Promise<void>;
}

export interface Events {
  /** `name` is relative to the plugin, e.g. `check.down` becomes `ops.check.down`. */
  emit(name: string, data: unknown): Promise<void>;
}
