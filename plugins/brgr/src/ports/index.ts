import type { JsonValue } from "@me/protocol";
import type { Task, TaskState, VerifyInfo } from "../domain/task.ts";

/** A worker→owner or owner→worker message on a brgr task. */
export interface BrgrMessage {
  id: string;
  kind: string;
  from: string;
  to: string;
  body: string;
  replyTo?: string | null;
  at?: string;
}

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
  /** Uncommitted files carried into the worker's base (`--snapshot-path`, repeatable). */
  snapshotPaths?: string[];
}

/** The brgr CLI. Every call returns the raw process result; callers interpret exit codes and JSON. */
export interface BrgrCli {
  run(req: RunRequest): Promise<CliResult>;
  wait(taskId: string): Promise<CliResult>;
  result(taskId: string): Promise<CliResult>;
  diff(taskId: string, stat?: boolean): Promise<CliResult>;
  /** Shows one task's attempt and result state; carries `workspace` (the task worktree) when it still exists. */
  status(taskId: string): Promise<CliResult>;
  accept(taskId: string, reason: string): Promise<CliResult>;
  reject(taskId: string, reason: string): Promise<CliResult>;
  cancel(taskId: string): Promise<CliResult>;
  /** Writes the sealed diff into `workspace` (`--execute`). */
  apply(taskId: string, workspace: string): Promise<CliResult>;
  /** Worker↔owner messages on a task (`brgr message list/send --json`). */
  messages(taskId: string, recipient: "owner" | "worker"): Promise<CliResult>;
  sendMessage(taskId: string, p: { to: "owner" | "worker"; kind: "question" | "reply" | "note"; body: string; replyTo?: string }): Promise<CliResult>;
  /** Native input to the task's TUI, e.g. a menu answer (`brgr input --json`). */
  input(taskId: string, p: { text?: string; key?: string }): Promise<CliResult>;
}

/** Git in a working tree. Unless noted, methods throw on failure. */
export interface Git {
  /** Porcelain status lines for tracked files only (untracked files are ignored). */
  status(cwd: string): Promise<string[]>;
  add(cwd: string, files: string[]): Promise<void>;
  commit(cwd: string, message: string): Promise<void>;
  headSha(cwd: string): Promise<string>;
  /** True when `sha` is an ancestor of HEAD (i.e. on the current branch's history). */
  isAncestor(cwd: string, sha: string): Promise<boolean>;
  /** True when the commit is a merge (more than one parent). */
  isMerge(cwd: string, sha: string): Promise<boolean>;
  /** Paths the commit touched. */
  filesIn(cwd: string, sha: string): Promise<string[]>;
  /** Paths changed between `from` (exclusive) and `to` (inclusive); empty when equal. */
  changedSince(cwd: string, from: string, to?: string): Promise<string[]>;
  /** `git revert --no-edit`; throws with git's message when it does not apply cleanly. */
  revert(cwd: string, sha: string): Promise<void>;
  /** Aborts an in-progress revert, restoring the tree; never throws. */
  abortRevert(cwd: string): Promise<void>;
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


/** Plugin config for brgr (from pluginConfig brgr). All fields optional. */
export interface BrgrConfig {
  /** At most this many running delegations globally. Default 3. */
  maxRunning?: number;
  /** Explicit verify commands per project path or repo name. */
  verify?: Record<string, string[]>;
  /** When true, a sealed task with no checks stays for review instead of auto-applying. Default false. */
  verifyRequired?: boolean;
  /** Per-command timeout in ms for verify runs. Default 600000 (10 min). */
  verifyTimeoutMs?: number;
  /** Extra uncommitted files to carry into the worker's base, per project path or repo name. */
  include?: Record<string, string[]>;
  /** Setup commands run by the worker before starting (no brgr support: sent as an objective line). */
  setup?: Record<string, string[]>;
}

/** Worker trust preparation (Codex config); best effort, never throws. */
export interface Trust {
  ensure(paths: string[]): Promise<void>;
}

/** Uncommitted files resolved from .worktreeinclude + config; names are never logged by callers. */
export interface SnapshotFiles {
  collect(project: string, patterns: string[]): Promise<{ files: { path: string; bytes: number }[] }>;
}

/** Runs a sealed diff's project checks, preferably in the task's own worktree. */
export interface Verifier {
  verify(p: {
    taskId: string;
    project: string;
    diff: string;
    /** The task's own brgr worktree; checks run there when it still exists, without touching tracked files. */
    workspace?: string | null;
    /** Commit a fallback clone checks out before applying the diff; HEAD when unknown. */
    base?: string | null;
  }): Promise<VerifyInfo>;
}

/** Reply of the optional budget plugin's `budget.check`. */
export interface BudgetCheck {
  ok: boolean;
  needsApproval?: boolean;
  reason?: string;
}

/** The optional budget plugin, called through the kernel before a delegation starts. */
export interface Budget {
  check(p: { harness: string; project: string; autoApply: boolean }): Promise<BudgetCheck>;
}

export interface BudgetApproval {
  approvalId: string;
  decision: "approve" | "reject";
  note?: string;
}

/** Kernel approval gate, used when the budget plugin asks for a human decision. */
export interface Approvals {
  request(p: {
    summary: string;
    risk: "low" | "medium" | "high";
    payload: Record<string, JsonValue>;
    expiresInSec: number;
  }): Promise<BudgetApproval>;
}
