// Use cases of the brgr plugin, written against ports only.
import { commitMessage, touchedFiles } from "../domain/commit.ts";
import { createQueuedTask, transition, type Task, type TaskPatch, type TaskState } from "../domain/task.ts";
import type { VerifyInfo } from "../domain/task.ts";
import { firstFailure, parseTaskStatus } from "../domain/verify.ts";
import type { Approvals, BrgrCli, BrgrConfig, Budget, CliResult, Events, Git, TaskStore, Verifier } from "../ports/index.ts";

export interface ServiceDeps {
  brgr: BrgrCli;
  git: Git;
  store: TaskStore;
  events: Events;
  deadlineSeconds: () => number;
  now?: () => string;
  sleep?: (ms: number) => Promise<unknown>;
  /** Plugin config (maxRunning, verify, verifyRequired, verifyTimeoutMs). Defaults to {}. */
  config?: () => BrgrConfig;
  /** Runs the sealed diff's project checks. Defaults to a no-check (skipped) stub. */
  verifier?: Verifier;
  /** Optional budget plugin; absent or failing calls let the delegation proceed. */
  budget?: Budget;
  /** Kernel approval gate for budget-requested human decisions. */
  approvals?: Approvals;
  /** Ids for queued delegations (brgr assigns its own id when they start). */
  newId?: () => string;
}

export interface DelegateParams {
  harness: string;
  model?: string;
  effort?: string;
  objective: string;
  project: string;
  criterion?: string;
  origin?: Record<string, unknown>;
  /** Full access mode: a successful sealed result is accepted and committed without review. */
  autoApply?: boolean;
}

const DEFAULT_CRITERION = "The objective is satisfied and the result explains what changed.";
const DEFAULT_MAX_RUNNING = 3;
const BUDGET_APPROVAL_EXPIRES_SEC = 600;
const skipVerifier: Verifier = { verify: async () => ({ state: "skipped", commands: [] }) };
const cliError = (r: CliResult) => (r.stderr.trim() || r.stdout.trim()).slice(0, 300);
const errorText = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 500);

/** brgr's own id for a started task; queued tasks have none yet, old tasks use their id. */
const remote = (t: Task): string | null => t.remoteId ?? (t.state === "queued" ? null : t.taskId);

