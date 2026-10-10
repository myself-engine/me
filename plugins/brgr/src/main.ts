// brgr plugin: delegation through brgr's sealed-result contract.
// brgr must run from a Herdr pane with no agent in it; the kernel's own pane qualifies.
// Owner identity is a fixed non-agent session name (config.ownerSession).
import { hostname } from "node:os";
import { definePlugin } from "@me/sdk";

export type TaskState = "running" | "sealed" | "failed" | "awaiting-input" | "accepted" | "rejected" | "cancelled";

export interface Task {
  taskId: string;
  harness: string;
  objective: string;
  project: string;
  criterion: string;
  origin: Record<string, unknown> | null;
  state: TaskState;
  outcome: string | null;
  resultText: string | null;
  error: string | null;
  decisionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

const KIND = "brgr.task";
const now = () => new Date().toISOString();
const waiting = new Set<string>();

const plugin = definePlugin({
  async onInit() {
    await plugin.entity.registerKind(KIND, { type: "object", required: ["taskId", "state", "harness"] });
    // Resume waiting on tasks that were still running when the plugin last stopped.
    for (const state of ["running", "awaiting-input"] as const) {
      const docs = await plugin.entity.list<Task>({ kind: KIND, where: { state }, limit: 100 });
      for (const d of docs) void watch(d.data.taskId);
    }
  },
  methods: {
    "task.delegate": delegate,
    "task.result": async (p: { taskId: string }) => (await plugin.entity.get<Task>(KIND, p.taskId))?.data ?? null,
    "task.diff": async (p: { taskId: string; stat?: boolean }) => {
      const r = await brgr(["diff", p.taskId, ...(p.stat ? ["--stat"] : [])]);
      return { diff: r.stdout, error: r.code === 0 ? null : r.stderr.trim() };
    },
    "task.accept": (p: { taskId: string; reason?: string }) => decide(p.taskId, "accept", p.reason ?? "accepted from me"),
    "task.reject": (p: { taskId: string; reason?: string }) => decide(p.taskId, "reject", p.reason ?? "rejected from me"),
    "task.cancel": async (p: { taskId: string }) => {
      const r = await brgr(["cancel", p.taskId, "--json"]);
      if (r.code !== 0) throw new Error(r.stderr.trim() || "brgr cancel failed");
      return setState(p.taskId, { state: "cancelled" });
    },
    "harness.list": () => (plugin.config.harnesses as string[]) ?? ["local.claude-code", "local.codex", "local.gjc", "local.opencode"],
  },
});

const owner = () => (plugin.config.ownerSession as string) ?? `me:${hostname().split(".")[0]}`;

async function brgr(args: string[], cwd?: string) {
  const proc = Bun.spawn(["brgr", ...args, "--owner-session", owner()], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}

async function delegate(p: { harness: string; objective: string; project: string; criterion?: string; origin?: Record<string, unknown> }) {
  if (!p.project) throw new Error("project directory is required");
  if (!p.harness.startsWith("local.")) throw new Error(`unknown harness id: ${p.harness}`);
  const criterion = p.criterion ?? "The objective is satisfied and the result explains what changed.";
  const r = await brgr(
    ["run", p.objective, "--harness", p.harness, "--criterion", criterion, "--capture-diff", "--deadline-seconds", String(plugin.config.deadlineSeconds ?? 1800), "--json"],
    p.project,
  );
  if (r.code !== 0) {
    const msg = r.stderr.trim() || r.stdout.trim();
    if (/uncommitted changes/.test(msg)) throw new Error(`대상 저장소에 커밋되지 않은 변경이 있어 위임할 수 없어요: ${p.project}`);
    if (/exact Herdr source/.test(msg)) throw new Error("커널이 에이전트 없는 Herdr pane에서 실행돼야 brgr로 위임할 수 있어요");
    throw new Error(`brgr run failed: ${msg.slice(0, 300)}`);
  }
  const receipt = JSON.parse(r.stdout);
  const task: Task = {
    taskId: receipt.task_id,
    harness: p.harness,
    objective: p.objective,
    project: p.project,
    criterion,
    origin: p.origin ?? null,
    state: "running",
    outcome: null,
    resultText: null,
    error: null,
    decisionReason: null,
    createdAt: now(),
    updatedAt: now(),
  };
  await plugin.entity.upsert(KIND, task.taskId, task);
  await plugin.emit("task.running", { taskId: task.taskId, state: "running", harness: task.harness });
  void watch(task.taskId);
  return { taskId: task.taskId };
}

async function setState(taskId: string, patch: Partial<Task>) {
  const doc = await plugin.entity.get<Task>(KIND, taskId);
  if (!doc) throw new Error(`unknown task ${taskId}`);
  const task = { ...doc.data, ...patch, updatedAt: now() };
  await plugin.entity.upsert(KIND, taskId, task);
  if (patch.state) await plugin.emit(`task.${patch.state}`, { taskId, state: patch.state, harness: task.harness });
  return task;
}

async function watch(taskId: string) {
  if (waiting.has(taskId)) return;
  waiting.add(taskId);
  try {
    for (;;) {
      const r = await brgr(["wait", taskId, "--json"]);
      if (r.code !== 0) {
        await setState(taskId, { state: "failed", error: (r.stderr.trim() || "brgr wait failed").slice(0, 500) });
        return;
      }
      const w = JSON.parse(r.stdout);
      if (w.state === "awaiting_input") {
        await setState(taskId, { state: "awaiting-input" });
        await Bun.sleep(5_000);
        continue;
      }
      const res = await brgr(["result", taskId, "--json"]);
      let resultText: string | null = null;
      let error: string | null = null;
      if (res.code === 0) {
        const body = JSON.parse(res.stdout);
        resultText = (body.artifacts ?? []).map((a: any) => a.text ?? "").join("\n").trim() || null;
        error = body.result?.error ? JSON.stringify(body.result.error).slice(0, 500) : null;
      }
      await setState(taskId, { state: w.outcome === "candidate" ? "sealed" : "failed", outcome: w.outcome ?? null, resultText, error });
      return;
    }
  } catch (err: any) {
    await setState(taskId, { state: "failed", error: String(err?.message ?? err) }).catch(() => {});
  } finally {
    waiting.delete(taskId);
  }
}

async function decide(taskId: string, verb: "accept" | "reject", reason: string) {
  const r = await brgr([verb, taskId, "--reason", reason, "--json"]);
  if (r.code !== 0) throw new Error(`brgr ${verb} failed: ${(r.stderr.trim() || r.stdout.trim()).slice(0, 300)}`);
  return setState(taskId, { state: verb === "accept" ? "accepted" : "rejected", decisionReason: reason });
}

await plugin.run();
