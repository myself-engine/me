// Task state machine: pure functions only, no I/O.

export type TaskState =
  | "running"
  | "awaiting-input"
  | "sealed"
  | "failed"
  | "accepted"
  | "applied"
  | "apply-failed"
  | "rejected"
  | "cancelled";

export interface Task {
  taskId: string;
  harness: string;
  objective: string;
  project: string;
  criterion: string;
  /** Worker model and effort asked for at delegation; absent means the harness default. */
  model?: string;
  effort?: string;
  origin: Record<string, unknown> | null;
  /** Full access mode: when the sealed result succeeds it is accepted and committed without review. */
  autoApply: boolean;
  state: TaskState;
  outcome: string | null;
  resultText: string | null;
  error: string | null;
  decisionReason: string | null;
  /** Commit created in task.project when the accepted diff was applied. */
  commitSha: string | null;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Self-transitions are allowed where the watcher re-reports the same state (awaiting-input polls every few seconds).
const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  running: ["running", "awaiting-input", "sealed", "failed", "cancelled"],
  "awaiting-input": ["awaiting-input", "running", "sealed", "failed", "cancelled"],
  // sealed -> apply-failed: the project tree was dirty, so accept never reached brgr.
  sealed: ["accepted", "rejected", "apply-failed"],
  accepted: ["applied", "apply-failed"],
  failed: [],
  applied: [],
  "apply-failed": [],
  rejected: [],
  cancelled: [],
};

export class InvalidTransition extends Error {
  constructor(
    readonly taskId: string,
    readonly from: TaskState,
    readonly to: TaskState,
  ) {
    super(`task ${taskId}: cannot move from ${from} to ${to}`);
    this.name = "InvalidTransition";
  }
}

export const canTransition = (from: TaskState, to: TaskState) => TRANSITIONS[from].includes(to);

export const isTerminal = (state: TaskState) => TRANSITIONS[state].length === 0;

export type TaskPatch = Partial<Omit<Task, "taskId" | "state" | "createdAt" | "updatedAt">>;

/** Returns the task moved to `to` with `patch` applied, or throws InvalidTransition. */
export function transition(task: Task, to: TaskState, patch: TaskPatch, at: string): Task {
  if (!canTransition(task.state, to)) throw new InvalidTransition(task.taskId, task.state, to);
  return { ...task, ...patch, state: to, updatedAt: at };
}

export interface NewTask {
  taskId: string;
  harness: string;
  model?: string;
  effort?: string;
  objective: string;
  project: string;
  criterion: string;
  origin: Record<string, unknown> | null;
  autoApply?: boolean;
}

export function createTask(p: NewTask, at: string): Task {
  return {
    ...p,
    autoApply: p.autoApply ?? false,
    state: "running",
    outcome: null,
    resultText: null,
    error: null,
    decisionReason: null,
    commitSha: null,
    appliedAt: null,
    createdAt: at,
    updatedAt: at,
  };
}