export function createService(deps: ServiceDeps) {
  const { brgr, git, store, events } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const readConfig: () => BrgrConfig = deps.config ?? (() => ({}));
  const verifier = deps.verifier ?? skipVerifier;
  const newId = deps.newId ?? (() => `q-${crypto.randomUUID().slice(0, 8)}`);
  const waiting = new Set<string>();
  let budgetWarned = false;

  const warnOnce = (msg: string) => {
    if (budgetWarned) return;
    budgetWarned = true;
    console.error(`[brgr] ${msg}`);
  };

  function requireId(taskId: unknown): string {
    if (typeof taskId !== "string" || !taskId) throw new Error("taskId is required");
    return taskId;
  }

  async function load(taskId: string) {
    const task = await store.get(requireId(taskId));
    if (!task) throw new Error(`unknown task ${taskId}`);
    return task;
  }

  /** Records an error on a task without changing its state, so the user can fix the cause and retry. */
  async function noteError(taskId: string, error: string) {
    const task = await load(taskId);
    await store.put({ ...task, error, updatedAt: now() });
  }

  /** Moves a stored task through the state machine, saves it, and emits `task.<state>`. */

  async function setState(taskId: string, to: TaskState, patch: TaskPatch = {}) {
    const task = transition(await load(taskId), to, patch, now());
    await store.put(task);
    await events.emit(`task.${to}`, { taskId, state: to, harness: task.harness });
    return task;
  }

  /**
   * Budget hook: before a delegation starts (also when a queued one is dequeued),
   * the optional budget plugin may deny it or ask for a human decision.
   * Throws a Korean error when the delegation must not start.
   * A missing plugin or a failed call lets the delegation proceed.
   */
  async function gateBudget(p: { harness: string; project: string; autoApply: boolean; objective: string }) {
    if (!deps.budget) return;
    let res;
    try {
      res = await deps.budget.check({ harness: p.harness, project: p.project, autoApply: p.autoApply });
    } catch (err) {
      warnOnce(`budget check failed, proceeding: ${errorText(err)}`);
      return;
    }
    if (!res || (res.ok && !res.needsApproval)) return;
    if (!res.ok) {
      const reason = res.reason?.trim();
      throw new Error(reason ? `예산 때문에 위임하지 않았어요: ${reason.slice(0, 300)}` : "예산 때문에 위임하지 않았어요");
    }
    if (!deps.approvals) {
      warnOnce("budget asked for approval but no approval gate is wired, proceeding");
      return;
    }
    let decision;
    try {
      decision = await deps.approvals.request({
        summary: `예산 확인 후 위임 (${p.harness})`,
        risk: "medium",
        payload: { harness: p.harness, project: p.project, objective: p.objective, autoApply: p.autoApply, reason: res.reason ?? null },
        expiresInSec: BUDGET_APPROVAL_EXPIRES_SEC,
      });
    } catch (err) {
      throw new Error(`예산 승인을 요청하지 못했어요: ${errorText(err)}`);
    }
    if (decision.decision !== "approve") {
      throw new Error(
        decision.note === "expired" ? "예산 승인 시간이 지나서 맡기지 않았어요." : "예산 승인이 거절돼서 맡기지 않았어요.",
      );
    }
  }

  async function delegate(p: DelegateParams) {
    if (!p.project) throw new Error("project directory is required");
    if (!p.harness.startsWith("local.")) throw new Error(`unknown harness id: ${p.harness}`);
    const autoApply = p.autoApply ?? false;
    // Fail fast here; the gate runs again when the queued delegation actually starts.
    await gateBudget({ harness: p.harness, project: p.project, autoApply, objective: p.objective });
    const criterion = p.criterion ?? DEFAULT_CRITERION;
    const worker = { ...(p.model ? { model: p.model } : {}), ...(p.effort ? { effort: p.effort } : {}) };
    const task = createQueuedTask(
      {
        taskId: newId(),
        harness: p.harness,
        ...worker,
        objective: p.objective,
        project: p.project,
        criterion,
        origin: p.origin ?? null,
        ...(autoApply ? { autoApply: true } : {}),
      },
      now(),
    );
    await store.put(task);
    await events.emit("task.queued", { taskId: task.taskId, state: "queued", harness: task.harness });
    await pump();
    return { taskId: task.taskId };
  }

  /** Starts queued delegations FIFO while a per-project and a global slot are free. */
  let pumpChain: Promise<void> = Promise.resolve();

  function pump(): Promise<void> {
    pumpChain = pumpChain.then(runPump, runPump);
    return pumpChain;
  }

  async function runPump() {
    const maxRunning = readConfig().maxRunning ?? DEFAULT_MAX_RUNNING;
    const active = [...(await store.listByState("running")), ...(await store.listByState("awaiting-input"))];
    let slots = maxRunning - active.length;
    if (slots <= 0) return;
    const queued = (await store.listByState("queued")).sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.taskId.localeCompare(b.taskId),
    );
    if (queued.length === 0) return;
    const perProject = new Map<string, number>();
    for (const t of active) perProject.set(t.project, (perProject.get(t.project) ?? 0) + 1);
    for (const q of queued) {
      if (slots <= 0) break;
      // One running delegation per project; a blocked head never stops later projects.
      if ((perProject.get(q.project) ?? 0) >= 1) continue;
      perProject.set(q.project, (perProject.get(q.project) ?? 0) + 1);
      slots -= 1;
      await startQueued(q.taskId);
    }
  }

  /** Runs brgr for one queued delegation and hands it to the watcher. */
  async function startQueued(taskId: string) {
    const task = await load(taskId);
    if (task.state !== "queued") return;
    try {
      await gateBudget({ harness: task.harness, project: task.project, autoApply: task.autoApply ?? false, objective: task.objective });
    } catch (err) {
      await setState(taskId, "failed", { error: errorText(err) });
      void pump();
      return;
    }
    const worker = { ...(task.model ? { model: task.model } : {}), ...(task.effort ? { effort: task.effort } : {}) };
    const r = await brgr.run({
      objective: task.objective,
      harness: task.harness,
      criterion: task.criterion,
      deadlineSeconds: deps.deadlineSeconds(),
      project: task.project,
      ...worker,
    });
    if (r.code !== 0) {
      const msg = r.stderr.trim() || r.stdout.trim();
      let error = `brgr run failed: ${msg.slice(0, 300)}`;
      if (/uncommitted changes/.test(msg)) error = `대상 저장소에 커밋되지 않은 변경이 있어 위임할 수 없어요: ${task.project}`;
      else if (/exact Herdr source/.test(msg)) error = "커널이 에이전트 없는 Herdr pane에서 실행돼야 brgr로 위임할 수 있어요";
      await setState(taskId, "failed", { error });
      void pump();
      return;
    }
    let receipt: { task_id?: string };
    try {
      receipt = JSON.parse(r.stdout);
    } catch {
      receipt = {};
    }
    if (!receipt.task_id) {
      await setState(taskId, "failed", { error: "brgr run 결과를 읽지 못했어요" });
      void pump();
      return;
    }
    const running = transition(await load(taskId), "running", { remoteId: receipt.task_id }, now());
    await store.put(running);
    await events.emit("task.running", { taskId, state: "running", harness: running.harness });
    void watch(taskId);
  }

  /** Runs the project's checks for a sealed diff and records the outcome on the task. */
  async function runVerify(task: Task): Promise<VerifyInfo> {
    try {
      const id = remote(task) ?? task.taskId;
      const d = await brgr.diff(id);
      // The task's own worktree already holds the worker's result (and usually
      // its installed dependencies); a failed or unknown status just falls back
      // to the temp clone at HEAD.
      const s = await brgr.status(id).catch(() => null);
      const at = s && s.code === 0 ? parseTaskStatus(s.stdout, id) : { workspace: null, base: null };
      return await verifier.verify({
        taskId: task.taskId,
        project: task.project,
        diff: d.code === 0 ? d.stdout : "",
        workspace: at.workspace,
        base: at.base,
      });
    } catch {
      return { state: "error", commands: [] };
    }
  }

  async function watch(taskId: string) {
    if (waiting.has(taskId)) return;
    waiting.add(taskId);
    try {
      for (;;) {
        const task = await load(taskId);
        const id = remote(task) ?? taskId;
        const r = await brgr.wait(id);
        if (r.code !== 0) {
          await setState(taskId, "failed", { error: (r.stderr.trim() || "brgr wait failed").slice(0, 500) });
          void pump();
          return;
        }
        const w = JSON.parse(r.stdout);
        if (w.state === "awaiting_input") {
          await setState(taskId, "awaiting-input");
          await sleep(5_000);
          continue;
        }
        const res = await brgr.result(id);
        let resultText: string | null = null;
        let error: string | null = null;
        if (res.code === 0) {
          const body = JSON.parse(res.stdout);
          resultText = (body.artifacts ?? []).map((a: { text?: string }) => a.text ?? "").join("\n").trim() || null;
          error = body.result?.error ? JSON.stringify(body.result.error).slice(0, 500) : null;
        }
        const sealed = await setState(taskId, w.outcome === "candidate" ? "sealed" : "failed", { outcome: w.outcome ?? null, resultText, error });
        if (sealed.state !== "sealed") {
          void pump();
          return;
        }
        // Verify gate: check the sealed diff before anyone (or autoApply) accepts it.
        const verify = await runVerify(sealed);
        const verified = { ...sealed, verify, updatedAt: now() };
        await store.put(verified);
        await events.emit("task.verified", { taskId, state: "sealed", harness: verified.harness, verify: verify.state });
        // Full access mode: a successful result applies itself through the same dirty-checked path as a manual accept.
        // A failure already ended in failed above, so it never auto-applies; accept's own failure lands in apply-failed.
        // The gate passes on checked code, or when there is nothing to check and the config does not require it.
        if (verified.autoApply ?? false) {
          const required = readConfig().verifyRequired ?? false;
          const gated = verify.state === "passed" || (verify.state === "skipped" && !required);
          if (!gated) {
            const failedCmd = verify.state === "failed" ? firstFailure(verify.commands) : null;
            await noteError(
              taskId,
              verify.state === "failed"
                ? `검사가 실패해서 자동 적용하지 않았어요${failedCmd ? ` (${failedCmd})` : ""}. 결과를 확인하고 직접 수락해 주세요.`
                : verify.state === "skipped"
                  ? "검사할 항목이 없어 자동 적용하지 않았어요. 결과를 확인하고 직접 수락해 주세요."
                  : "검사 실행에 실패해서 자동 적용하지 않았어요. 결과를 확인하고 직접 수락해 주세요.",
            );
          } else {
            try {
              await accept({ taskId, reason: "자동 적용 (전부 알아서)" });
            } catch {
              // accept already recorded the outcome (apply-failed, or sealed with a Korean error to fix and retry).
            }
          }
        }
        void pump();
        return;
      }
    } catch (err) {
      await setState(taskId, "failed", { error: errorText(err) }).catch(() => {});
      void pump();
    } finally {
      waiting.delete(taskId);
    }
  }

  /** Resumes waiting on tasks that were still running when the plugin last stopped, then restarts the queue in order. */
  async function resume() {
    for (const state of ["running", "awaiting-input"] as const) {
      for (const t of await store.listByState(state)) void watch(t.taskId);
    }
    await pump();
  }

  async function diff(p: { taskId: string; stat?: boolean }) {
    const task = await load(p?.taskId);
    const r = await brgr.diff(remote(task) ?? task.taskId, p.stat);
    return { diff: r.stdout, error: r.code === 0 ? null : r.stderr.trim() };
  }

  /** Accept = record the decision in brgr, apply the sealed diff to task.project, and commit it. */
  async function accept(p: { taskId: string; reason?: string }) {
    const reason = p.reason ?? "accepted from me";
    const task = await load(p.taskId);
    if (task.state !== "sealed") throw new Error(`봉인된 작업만 수락할 수 있어요 (현재 상태: ${task.state})`);

    // A dirty tree would mix the user's edits into the commit; refuse before brgr records anything.
    // The task stays sealed so the user can commit or stash their work and accept again.
    let dirty: string[];
    try {
      dirty = await git.status(task.project);
    } catch (err) {
      const message = `작업 트리 상태를 확인하지 못해 적용할 수 없어요: ${errorText(err)}`;
      await noteError(task.taskId, message);
      throw new Error(message);
    }
    if (dirty.length > 0) {
      const message = `대상 저장소에 커밋되지 않은 변경이 있어 적용할 수 없어요. 정리한 뒤 다시 수락해 주세요: ${task.project}`;
      await noteError(task.taskId, message);
      throw new Error(message);
    }

    // Read the sealed diff while the task is still sealed, so a failure here leaves it retryable.
    // Manual accept stays allowed whatever the verify gate said; the panel shows the gate's result.
    const id = remote(task) ?? task.taskId;
    const d = await brgr.diff(id);
    if (d.code !== 0) throw new Error(`brgr diff failed: ${cliError(d)}`);
    const files = touchedFiles(d.stdout);
    if (files.length === 0) throw new Error("봉인된 diff에 변경된 파일이 없어요");

    const r = await brgr.accept(id, reason);
    if (r.code !== 0) throw new Error(`brgr accept failed: ${cliError(r)}`);
    await setState(task.taskId, "accepted", { decisionReason: reason });

    try {
      const a = await brgr.apply(id, task.project);
      if (a.code !== 0) throw new Error(`brgr apply failed: ${cliError(a)}`);
      await git.add(task.project, files);
      await git.commit(task.project, commitMessage(task.objective, task.taskId));
      const commitSha = await git.headSha(task.project);
      return await setState(task.taskId, "applied", { commitSha, appliedAt: now(), error: null });
    } catch (err) {
      const message = `수락했지만 적용하지 못했어요: ${errorText(err)}`;
      await setState(task.taskId, "apply-failed", { error: message });
      throw new Error(message);
    }
  }

  async function reject(p: { taskId: string; reason?: string }) {
    const reason = p.reason ?? "rejected from me";
    const task = await load(p.taskId);
    transition(task, "rejected", {}, now()); // validate before touching brgr
    const r = await brgr.reject(remote(task) ?? task.taskId, reason);
    if (r.code !== 0) throw new Error(`brgr reject failed: ${cliError(r)}`);
    return setState(task.taskId, "rejected", { decisionReason: reason });
  }

  async function cancel(p: { taskId: string }) {
    const task = await load(p.taskId);
    transition(task, "cancelled", {}, now()); // validate before touching brgr
    // Queued delegations never reached brgr, so there is nothing to stop there.
    const id = remote(task);
    if (id) {
      const r = await brgr.cancel(id);
      if (r.code !== 0) throw new Error(r.stderr.trim() || "brgr cancel failed");
    }
    const cancelled = await setState(p.taskId, "cancelled");
    void pump();
    return cancelled;
  }

  return {
    delegate,
    watch,
    resume,
    diff,
    accept,
    reject,
    cancel,
    result: async (p: { taskId: string }): Promise<Task | null> => store.get(requireId(p?.taskId)),
  };
}

export type BrgrService = ReturnType<typeof createService>;
