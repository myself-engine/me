// Web plugin: localhost-only UI over the kernel. Security floor (DESIGN §7):
// bind 127.0.0.1, check Host and Origin, require a per-start token for every mutation and the socket.
// Remote access goes only through `tailscale serve` (tailnet, never funnel); see access.ts for the rules.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import type { KernelOpEntity } from "@me/protocol";
import { definePlugin } from "@me/sdk";
import { type Access, type AccessConfig, classify, hostnameFromStatus, needsHostnameDetection, originOk, tailnetOrigin, tailscaleConfig, viewerOf } from "./access.ts";
import {
  Coalescer,
  addSub,
  approvalPayload,
  ensureVapid,
  fanout,
  loadSubs,
  opsDownPayload,
  parseSubscription,
  removeSub,
  swResponse,
  swText,
  taskFailedPayload,
  taskResultPayload,
  testPayload,
  webPushTransport,
  type PushKind,
  type PushPayload,
} from "./push.ts";
import { pwaResponse } from "./pwa.ts";
import { stashSecrets } from "./secrets.ts";
import { redactValue } from "@me/redact";
import { DEFAULT_PROJECT_ROOTS, completeProjectPath, discoverProjects } from "./projects.ts";
import index from "../ui/index.html";

const dataDir = process.env.ME_DATA_DIR ?? ".";
mkdirSync(dataDir, { recursive: true });
const token = crypto.randomUUID().replaceAll("-", "");
writeFileSync(join(dataDir, "token"), token, { mode: 0o600 });

const WATCHED_KINDS = new Set(["gjc-head.thread", "gjc-head.message", "gjc-head.settings", "gjc-head.alert", "brgr.task", "kernel.plugin", "kernel.op", "web.settings"]);
const SETTINGS_KIND = "web.settings";
const SETTINGS_ID = "default";
/** ops runs once per machine (ops on this Mac, ops-<name> on servers); each owns `<id>.check`. */
const OPS_KIND = /^(ops(?:-[a-z0-9-]+)?)\.check$/;
const isOpsPlugin = (id: string) => id === "ops" || id.startsWith("ops-");
const withSource = (kind: string, data: any) => ({ ...data, source: kind.match(OPS_KIND)?.[1] ?? "ops" });
const clients = new Set<ServerWebSocket<unknown>>();
/** Burst gate for pushes: at most one per kind per 30s. */
const coalescer = new Coalescer();
/** Last seen ops status per check; the first sighting is the baseline, never a push. */
const opsStatus = new Map<string, string>();

const broadcast = (msg: unknown) => {
  const s = JSON.stringify(msg);
  for (const ws of clients) ws.send(s);
};

const plugin = definePlugin({
  async onInit() {
    await plugin.entity.registerKind(SETTINGS_KIND, { type: "object", required: ["id", "projects"] });
  },
  async onEvent(name, data, ctx) {
    if (name === "kernel.entity.changed" && WATCHED_KINDS.has(data.kind)) {
      const doc = await plugin.entity.get(data.kind, data.id);
      if (doc) broadcast({ type: "entity", kind: doc.kind, id: doc.id, data: doc.data });
      return;
    }
    if (name === "kernel.entity.changed" && OPS_KIND.test(data.kind)) {
      const doc = await plugin.entity.get(data.kind, data.id);
      if (doc) {
        broadcast({ type: "entity", kind: "ops.check", id: `${withSource(doc.kind, doc.data).source}/${doc.id}`, data: withSource(doc.kind, doc.data) });
        void notifyOpsDown(doc.kind, doc.id, doc.data);
      }
      return;
    }
    if (name === "kernel.approval.pending" || name === "kernel.approval.decided") {
      broadcast({ type: "approval", event: name, data, traceId: ctx.traceId });
      if (name === "kernel.approval.pending") void notifyApproval(data);
      return;
    }
    if (name === "brgr.task.sealed" || name === "brgr.task.verified") {
      void notifyTaskResult(String(data?.taskId ?? ""));
      return;
    }
    if (name === "brgr.task.failed") {
      void notifyTaskFailed(String(data?.taskId ?? ""));
      return;
    }
    if (name === "gjc-head.guard.violation" || name === "kernel.plugin.quarantined") {
      broadcast({ type: "notice", event: name, data });
    }
  },
});

void plugin.run();
await new Promise<void>((r) => {
  const t = setInterval(() => {
    if (plugin.info) {
      clearInterval(t);
      r();
    }
  }, 10);
});

const port = Number(plugin.config.port ?? 7420);
const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

