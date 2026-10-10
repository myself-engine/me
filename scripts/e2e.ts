// End-to-end check of the core flows against a throwaway me (DONE.md item 5).
// Real: kernel, slang, summarize, jev, gjc-head, web (with the configured models).
// Fake: brgr (a worker run is slow and costly); it seals a result and applies it with a real git commit.
// Usage: bun run e2e            (exit code 0 = all flows passed)
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPipePair } from "@me/protocol";
import { definePlugin } from "@me/sdk";
import { Kernel, loadManifest, validateManifest } from "@me/kernel";

const root = join(import.meta.dir, "..");
const home = mkdtempSync(join(tmpdir(), "me-e2e-"));
const project = mkdtempSync(join(tmpdir(), "me-e2e-project-"));
const port = 7600 + Math.floor(Math.random() * 300);
const sh = (cmd: string[], cwd = project) => Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
sh(["git", "init", "-q", "-b", "main"]);
writeFileSync(join(project, "README.md"), "# e2e\n");
sh(["git", "add", "."]);
sh(["git", "-c", "user.email=e2e@me.local", "-c", "user.name=me e2e", "commit", "-q", "-m", "init"]);

const results: { flow: string; ok: boolean; detail: string; ms: number }[] = [];
const check = async (flow: string, fn: () => Promise<string>) => {
  const t = Date.now();
  try {
    results.push({ flow, ok: true, detail: await fn(), ms: Date.now() - t });
  } catch (err: any) {
    results.push({ flow, ok: false, detail: String(err?.message ?? err).slice(0, 200), ms: Date.now() - t });
  }
};

const kernel = new Kernel({
  dataDir: home,
  log: () => {},
  pluginConfig: {
    "gjc-head": { harnesses: ["local.claude-code", "local.codex"], defaultProject: project, simpleThreshold: 0.8 },
    web: { port },
  },
});

// ---- fake brgr: same methods, entity kind and events as plugins/brgr ----
const tasks = new Map<string, any>();
const brgr = definePlugin({
  async onInit() {
    await brgr.entity.registerKind("brgr.task", { type: "object", required: ["taskId", "state", "harness"] });
  },
  methods: {
    "task.delegate": async (p: any) => {
      const taskId = `e2e-${crypto.randomUUID().slice(0, 8)}`;
      const now = new Date().toISOString();
      const task = { taskId, harness: p.harness, objective: p.objective, project: p.project, criterion: p.criterion ?? "", origin: p.origin ?? null, state: "running", outcome: null, resultText: null, error: null, decisionReason: null, commitSha: null, appliedAt: null, createdAt: now, updatedAt: now };
      tasks.set(taskId, task);
      await brgr.entity.upsert("brgr.task", taskId, task);
      await brgr.emit("task.running", { taskId, state: "running", harness: p.harness });
      setTimeout(async () => {
        Object.assign(task, { state: "sealed", outcome: "candidate", resultText: "## 결과\n`NOTES.md`를 만들었어요.", updatedAt: new Date().toISOString() });
        await brgr.entity.upsert("brgr.task", taskId, task);
        await brgr.emit("task.sealed", { taskId, state: "sealed", harness: task.harness });
      }, 300);
      return { taskId };
    },
    "task.diff": (p: any) =>
      p.stat
        ? { diff: " NOTES.md | 1 +\n 1 file changed, 1 insertion(+)\n", error: null }
        : { diff: "diff --git a/NOTES.md b/NOTES.md\nnew file mode 100644\n--- /dev/null\n+++ b/NOTES.md\n@@ -0,0 +1 @@\n+hello\n", error: null },
    "task.accept": async (p: any) => {
      const task = tasks.get(p.taskId);
      if (!task || task.state !== "sealed") throw new Error("not sealed");
      writeFileSync(join(task.project, "NOTES.md"), "hello\n");
      sh(["git", "add", "NOTES.md"], task.project);
      sh(["git", "-c", "user.email=e2e@me.local", "-c", "user.name=me e2e", "commit", "-q", "-m", "Add NOTES.md\n\nApplied from brgr task " + task.taskId + " via me."], task.project);
      const sha = new TextDecoder().decode(sh(["git", "rev-parse", "HEAD"], task.project).stdout).trim();
      Object.assign(task, { state: "applied", commitSha: sha, appliedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await brgr.entity.upsert("brgr.task", task.taskId, task);
      await brgr.emit("task.applied", { taskId: task.taskId, state: "applied", harness: task.harness });
      return task;
    },
    "task.reject": async (p: any) => {
      const task = tasks.get(p.taskId);
      Object.assign(task, { state: "rejected", updatedAt: new Date().toISOString() });
      await brgr.entity.upsert("brgr.task", task.taskId, task);
      await brgr.emit("task.rejected", { taskId: task.taskId, state: "rejected", harness: task.harness });
      return task;
    },
    "task.result": (p: any) => tasks.get(p.taskId) ?? null,
    "task.cancel": () => ({}),
    "harness.list": () => ["local.claude-code", "local.codex"],
  },
});

// ---- web client over the real WebSocket ----
type Msg = any;
let ws: WebSocket | undefined;
const inbox: Msg[] = [];
const waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
const replies = new Map<string, (m: Msg) => void>();
function connect(token: string) {
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, { headers: { Origin: `http://127.0.0.1:${port}` } } as any);
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.type === "reply") return replies.get(m.replyTo)?.(m);
    inbox.push(m);
    for (const w of [...waiters]) if (w.pred(m)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(m));
  };
  return new Promise((r) => (ws!.onopen = r));
}
const request = (type: string, body: object = {}): Promise<any> =>
  new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    replies.set(id, (m) => (m.ok ? resolve(m.result) : reject(new Error(m.error))));
    ws!.send(JSON.stringify({ id, type, ...body }));
  });
