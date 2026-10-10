// Use cases of the brgr plugin, written against ports only.
import { commitMessage, touchedFiles } from "../domain/commit.ts";
import { createTask, transition, type Task, type TaskPatch, type TaskState } from "../domain/task.ts";
import type { BrgrCli, CliResult, Events, Git, TaskStore } from "../ports/index.ts";

export interface ServiceDeps {
  brgr: BrgrCli;
  git: Git;
  store: TaskStore;
  events: Events;
  deadlineSeconds: () => number;
  now?: () => string;
  sleep?: (ms: number) => Promise<unknown>;
}

export interface DelegateParams {
  harness: string;
  objective: string;
  project: string;
  criterion?: string;
  origin?: Record<string, unknown>;
}

const DEFAULT_CRITERION = "The objective is satisfied and the result explains what changed.";
const cliError = (r: CliResult) => (r.stderr.trim() || r.stdout.trim()).slice(0, 300);
const errorText = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 500);

export function createService(deps: ServiceDeps) {
  const { brgr, git, store, events } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const waiting = new Set<string>();

  async function load(taskId: string) {
    const task = await store.get(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    return task;
  }

  /** Moves a stored task through the state machine, saves it, and emits `task.<state>`. */
  async function setState(taskId: string, to: TaskState, patch: TaskPatch = {}) {
    const task = transition(await load(taskId), to, patch, now());
    await store.put(task);
    await events.emit(`task.${to}`, { taskId, state: to, harness: task.harness });
    return task;
  }

  async function delegate(p: DelegateParams) {
    if (!p.project) throw new Error("project directory is required");
    if (!p.harness.startsWith("local.")) throw new Error(`unknown harness id: ${p.harness}`);
    const criterion = p.criterion ?? DEFAULT_CRITERION;
    const r = await brgr.run({ objective: p.objective, harness: p.harness, criterion, deadlineSeconds: deps.deadlineSeconds(), project: p.project });
    if (r.code !== 0) {
      const msg = r.stderr.trim() || r.stdout.trim();
      if (/uncommitted changes/.test(msg)) throw new Error(`대상 저장소에 커밋되지 않은 변경이 있어 위임할 수 없어요: ${p.project}`);
      if (/exact Herdr source/.test(msg)) throw new Error("커널이 에이전트 없는 Herdr pane에서 실행돼야 brgr로 위임할 수 있어요");
      throw new Error(`brgr run failed: ${msg.slice(0, 300)}`);
    }
    const receipt = JSON.parse(r.stdout);
    const task = createTask(
      { taskId: receipt.task_id, harness: p.harness, objective: p.objective, project: p.project, criterion, origin: p.origin ?? null },
      now(),
    );
    await store.put(task);
    await events.emit("task.running", { taskId: task.taskId, state: "running", harness: task.harness });
    void watch(task.taskId);
    return { taskId: task.taskId };
  }

  async function watch(taskId: string) {
    if (waiting.has(taskId)) return;
    waiting.add(taskId);
    try {
      for (;;) {
        const r = await brgr.wait(taskId);
        if (r.code !== 0) {
          await setState(taskId, "failed", { error: (r.stderr.trim() || "brgr wait failed").slice(0, 500) });
          return;
        }
        const w = JSON.parse(r.stdout);
        if (w.state === "awaiting_input") {
          await setState(taskId, "awaiting-input");
          await sleep(5_000);
          continue;
        }
        const res = await brgr.result(taskId);
        let resultText: string | null = null;
        let error: string | null = null;
        if (res.code === 0) {
          const body = JSON.parse(res.stdout);
          resultText = (body.artifacts ?? []).map((a: { text?: string }) => a.text ?? "").join("\n").trim() || null;
          error = body.result?.error ? JSON.stringify(body.result.error).slice(0, 500) : null;
        }
        await setState(taskId, w.outcome === "candidate" ? "sealed" : "failed", { outcome: w.outcome ?? null, resultText, error });
        return;
      }
    } catch (err) {
      await setState(taskId, "failed", { error: errorText(err) }).catch(() => {});
    } finally {
      waiting.delete(taskId);
    }
  }

  /** Resumes waiting on tasks that were still running when the plugin last stopped. */
  async function resume() {
    for (const state of ["running", "awaiting-input"] as const) {
      for (const t of await store.listByState(state)) void watch(t.taskId);
    }
  }

  async function diff(p: { taskId: string; stat?: boolean }) {
    const r = await brgr.diff(p.taskId, p.stat);
    return { diff: r.stdout, error: r.code === 0 ? null : r.stderr.trim() };
  }

  /** Accept = record the decision in brgr, apply the sealed diff to task.project, and commit it. */
  async function accept(p: { taskId: string; reason?: string }) {
    const reason = p.reason ?? "accepted from me";
    const task = await load(p.taskId);
    if (task.state !== "sealed") throw new Error(`봉인된 작업만 수락할 수 있어요 (현재 상태: ${task.state})`);

    // A dirty tree would mix the user's edits into the commit; refuse before brgr records anything.
    let dirty: string[];
    try {
      dirty = await git.status(task.project);
    } catch (err) {
      const message = `작업 트리 상태를 확인하지 못해 적용할 수 없어요: ${errorText(err)}`;
      await setState(task.taskId, "apply-failed", { error: message });
      throw new Error(message);
    }
    if (dirty.length > 0) {
      const message = `대상 저장소에 커밋되지 않은 변경이 있어 적용할 수 없어요: ${task.project}`;
      await setState(task.taskId, "apply-failed", { error: message, decisionReason: reason });
      throw new Error(message);
    }

    // Read the sealed diff while the task is still sealed, so a failure here leaves it retryable.
    const d = await brgr.diff(task.taskId);
    if (d.code !== 0) throw new Error(`brgr diff failed: ${cliError(d)}`);
    const files = touchedFiles(d.stdout);
    if (files.length === 0) throw new Error("봉인된 diff에 변경된 파일이 없어요");

    const r = await brgr.accept(task.taskId, reason);
    if (r.code !== 0) throw new Error(`brgr accept failed: ${cliError(r)}`);
    await setState(task.taskId, "accepted", { decisionReason: reason });

    try {
      const a = await brgr.apply(task.taskId, task.project);
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
    const r = await brgr.reject(task.taskId, reason);
    if (r.code !== 0) throw new Error(`brgr reject failed: ${cliError(r)}`);
    return setState(task.taskId, "rejected", { decisionReason: reason });
  }

  async function cancel(p: { taskId: string }) {
    transition(await load(p.taskId), "cancelled", {}, now());
    const r = await brgr.cancel(p.taskId);
    if (r.code !== 0) throw new Error(r.stderr.trim() || "brgr cancel failed");
    return setState(p.taskId, "cancelled");
  }

  return {
    delegate,
    watch,
    resume,
    diff,
    accept,
    reject,
    cancel,
    result: async (p: { taskId: string }): Promise<Task | null> => store.get(p.taskId),
  };
}

export type BrgrService = ReturnType<typeof createService>;