async function detectTailnetHostname(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["tailscale", "status", "--json"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), 5000);
    const out = await new Response(proc.stdout).text();
    clearTimeout(timer);
    return (await proc.exited) === 0 ? hostnameFromStatus(out) : null;
  } catch {
    return null;
  }
}

const tailscaleRaw = plugin.config.tailscale;
const access: AccessConfig = {
  port,
  extraHosts: (plugin.config.extraHosts as string[]) ?? [],
  extraOrigins: (plugin.config.extraOrigins as string[]) ?? [],
  tailscale: tailscaleConfig(tailscaleRaw, needsHostnameDetection(tailscaleRaw) ? await detectTailnetHostname() : null),
};
if (access.tailscale.enabled && !access.tailscale.hostname) console.error("[web] tailscale enabled but hostname unknown; tailnet access off");
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** Checks from every ops instance (this Mac and connected servers), tagged with their source. */
async function opsChecks() {
  const instances = (await plugin.entity.list<{ id: string }>({ kind: "kernel.plugin", limit: 200 })).map((d) => d.data.id).filter(isOpsPlugin);
  const lists = await Promise.all(
    instances.map((id) => plugin.entity.list({ kind: `${id}.check`, limit: 500 }).catch(() => [])),
  );
  return lists.flat().map((d) => ({ data: withSource(d.kind, d.data) }));
}

/** The kernel keeps up to 500 ops ordered by id; the UI wants the 200 most recently touched. */
async function recentOps() {
  const docs = await plugin.entity.list<KernelOpEntity>({ kind: "kernel.op", limit: 500 });
  return docs
    .map((d) => d.data)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 200);
}

/** Projects added in 상태 › 프로젝트, stored as the web-owned web.settings entity and merged with config projects. */
async function storedProjects(): Promise<string[]> {
  const doc = await plugin.entity.get<{ id: string; projects: string[] }>(SETTINGS_KIND, SETTINGS_ID).catch(() => null);
  return (doc?.data.projects ?? []).map(expand);
}

