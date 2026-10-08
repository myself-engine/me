// The head: judges each message and either answers briefly itself or delegates through brgr.
// It never touches code: GJC runs with no tools and --no-mcp, and any tool execution aborts the run.
import { join } from "node:path";
import { definePlugin, type CallContext } from "@myself/sdk";
import { GjcError, runGjc, type GjcUpdate } from "@myself/gjc";

interface Thread {
  id: string;
  title: string;
  project: string;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

type DelegationState = "awaiting-approval" | "rejected" | "delegated" | "running" | "sealed" | "accepted" | "failed";

interface Message {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  text: string;
  ts: string;
  traceId: string;
  understood?: { normalized: string; replaced: { from: string; to: string }[] };
  summary?: { summaryEn: string; brief: string; needsCodeChange: boolean; scope: string; harness: string; harnessReason: string };
  judgement?: { simpleProb: number; confidence: number; source: string; model: string };
  route?: "direct" | "delegate";
  /** Top-level so entity.list can find the message by task. */
  taskId?: string | null;
  delegation?: { state: DelegationState; harness: string; brief: string; approvalId?: string; note?: string };
  error?: string;
  status: "pending" | "streaming" | "done" | "error";
}

const THREAD = "gjc-head.thread";
const MESSAGE = "gjc-head.message";
const dataDir = process.env.MYSELF_DATA_DIR ?? ".";
const now = () => new Date().toISOString();

const SYSTEM = [
  "You are the head of myself-engine, the user's personal orchestrator for coding agents.",
  "You only talk. You never read, run, or change files; real work is delegated to worker harnesses through brgr.",
  "Reply in natural Korean, short and direct, like a messenger chat. Use markdown when it helps.",
].join(" ");

const plugin = definePlugin({
  async onInit() {
    await plugin.entity.registerKind(THREAD, { type: "object", required: ["id", "title", "project"] });
    await plugin.entity.registerKind(MESSAGE, {
      type: "object",
      required: ["id", "threadId", "role", "text", "status"],
      properties: { role: { enum: ["user", "assistant"] }, status: { enum: ["pending", "streaming", "done", "error"] } },
    });
  },
  methods: {
    "chat.send": (p: { threadId?: string; text: string; project?: string }, ctx) => handleSend(p, ctx),
  },
  async onEvent(name, data) {
    if (!name.startsWith("brgr.task.") || !data?.taskId) return;
    const docs = await plugin.entity.list<Message>({ kind: MESSAGE, where: { taskId: data.taskId }, limit: 5 });
    for (const doc of docs) {
      const m = doc.data;
      if (!m.delegation) continue;
      m.delegation.state = (data.state as DelegationState) ?? m.delegation.state;
      await saveMessage(m);
    }
  },
});

async function saveMessage(m: Message) {
  await plugin.entity.upsert(MESSAGE, m.id, m);
  await plugin.emit("message.changed", { id: m.id, threadId: m.threadId });
}

async function ensureThread(p: { threadId?: string; text: string; project?: string }): Promise<Thread> {
  if (p.threadId) {
    const doc = await plugin.entity.get<Thread>(THREAD, p.threadId);
    if (doc) return doc.data;
  }
  const t: Thread = {
    id: p.threadId ?? crypto.randomUUID(),
    title: p.text.slice(0, 40),
    project: p.project ?? (plugin.config.defaultProject as string) ?? "",
    sessionId: null,
    createdAt: now(),
    updatedAt: now(),
  };
  await plugin.entity.upsert(THREAD, t.id, t);
  return t;
}

async function handleSend(p: { threadId?: string; text: string; project?: string }, ctx: CallContext) {
  if (!p.text?.trim()) throw new Error("text is required");
  const model = (plugin.config.model as string) ?? "openai-codex/gpt-5.6-luna";
  const harnesses = (plugin.config.harnesses as string[]) ?? ["local.claude-code", "local.codex", "local.gjc"];
  const threshold = (plugin.config.simpleThreshold as number) ?? 0.8;

  const thread = await ensureThread(p);
  if (p.project && p.project !== thread.project) thread.project = p.project;
  ctx.update({ kind: "thread", threadId: thread.id, project: thread.project });

  const user: Message = { id: crypto.randomUUID(), threadId: thread.id, role: "user", text: p.text, ts: now(), traceId: ctx.traceId, status: "done" };
  await saveMessage(user);
  const reply: Message = { id: crypto.randomUUID(), threadId: thread.id, role: "assistant", text: "", ts: now(), traceId: ctx.traceId, status: "pending" };
  await saveMessage(reply);
  ctx.update({ kind: "message", userMessageId: user.id, messageId: reply.id });

  try {
    // 1. slang → 2. summary → 3. judgement
    reply.understood = await plugin.invoke("slang", "normalize", { text: p.text });
    ctx.update({ kind: "understood", ...reply.understood });

    reply.summary = await plugin.invoke("summarize", "summarize", {
      original: p.text,
      normalized: reply.understood!.normalized,
      harnesses,
      project: thread.project,
    }, { timeoutMs: 120_000 });
    ctx.update({ kind: "summary", ...reply.summary });

    reply.judgement = await plugin.invoke("jev", "judge", {
      summaryEn: reply.summary!.summaryEn,
      needsCodeChange: reply.summary!.needsCodeChange,
      scope: reply.summary!.scope,
    }, { timeoutMs: 120_000 });
    // Uncertain means delegate; anything that needs files is never handled by the head.
    reply.route = !reply.summary!.needsCodeChange && reply.judgement!.simpleProb >= threshold ? "direct" : "delegate";
    ctx.update({ kind: "judgement", ...reply.judgement, route: reply.route, threshold });
    await saveMessage(reply);

    if (reply.route === "direct") await answerDirectly(thread, reply, p.text, model, ctx);
    else await delegate(thread, reply, ctx);

    reply.status = "done";
  } catch (err: any) {
    reply.status = "error";
    reply.error = err instanceof GjcError ? err.message : String(err?.message ?? err);
    ctx.update({ kind: "error", message: reply.error });
  }
  thread.updatedAt = now();
  await plugin.entity.upsert(THREAD, thread.id, thread);
  await saveMessage(reply);
  return { threadId: thread.id, messageId: reply.id, route: reply.route ?? null, status: reply.status };
}

async function answerDirectly(thread: Thread, reply: Message, text: string, model: string, ctx: CallContext) {
  reply.status = "streaming";
  await saveMessage(reply);
  const res = await runGjc({
    prompt: text,
    model,
    cwd: join(dataDir, "sessions"),
    resume: thread.sessionId ?? undefined,
    systemPrompt: SYSTEM,
    signal: ctx.signal,
    onUpdate: (u: GjcUpdate) => {
      if (u.kind === "text_delta") reply.text += u.delta;
      ctx.update(u);
    },
  });
  if (res.violation) {
    await plugin.emit("guard.violation", { messageId: reply.id, toolName: res.violation.toolName });
    throw new Error(`head tried to use tool ${res.violation.toolName}; run aborted`);
  }
  reply.text = res.text || reply.text;
  if (res.sessionId) thread.sessionId = res.sessionId;
}

async function delegate(thread: Thread, reply: Message, ctx: CallContext) {
  const s = reply.summary!;
  const brief = s.brief || s.summaryEn;
  reply.delegation = { state: "awaiting-approval", harness: s.harness, brief };
  await saveMessage(reply);

  const decisionPromise = plugin.approval.request({
    summary: `${s.harness}에 위임: ${s.summaryEn}`,
    risk: s.needsCodeChange ? "medium" : "low",
    payload: { harness: s.harness, brief, project: thread.project, messageId: reply.id },
    expiresInSec: (plugin.config.approvalExpiresSec as number) ?? 1800,
  });
  ctx.update({ kind: "delegation", state: "awaiting-approval", harness: s.harness, brief });
  const decision = await decisionPromise;
  reply.delegation.approvalId = decision.approvalId;

  if (decision.decision !== "approve") {
    reply.delegation.state = "rejected";
    reply.delegation.note = decision.note;
    reply.text = decision.note === "expired" ? "승인 대기 시간이 지나서 위임하지 않았어요." : "위임하지 않았어요.";
    ctx.update({ kind: "delegation", state: "rejected", note: decision.note ?? null });
    return;
  }

  const task = await plugin.invoke<{ taskId: string }>("brgr", "task.delegate", {
    harness: s.harness,
    objective: brief,
    project: thread.project,
    origin: { plugin: "gjc-head", messageId: reply.id, threadId: thread.id },
  }, { timeoutMs: 120_000 });
  reply.taskId = task.taskId;
  reply.delegation.state = "delegated";
  reply.text = `${s.harness}에 맡겼어요. 결과가 나오면 여기서 확인할 수 있어요.`;
  ctx.update({ kind: "delegation", state: "delegated", taskId: task.taskId, harness: s.harness });
}

await plugin.run();
