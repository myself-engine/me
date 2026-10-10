// Web plugin: localhost-only UI over the kernel. Security floor (DESIGN §7):
// bind 127.0.0.1, check Host and Origin, require a per-start token for every mutation and the socket.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { definePlugin } from "@me/sdk";
import index from "../ui/index.html";

const dataDir = process.env.ME_DATA_DIR ?? ".";
mkdirSync(dataDir, { recursive: true });
const token = crypto.randomUUID().replaceAll("-", "");
writeFileSync(join(dataDir, "token"), token, { mode: 0o600 });

const WATCHED_KINDS = new Set(["gjc-head.thread", "gjc-head.message", "brgr.task", "kernel.plugin"]);
const clients = new Set<ServerWebSocket<unknown>>();

const broadcast = (msg: unknown) => {
  const s = JSON.stringify(msg);
  for (const ws of clients) ws.send(s);
};

const plugin = definePlugin({
  async onEvent(name, data, ctx) {
    if (name === "kernel.entity.changed" && WATCHED_KINDS.has(data.kind)) {
      const doc = await plugin.entity.get(data.kind, data.id);
      if (doc) broadcast({ type: "entity", kind: doc.kind, id: doc.id, data: doc.data });
      return;
    }
    if (name === "kernel.approval.pending" || name === "kernel.approval.decided") {
      broadcast({ type: "approval", event: name, data, traceId: ctx.traceId });
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
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...((plugin.config.extraHosts as string[]) ?? [])]);
const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`).concat((plugin.config.extraOrigins as string[]) ?? []));
const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

function hostOk(req: Request) {
  return allowedHosts.has(req.headers.get("host") ?? "");
}
function originOk(req: Request) {
  const o = req.headers.get("origin");
  return o !== null && allowedOrigins.has(o);
}
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

async function bootstrap() {
  const [threads, messages, tasks, plugins, approvals] = await Promise.all([
    plugin.entity.list({ kind: "gjc-head.thread", limit: 500 }),
    plugin.entity.list({ kind: "gjc-head.message", limit: 1000 }),
    plugin.entity.list({ kind: "brgr.task", limit: 500 }),
    plugin.entity.list({ kind: "kernel.plugin", limit: 100 }),
    plugin.approval.list(),
  ]);
  return {
    token,
    threads: threads.map((d) => d.data),
    messages: messages.map((d) => d.data),
    tasks: tasks.map((d) => d.data),
    plugins: plugins.map((d) => d.data),
    approvals,
    config: {
      projects: ((plugin.config.projects as string[]) ?? []).map(expand),
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
        plugin.invokeStream("gjc-head", "chat.send", { threadId: m.threadId, text: m.text, project: m.project }, {
          timeoutMs: 600_000,
          onUpdate: (update) => broadcast({ type: "op.update", opId, update, traceId }),
        }),
      );
      done
        .then((result) => broadcast({ type: "op.end", opId, result, traceId }))
        .catch((err) => broadcast({ type: "op.end", opId, error: String(err?.message ?? err), traceId }));
      return { opId, traceId };
    }
    case "approval.decide":
      return plugin.approval.decide(m.approvalId, { decision: m.decision, note: m.note });
    case "task.diff":
      return plugin.invoke("brgr", "task.diff", { taskId: m.taskId, stat: !!m.stat });
    case "task.accept":
      return plugin.invoke("brgr", "task.accept", { taskId: m.taskId, reason: m.reason }, { timeoutMs: 120_000 });
    case "task.reject":
      return plugin.invoke("brgr", "task.reject", { taskId: m.taskId, reason: m.reason }, { timeoutMs: 120_000 });
    case "slang.add":
      return plugin.invoke("slang", "dict.add", { from: m.from, to: m.to });
    case "issue.create":
      return createIssue(m.traceId, m.note, m.messageId);
    default:
      throw new Error(`unknown request: ${m.type}`);
  }
}

async function createIssue(traceId: string | undefined, note: string, messageId?: string) {
  const repo = plugin.config.githubRepo as string | undefined;
  const entries = traceId ? await plugin.journal({ traceId, limit: 500 }) : [];
  const message = messageId ? (await plugin.entity.get("gjc-head.message", messageId))?.data : null;
  const taskId = (message as any)?.taskId;
  const task = taskId ? (await plugin.entity.get("brgr.task", taskId))?.data : null;
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
    if (!hostOk(req)) return new Response("forbidden host", { status: 403 });
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (!originOk(req) || url.searchParams.get("token") !== token) return new Response("forbidden", { status: 403 });
      return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/api/bootstrap" && req.method === "GET") return json(await bootstrap());
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