async function saveStoredProjects(projects: string[]) {
  await plugin.entity.upsert(SETTINGS_KIND, SETTINGS_ID, { id: SETTINGS_ID, projects });
}
/** Sends one payload to every subscribed device; drops vendor-rejected ones. Never logs endpoints or keys. */
async function sendPush(kind: PushKind, payload: PushPayload) {
  if (!coalescer.allow(kind)) return;
  const subs = loadSubs(dataDir);
  if (subs.length === 0) return;
  try {
    const vapid = ensureVapid(dataDir);
    const { gone, failed } = await fanout(subs, JSON.stringify(payload), vapid, webPushTransport);
    for (const endpoint of gone) removeSub(dataDir, endpoint);
    if (failed > 0) console.error(`[web] push ${kind}: ${failed} send(s) failed`);
  } catch (err) {
    console.error(`[web] push ${kind} failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
  }
}

/** Chat hash for a delegation approval's thread; settings otherwise. */
async function approvalUrl(messageId: unknown): Promise<string> {
  if (typeof messageId === "string" && messageId) {
    const msg = await plugin.entity.get<{ threadId?: string }>("gjc-head.message", messageId).catch(() => null);
    if (typeof msg?.data.threadId === "string" && msg.data.threadId) return `#/chat/${encodeURIComponent(msg.data.threadId)}`;
  }
  return "#/settings/device";
}

async function notifyApproval(data: any) {
  try {
    await sendPush("approval", approvalPayload(data?.summary, await approvalUrl(data?.payload?.messageId)));
  } catch (err) {
    console.error(`[web] push approval failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
  }
}

/** Chat hash for a task's origin thread; settings when the task has none. */
async function taskUrl(taskId: string): Promise<{ objective: unknown; url: string }> {
  const task = await plugin.entity.get<{ objective?: string; origin?: { threadId?: string } }>("brgr.task", taskId).catch(() => null);
  const threadId = task?.data.origin?.threadId;
  return {
    objective: task?.data.objective,
    url: typeof threadId === "string" && threadId ? `#/chat/${encodeURIComponent(threadId)}` : "#/settings/device",
  };
}

async function notifyTaskResult(taskId: string) {
  if (!taskId) return;
  try {
    const { objective, url } = await taskUrl(taskId);
    await sendPush("task-result", taskResultPayload(objective, url));
  } catch (err) {
    console.error(`[web] push task-result failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
  }
}

async function notifyTaskFailed(taskId: string) {
  if (!taskId) return;
  try {
    const { objective, url } = await taskUrl(taskId);
    await sendPush("task-failed", taskFailedPayload(objective, url));
  } catch (err) {
    console.error(`[web] push task-failed failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
  }
}

/** Pushes only when a check turns down; the first sighting sets the baseline. */
async function notifyOpsDown(kind: string, id: string, data: any) {
  try {
    const key = `${kind}/${id}`;
    const prev = opsStatus.get(key);
    opsStatus.set(key, String(data?.status ?? ""));
    if (prev === undefined || prev === "down" || data?.status !== "down") return;
    await sendPush("ops-down", opsDownPayload(data?.name ?? id, data?.detail ?? "", "#/settings/device"));
  } catch (err) {
    console.error(`[web] push ops-down failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
  }
}

/** True when git itself recognises the directory as a repository (worktrees included). */
async function isGitRepo(path: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["git", "-C", path, "rev-parse", "--git-dir"], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), 5000);
    const code = await proc.exited;
    clearTimeout(timer);
    return code === 0;
  } catch {
    return false;
  }
}

/** Expands and validates a repository path from the UI: it must exist, be a directory, and be a git repo. */
async function checkedProject(raw: unknown): Promise<string> {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("저장소 경로를 입력하세요");
  const path = expand(raw.trim());
  if (!existsSync(path)) throw new Error(`없는 경로예요: ${path}`);
  try {
    if (!statSync(path).isDirectory()) throw new Error(`디렉터리가 아니에요: ${path}`);
  } catch (err: any) {
    if (err?.message?.startsWith("디렉터리가")) throw err;
    throw new Error(`읽을 수 없는 경로예요: ${path}`);
  }
  if (!(await isGitRepo(path))) throw new Error(`git 저장소가 아니에요: ${path}`);
  return path;
}

async function bootstrap(req: Access) {
  const [threads, messages, tasks, plugins, ops, checks, approvals, headSettings, alerts, webSettings] = await Promise.all([
    plugin.entity.list({ kind: "gjc-head.thread", limit: 500 }),
    plugin.entity.list({ kind: "gjc-head.message", limit: 1000 }),
    plugin.entity.list({ kind: "brgr.task", limit: 500 }),
    plugin.entity.list({ kind: "kernel.plugin", limit: 100 }),
    recentOps(),
    opsChecks(),
    plugin.approval.list(),
    plugin.entity.get("gjc-head.settings", "default").catch(() => null),
    plugin.entity.list({ kind: "gjc-head.alert", limit: 20 }).catch(() => []),
    plugin.entity.get<{ id: string; projects: string[] }>(SETTINGS_KIND, SETTINGS_ID).catch(() => null),
  ]);
  const addedProjects = ((webSettings?.data.projects as string[]) ?? []).map(expand);
  const projects = [...new Set([...((plugin.config.projects as string[]) ?? []).map(expand), ...addedProjects])];
  return {
    token,
    viewer: viewerOf(req),
    threads: threads.map((d) => d.data),
    messages: messages.map((d) => d.data),
    tasks: tasks.map((d) => d.data),
    plugins: plugins.map((d) => d.data),
    ops,
    checks: checks.map((d) => d.data),
    approvals,
    headSettings: headSettings?.data ?? null,
    alerts: alerts.map((d) => d.data),
    config: {
      projects,
      addedProjects,
      defaultProject: expand((plugin.config.defaultProject as string) ?? ""),
      githubRepo: (plugin.config.githubRepo as string) ?? null,
    },
  };
}

type ClientMsg = { id: string; type: string; [k: string]: any };

async function handle(ws: ServerWebSocket<unknown>, m: ClientMsg): Promise<unknown> {
  switch (m.type) {
    case "chat.send": {
      const traceId = crypto.randomUUID();
      const { opId, done } = await plugin.withTrace(traceId, () =>
        plugin.invokeStream("gjc-head", "chat.send", { threadId: m.threadId, text: m.text, project: m.project, model: m.model, effort: m.effort, access: m.access, confirm: m.confirm }, {
          timeoutMs: 600_000,
          onUpdate: (update) => broadcast({ type: "op.update", opId, update, traceId }),
        }),
      );
      done
        .then((result) => broadcast({ type: "op.end", opId, result, traceId }))
        .catch((err) => broadcast({ type: "op.end", opId, error: String(err?.message ?? err), traceId }));
      return { opId, traceId };
    }
    case "head.models":
      return plugin.invoke("gjc-head", "chat.models", { harness: m.harness }, { timeoutMs: 90_000 });
    case "head.defaults.set":
      return plugin.invoke("gjc-head", "chat.settings.set", { model: m.model, effort: m.effort, access: m.access, confirm: m.confirm, harness: m.harness, fallbackModels: m.fallbackModels });
    case "head.thread.set":
      return plugin.invoke("gjc-head", "chat.thread.set", { threadId: m.threadId, model: m.model, effort: m.effort, access: m.access, confirm: m.confirm });
    case "head.favorites.set":
      return plugin.invoke("gjc-head", "chat.favorites.set", { model: m.model, on: m.on });
    case "approval.decide":
      return plugin.approval.decide(m.approvalId, { decision: m.decision, note: m.note, ...(m.amend ? { amend: m.amend } : {}) });
    case "task.diff":
      return plugin.invoke("brgr", "task.diff", { taskId: m.taskId, stat: !!m.stat });
    case "task.accept":
      return plugin.invoke("brgr", "task.accept", { taskId: m.taskId, reason: m.reason }, { timeoutMs: 120_000 });
    case "task.reject":
      return plugin.invoke("brgr", "task.reject", { taskId: m.taskId, reason: m.reason }, { timeoutMs: 120_000 });
    case "task.revert":
      return plugin.invoke("brgr", "task.revert", { taskId: m.taskId }, { timeoutMs: 120_000 });
    case "ops.action.run": {
      // The target comes from the client, so only ops instances are reachable here; argv is never sent, only ids.
      const source = String(m.source ?? "ops");
      if (!isOpsPlugin(source)) throw new Error(`not an ops instance: ${source}`);
      return plugin.invoke(source, "actions.run", { checkId: m.checkId, actionId: m.actionId });
    }
    case "slang.add":
      return plugin.invoke("slang", "dict.add", { from: m.from, to: m.to });
    case "budget.status":
      return plugin.invoke("budget", "budget.status", {});
    case "harness.plan":
      return plugin.invoke("harness-config", "plan", { ...(m.harnesses ? { harnesses: m.harnesses } : {}), ...(m.force ? { force: true } : {}) });
    case "harness.list":
      return plugin.invoke("harness-config", "list", {});
    case "harness.source.get":
      return plugin.invoke("harness-config", "source.get", {});
    case "harness.source.update":
      // Secret values never travel in call params: the kernel journals them.
      if (m.op === "upsert" && typeof m.name === "string") m.server = stashSecrets(m.name, m.server);
      return plugin.invoke("harness-config", "source.update", {
        op: m.op,
        name: m.name,
        ...(m.share !== undefined ? { share: m.share } : {}),
        ...(m.server !== undefined ? { server: m.server } : {}),
      });
    case "harness.import":
      return plugin.invoke("harness-config", "import", { ...(m.write ? { write: true } : {}) });
    case "harness.draft.adopt":
      return plugin.invoke("harness-config", "draft.adopt", { resolutions: m.resolutions ?? {} });
    case "harness.apply.request":
      return plugin.invoke("harness-config", "apply.request", { ...(m.harnesses ? { harnesses: m.harnesses } : {}), ...(m.force ? { force: true } : {}) });
    case "projects.add": {
      const path = await checkedProject(m.path);
      const next = [...new Set([...(await storedProjects()), path])];
      await saveStoredProjects(next);
      return { path, projects: next };
    }
    case "projects.remove": {
      if (typeof m.path !== "string" || !m.path) throw new Error("path is required");
      const path = expand(m.path);
      await saveStoredProjects((await storedProjects()).filter((p) => p !== path));
      return { removed: path };
    }
    case "projects.discover": {
      const roots = Array.isArray(plugin.config.projectRoots) ? (plugin.config.projectRoots as string[]) : DEFAULT_PROJECT_ROOTS;
      const registered = new Set([...((plugin.config.projects as string[]) ?? []).map(expand), ...(await storedProjects())]);
      return { projects: discoverProjects({ roots, registered }) };
    }
    case "projects.complete": {
      if (typeof m.path !== "string") throw new Error("path is required");
      return { matches: completeProjectPath(m.path) };
    }
    case "trace.get":
      return plugin.getTrace(String(m.traceId ?? ""));
    case "push.publicKey": {
      // Only the public key leaves the server; the private key never does.
      return { publicKey: ensureVapid(dataDir).publicKey };
    }
    case "push.subscribe": {
      const sub = parseSubscription({ endpoint: m.endpoint, keys: m.keys });
      addSub(dataDir, sub);
      return { ok: true };
    }
    case "push.unsubscribe": {
      if (typeof m.endpoint !== "string" || !m.endpoint) throw new Error("endpoint is required");
      return { removed: removeSub(dataDir, m.endpoint) };
    }
    case "push.test": {
      // Manual test from settings: immediate, skips coalescing.
      if (typeof m.endpoint !== "string" || !m.endpoint) throw new Error("endpoint is required");
      const target = loadSubs(dataDir).find((s) => s.endpoint === m.endpoint);
      if (!target) throw new Error("먼저 이 기기에서 알림 받기를 켜 주세요");
      const { gone, failed } = await fanout([target], JSON.stringify(testPayload()), ensureVapid(dataDir), webPushTransport);
      if (gone.length > 0) {
        removeSub(dataDir, m.endpoint);
        throw new Error("구독이 만료됐어요. 다시 켜 주세요");
      }
      if (failed > 0) throw new Error("보내지 못했어요. 잠시 뒤 다시 해보세요");
      return { ok: true };
    }
    case "issue.create":
      return createIssue(m.traceId, m.note, m.messageId);
    default:
      throw new Error(`unknown request: ${m.type}`);
  }
}

async function createIssue(traceId: string | undefined, note: string, messageId?: string) {
  const repo = plugin.config.githubRepo as string | undefined;
  // Entities hold live secrets (token files' contents never, but values in
  // transit can); the journal is already masked at write time. Mask both
  // again here so the GitHub issue never carries one.
  const entries: { seq: number; ts: string; source: string; type: string; body: unknown }[] = traceId
    ? redactValue(await plugin.journal({ traceId, limit: 500 }))
    : [];
  const message = messageId ? redactValue((await plugin.entity.get("gjc-head.message", messageId))?.data) : null;
  const taskId = (message as any)?.taskId;
  const task = taskId ? redactValue((await plugin.entity.get("brgr.task", taskId))?.data) : null;
  const lines = entries
    .filter((e) => e.type !== "op.update" || !String(JSON.stringify(e.body)).includes("_delta"))
    .map((e) => `${e.seq} ${e.ts} ${e.source} ${e.type} ${JSON.stringify(e.body).slice(0, 400)}`);
  const body = [
    note || "(설명 없음)",
    "",
    "## 자동 첨부",
    `- traceId: \`${traceId ?? "-"}\``,
    message ? "\n### 메시지\n```json\n" + JSON.stringify(message, null, 2).slice(0, 8000) + "\n```" : "",
    task ? "\n### 위임 작업\n```json\n" + JSON.stringify(task, null, 2).slice(0, 8000) + "\n```" : "",
    "\n### 저널 (스트림 조각 제외)\n```\n" + lines.join("\n").slice(0, 40000) + "\n```",
  ].join("\n");
  const title = `[me] ${(note || "issue").split("\n")[0]!.slice(0, 70)}`;
  if (!repo) return { dryRun: true, title, body };
  const proc = Bun.spawn(["gh", "issue", "create", "--repo", repo, "--title", title, "--body-file", "-"], {
    stdin: new Blob([body]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text()];
  if ((await proc.exited) !== 0) throw new Error(`gh issue create failed: ${err.trim().slice(0, 300)}`);
  return { url: out.trim() };
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  development: (plugin.config.dev ? { hmr: true } : false) as any,
  routes: { "/": index },
  async fetch(req, srv) {
    const who = classify(req.headers, access);
    if (who.kind === "forbidden") return new Response(who.reason, { status: 403 });
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (!originOk(req.headers, who, access) || url.searchParams.get("token") !== token) return new Response("forbidden", { status: 403 });
      return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/api/bootstrap" && req.method === "GET") return json(await bootstrap(who));
    // The service worker is served verbatim, never bundled or cached.
    const sw = url.pathname === "/sw.js" && req.method === "GET" ? swResponse(url.pathname, await swText()) : null;
    if (sw) return sw;
    const pwa = req.method === "GET" ? pwaResponse(url.pathname) : null;
    if (pwa) return pwa;
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      clients.add(ws);
    },
    close(ws) {
      clients.delete(ws);
    },
    async message(ws, raw) {
      let m: ClientMsg;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      try {
        const result = await handle(ws, m);
        ws.send(JSON.stringify({ type: "reply", replyTo: m.id, ok: true, result: result ?? null }));
      } catch (err: any) {
        ws.send(JSON.stringify({ type: "reply", replyTo: m.id, ok: false, error: String(err?.message ?? err) }));
      }
    },
  },
});

console.error(`[web] http://${server.hostname}:${server.port}`);
const remote = tailnetOrigin(access);
if (remote) console.error(`[web] tailnet ${remote} (logins: ${access.tailscale.allowedLogins.join(", ") || "none"})`);
