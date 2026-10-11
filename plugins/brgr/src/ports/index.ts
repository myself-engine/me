// Ports: what the brgr plugin needs from the outside world.
import type { Task, TaskState } from "../domain/task.ts";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunRequest {
  objective: string;
  harness: string;
  criterion: string;
  deadlineSeconds: number;
  /** Repository the worker branches from; brgr runs with this as cwd. */
  project: string;
  /** Worker model and effort; unset means the harness's own default. */
  model?: string;
  effort?: string;
}

/** The brgr CLI. Every call returns the raw process result; callers interpret exit codes and JSON. */
export interface BrgrCli {
  run(req: RunRequest): Promise<CliResult>;
  wait(taskId: string): Promise<CliResult>;
  result(taskId: string): Promise<CliResult>;
  diff(taskId: string, stat?: boolean): Promise<CliResult>;
  accept(taskId: string, reason: string): Promise<CliResult>;
  reject(taskId: string, reason: string): Promise<CliResult>;
  cancel(taskId: string): Promise<CliResult>;
  /** Writes the sealed diff into `workspace` (`--execute`). */
  apply(taskId: string, workspace: string): Promise<CliResult>;
}

/** Git in a working tree. Methods throw on failure. */
export interface Git {
  /** Porcelain status lines for tracked files only (untracked files are ignored). */
  status(cwd: string): Promise<string[]>;
  add(cwd: string, files: string[]): Promise<void>;
  commit(cwd: string, message: string): Promise<void>;
  headSha(cwd: string): Promise<string>;
}

export interface TaskStore {
  get(taskId: string): Promise<Task | null>;
  put(task: Task): Promise<void>;
  listByState(state: TaskState): Promise<Task[]>;
}

export interface Events {
  /** `name` is relative to the plugin, e.g. `task.applied` becomes `brgr.task.applied`. */
  emit(name: string, data: unknown): Promise<void>;
}