const waitFor = (pred: (m: Msg) => boolean, ms = 90_000, what = "event"): Promise<Msg> =>
  new Promise((resolve, reject) => {
    const hit = inbox.find(pred);
    if (hit) return resolve(hit);
    const w = { pred, resolve };
    waiters.push(w);
    setTimeout(() => (waiters.includes(w) && waiters.splice(waiters.indexOf(w), 1), reject(new Error(`timeout waiting for ${what}`))), ms);
  });

try {
  for (const id of ["slang", "summarize", "jev", "gjc-head", "web"]) {
    await kernel.spawn(await loadManifest(join(root, "plugins", id, "plugin.json")));
    if (kernel.pluginState(id) !== "running") throw new Error(`${id} did not start`);
  }
  const [k, p] = createPipePair();
  void brgr.run(p);
  await kernel.attach(
    validateManifest(
      { id: "brgr", version: "e2e", protocol: { min: 1, max: 1 }, run: { command: ["true"] }, permissions: ["read-state", "emit"], provides: { methods: ["task.delegate", "task.diff", "task.accept", "task.reject", "task.result", "task.cancel", "harness.list"], kinds: ["task"] } },
      root,
    ),
    k,
  );
  // The web plugin builds its UI bundle before it listens.
  let boot: any;
  for (let i = 0; i < 100 && !boot; i++) boot = await fetch(`http://127.0.0.1:${port}/api/bootstrap`).then((r) => r.json()).catch(() => Bun.sleep(200).then(() => undefined));
  if (!boot) throw new Error(`web did not listen on ${port}`);
  await connect(boot.token);

  let directTrace = "";
  await check("직접 답변: 단계 표시 → 스트리밍 → 완료", async () => {
    const { traceId } = await request("chat.send", { text: "TCP와 UDP 차이를 세 문장으로 설명해 줄 수 있어? 예시도 하나씩 넣어서" });
    directTrace = traceId;
    const end = await waitFor((m) => m.type === "op.end" && m.traceId === traceId, 90_000, "op.end");
    if (end.error) throw new Error(end.error);
    const ups = inbox.filter((m) => m.type === "op.update" && m.traceId === traceId).map((m) => m.update);
    const phases = ups.filter((u) => u.kind === "phase").map((u) => u.phase);
    const deltas = ups.filter((u) => u.kind === "text_delta").length;
    const route = ups.find((u) => u.kind === "judgement")?.route;
    if (route !== "direct") throw new Error(`route ${route}`);
    for (const ph of ["understanding", "judging", "answering", "done"]) if (!phases.includes(ph)) throw new Error(`missing phase ${ph}`);
    if (deltas < 2) throw new Error(`only ${deltas} text deltas`);
    return `phases=${phases.join("→")} deltas=${deltas}`;
  });

  await check("타임라인: trace.get 트리", async () => {
    const t = await request("trace.get", { traceId: directTrace });
    const root = t.nodes.find((n: any) => n.target === "gjc-head");
    if (!root) throw new Error("no gjc-head node");
    const kids = root.children.map((c: any) => `${c.target}.${c.method}`);
    if (!kids.includes("jev.judge")) throw new Error(`children: ${kids.join(",")}`);
    // Deltas reach subscribers one by one but are journaled merged (#4).
    const live = inbox.filter((m) => m.type === "op.update" && m.traceId === directTrace && m.update.kind === "text_delta");
    const rows = kernel.store.query({ traceId: directTrace, limit: 1000 }).filter((e) => e.type === "op.update" && (e.body as any).update?.kind === "text_delta");
    const text = (xs: string[]) => xs.join("");
    if (text(rows.map((e) => (e.body as any).update.delta)) !== text(live.map((m) => m.update.delta))) throw new Error("journaled text differs from streamed text");
    if (rows.length > live.length) throw new Error(`text_delta rows ${rows.length} for ${live.length} live deltas`);
    return `children=${kids.join(",")} root=${root.durationMs}ms text_delta live=${live.length} journal=${rows.length}`;
  });

  const delegate = async (text: string) => {
    const { traceId } = await request("chat.send", { text });
    const pending = await waitFor((m) => m.type === "approval" && m.event === "kernel.approval.pending" && m.traceId === traceId, 120_000, "approval");
    return { traceId, approval: pending.data };
  };

  await check("위임: 판정 → 지시서 → 승인(하네스 변경) → 결과 → 수락 → 커밋", async () => {
    const { traceId, approval } = await delegate("이 프로젝트에 NOTES.md 파일 만들어서 hello 한 줄만 써 줘");
    if (!approval.payload?.brief) throw new Error("approval has no brief");
    await request("approval.decide", { approvalId: approval.approvalId, decision: "approve", amend: { harness: "local.codex" } });
    const sealed = await waitFor((m) => m.type === "entity" && m.kind === "brgr.task" && m.data.state === "sealed", 30_000, "sealed task");
    if (sealed.data.harness !== "local.codex") throw new Error(`harness ${sealed.data.harness} (amend ignored)`);
    const diff = await request("task.diff", { taskId: sealed.data.taskId });
    if (!String(diff.diff).includes("NOTES.md")) throw new Error("diff missing file");
    const applied = await request("task.accept", { taskId: sealed.data.taskId });
    const log = new TextDecoder().decode(sh(["git", "log", "--oneline", "-1"]).stdout).trim();
    if (applied.state !== "applied" || !log.includes("NOTES.md")) throw new Error(`state=${applied.state} log=${log}`);
    await waitFor((m) => m.type === "op.end" && m.traceId === traceId, 30_000, "op.end");
    return `commit ${String(applied.commitSha).slice(0, 8)}`;
  });

  await check("승인 거절: 위임하지 않음", async () => {
    const { traceId, approval } = await delegate("README에 설치 방법 섹션을 추가하고 커밋해 줘");
    await request("approval.decide", { approvalId: approval.approvalId, decision: "reject" });
    await waitFor((m) => m.type === "op.end" && m.traceId === traceId, 30_000, "op.end");
    const msg = inbox.filter((m) => m.type === "entity" && m.kind === "gjc-head.message" && m.data.traceId === traceId && m.data.role === "assistant").at(-1)?.data;
    if (msg?.delegation?.state !== "rejected") throw new Error(`delegation state ${msg?.delegation?.state}`);
    return "rejected";
  });

  await check("상태: kernel.op 기록", async () => {
    const boot2 = await (await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).json();
    const ops = boot2.ops ?? [];
    const done = ops.filter((o: any) => o.state === "done").length;
    if (done < 3) throw new Error(`done ops ${done}`);
    return `ops=${ops.length} done=${done}`;
  });
  if (process.argv.includes("--serve")) {
    // Leave the seeded me running for scripts/shots.ts and scripts/a11y.ts until SIGTERM.
    // One result waiting for review, for the in-thread result card.
    await delegate("CHANGELOG.md 파일을 만들어서 첫 항목을 적어 줘")
      .then(async ({ approval }) => {
        const from = inbox.length;
        await request("approval.decide", { approvalId: approval.approvalId, decision: "approve" });
        await waitFor((m) => inbox.indexOf(m) >= from && m.type === "entity" && m.kind === "brgr.task" && m.data.state === "sealed", 30_000, "sealed task");
      })
      .catch(() => {});
    await delegate("docs 폴더에 사용법 문서를 만들어 줘").catch(() => {}); // leaves one approval pending for screenshots
    const report = results.map((r) => `${r.ok ? "PASS" : "FAIL"} ${r.flow}`).join("\n");
    console.log(`${report}\nSERVE http://127.0.0.1:${port}/`);
    await new Promise<void>((r) => (process.on("SIGTERM", r), process.on("SIGINT", r)));
  }
} catch (err: any) {
  results.push({ flow: "setup", ok: false, detail: String(err?.message ?? err), ms: 0 });
} finally {
  try {
    ws?.close();
  } catch {}
  await kernel.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}

const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - [...s].reduce((w, c) => w + (/[ㄱ-힝]/.test(c) ? 2 : 1), 0)));
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${pad(r.flow, 52)} ${String(r.ms).padStart(6)}ms  ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} flow(s) failed` : `\nall ${results.length} flows passed`);
process.exit(failed ? 1 : 0);
