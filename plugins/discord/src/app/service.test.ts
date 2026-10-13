import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DUPLICATE_LABEL, Ledger, originKey, type Origin } from "@me/messenger";
import { sqliteCards } from "../adapters/sqlite-cards.ts";
import { parseConfig } from "../domain/config.ts";
import { ids } from "../domain/ids.ts";
import type { DiscordMessage } from "../domain/inbound.ts";
import { REACTIONS } from "../domain/progress.ts";
import type { Row, Select } from "../domain/render.ts";
import { fenceCount, DISCORD_LIMIT } from "../domain/split.ts";
import type { ChatResult, ComponentPress, ComponentReply, Conversation, DiscordGateway, HeadMessage, Kernel, PendingApproval, Task } from "../ports/index.ts";
import { createDiscordApp, type DiscordApp } from "./service.ts";

const OWNER = "100";
const BOT = "999";
const ownerDm: Origin = { platform: "discord", kind: "dm", conversationId: OWNER };

class FakeGateway implements DiscordGateway {
  botUserId = BOT;
  sent: { origin: Origin; text: string; replyTo: string | null; rows: Row[]; id: string }[] = [];
  edits: { origin: Origin; messageId: string; text: string; rows: Row[] }[] = [];
  reactions: { messageId: string; emoji: string }[] = [];
  typings = 0;
  /** When set, send throws this (a plain Error = outcome unknown). */
  failWith: Error | null = null;
  private n = 0;
  private messageHandler!: (m: DiscordMessage) => void;
  private componentHandler!: (p: ComponentPress) => Promise<ComponentReply>;

  onMessage(h: (m: DiscordMessage) => void) {
    this.messageHandler = h;
  }
  onComponent(h: (p: ComponentPress) => Promise<ComponentReply>) {
    this.componentHandler = h;
  }
  async send(origin: Origin, msg: { text: string; replyTo?: string | null; rows?: Row[] }) {
    if (this.failWith) throw this.failWith;
    const id = `p${++this.n}`;
    this.sent.push({ origin, text: msg.text, replyTo: msg.replyTo ?? null, rows: msg.rows ?? [], id });
    return id;
  }
  async edit(origin: Origin, messageId: string, msg: { text: string; rows: Row[] }) {
    this.edits.push({ origin, messageId, ...msg });
  }
  async react(_o: Origin, messageId: string, emoji: string) {
    this.reactions.push({ messageId, emoji });
  }
  async typing() {
    this.typings++;
  }

  receive(m: Partial<DiscordMessage>) {
    this.messageHandler({ place: "dm", channelId: "dmchan", authorId: OWNER, messageId: "m1", content: "hi", mentionsBot: false, repliesToBot: false, ...m });
  }
  press(customId: string, userId = OWNER, values: string[] = []) {
    return this.componentHandler({ customId, userId, values });
  }
  emojis(messageId: string) {
    return this.reactions.filter((r) => r.messageId === messageId).map((r) => r.emoji);
  }
}

type Respond = (p: { threadId: string; text: string }, onUpdate: (u: any) => void) => Promise<{ text: string; route?: string; status?: string; error?: string }>;

class FakeKernel implements Kernel {
  chats: { threadId: string; text: string }[] = [];
  log: string[] = [];
  messages = new Map<string, HeadMessage>();
  conversations = new Map<string, Conversation>();
  tasks = new Map<string, Task>();
  approvals: PendingApproval[] = [];
  decisions: { approvalId: string; decision: string; amend?: Record<string, unknown> }[] = [];
  accepted: string[] = [];
  rejected: string[] = [];
  answers: { taskId: string; text?: string; choice?: string; questionId: string }[] = [];
  respond: Respond = async (p, onUpdate) => {
    onUpdate({ kind: "understood", normalized: p.text, replaced: [] });
    onUpdate({ kind: "judgement", route: "direct" });
    onUpdate({ kind: "text_delta", delta: `answer to: ${p.text}` });
    return { text: `answer to: ${p.text}` };
  };

  async registerKinds() {}
  async chatSend(p: { threadId: string; text: string }, onUpdate: (u: any) => void): Promise<ChatResult> {
    this.chats.push(p);
    this.log.push(`start:${p.text}`);
    onUpdate({ kind: "thread", threadId: p.threadId, project: "/p" });
    const messageId = crypto.randomUUID();
    onUpdate({ kind: "message", userMessageId: crypto.randomUUID(), messageId });
    const r = await this.respond(p, onUpdate);
    const status = r.status ?? "done";
    this.messages.set(messageId, { id: messageId, threadId: p.threadId, text: r.text, status, ...(r.error ? { error: r.error } : {}) });
    this.log.push(`end:${p.text}`);
    return { threadId: p.threadId, messageId, route: r.route ?? "direct", status };
  }
  async headMessage(id: string) {
    return this.messages.get(id) ?? null;
  }
  async listApprovals() {
    return this.approvals;
  }
  async decideApproval(approvalId: string, d: { decision: "approve" | "reject"; amend?: Record<string, unknown> }) {
    this.decisions.push({ approvalId, decision: d.decision, ...(d.amend ? { amend: d.amend } : {}) });
  }
  async task(taskId: string) {
    return this.tasks.get(taskId) ?? null;
  }
  async sealedTasks() {
    return [...this.tasks.values()].filter((t) => t.state === "sealed");
  }
  async awaitingTasks() {
    return [...this.tasks.values()].filter((t) => t.state === "awaiting-input");
  }
  async answerTask(taskId: string, answer: { text?: string; choice?: string; questionId: string }) {
    this.answers.push({ taskId, ...answer });
  }
  async acceptTask(taskId: string) {
    this.accepted.push(taskId);
  }
  async rejectTask(taskId: string) {
    this.rejected.push(taskId);
  }
  async taskDiff() {
    return { diff: "diff --git a/x b/x\n+hello\n", error: null };
  }
  async saveConversation(c: Conversation) {
    this.conversations.set(c.threadId, c);
  }
  async conversation(threadId: string) {
    return this.conversations.get(threadId) ?? null;
  }
}

let dir: string;
let ledger: Ledger;
let gateway: FakeGateway;
let kernel: FakeKernel;
let app: DiscordApp;

function makeApp(raw: Record<string, unknown> = {}) {
  const config = parseConfig({ tokenFile: "/unused", ownerId: OWNER, drainIntervalMs: 60_000, ...raw });
  return createDiscordApp({ gateway, kernel, ledger, cards: sqliteCards(ledger.db), config, log: () => {} });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "me-discord-"));
  ledger = new Ledger(join(dir, "ledger.sqlite"));
  gateway = new FakeGateway();
  kernel = new FakeKernel();
  app = makeApp();
});
afterEach(() => {
  app.stop();
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

const deliveries = () => ledger.db.prepare("SELECT * FROM deliveries ORDER BY rowid").all() as any[];

test("an admitted DM goes to chat.send on its own thread and the reply goes through the ledger", async () => {
  gateway.receive({ messageId: "m1", content: "안녕" });
  await app.idle();

  expect(kernel.chats).toHaveLength(1);
  const { threadId } = kernel.chats[0]!;
  expect(kernel.conversations.get(threadId)).toMatchObject({ originKey: originKey(ownerDm), epoch: 0 });
  expect(ledger.conversation(ownerDm).sessionId).toBe(threadId);

  expect(gateway.sent).toEqual([{ origin: ownerDm, text: "answer to: 안녕", replyTo: "m1", rows: [], id: "p1" }]);
  const [d] = deliveries();
  expect(d).toMatchObject({ state: "sent", platform_message_id: "p1", reply_to: "m1", origin: "discord/dm/100" });

  expect(gateway.emojis("m1")).toEqual([REACTIONS.received, REACTIONS.judging, REACTIONS.answering, REACTIONS.done]);
  expect(gateway.typings).toBeGreaterThan(0);

  // The next message continues the same head thread.
  gateway.receive({ messageId: "m2", content: "또" });
  await app.idle();
  expect(kernel.chats[1]!.threadId).toBe(threadId);
});

test("group messages need a mention; strangers are refused in DMs", async () => {
  gateway.receive({ place: "guild", channelId: "c1", messageId: "g1", content: "hello all" });
  gateway.receive({ place: "dm", authorId: "555", messageId: "s1", content: "let me in" });
  await app.idle();
  expect(kernel.chats).toHaveLength(0);
  expect(gateway.reactions).toHaveLength(0);

  gateway.receive({ place: "guild", channelId: "c1", messageId: "g2", content: `<@${BOT}> 요약해줘`, mentionsBot: true });
  await app.idle();
  expect(kernel.chats.map((c) => c.text)).toEqual(["요약해줘"]);
  expect(gateway.sent[0]!.origin).toEqual({ platform: "discord", kind: "group", conversationId: "c1" });
});

test("open groups need no mention", async () => {
  app.stop();
  app = makeApp({ openGroups: ["c7"] });
  gateway.receive({ place: "guild", channelId: "c7", messageId: "o1", content: "그냥 말" });
  await app.idle();
  expect(kernel.chats).toHaveLength(1);
});

test("a redelivered message is handled once", async () => {
  gateway.receive({ messageId: "m1", content: "once" });
  gateway.receive({ messageId: "m1", content: "once" });
  await app.idle();
  expect(kernel.chats).toHaveLength(1);
  expect(gateway.sent).toHaveLength(1);
});

test("two quick messages in one conversation are processed and answered in order", async () => {
  kernel.respond = async (p) => {
    await Bun.sleep(p.text === "first" ? 40 : 1);
    return { text: `re ${p.text}` };
  };
  gateway.receive({ messageId: "m1", content: "first" });
  gateway.receive({ messageId: "m2", content: "second" });
  await app.idle();
  expect(kernel.log).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  expect(gateway.sent.map((s) => s.text)).toEqual(["re first", "re second"]);
});

test("a long reply is split into ledgered chunks with balanced code fences", async () => {
  const code = Array.from({ length: 150 }, (_, i) => `print(${i})  # ${"z".repeat(20)}`).join("\n");
  kernel.respond = async () => ({ text: `설명\n\`\`\`py\n${code}\n\`\`\`\n끝` });
  gateway.receive({ messageId: "m1", content: "코드 줘" });
  await app.idle();

  expect(gateway.sent.length).toBeGreaterThan(1);
  for (const s of gateway.sent) {
    expect(s.text.length).toBeLessThanOrEqual(DISCORD_LIMIT - DUPLICATE_LABEL.length - 2);
    expect(fenceCount(s.text) % 2).toBe(0);
  }
  expect(gateway.sent.map((s) => s.replyTo)).toEqual(["m1", ...gateway.sent.slice(1).map(() => null)]);
  expect(deliveries().every((d) => d.state === "sent")).toBe(true);
});

test("a head error is reported with the warning reaction", async () => {
  kernel.respond = async () => ({ text: "", status: "error", error: "jev down" });
  gateway.receive({ messageId: "m1", content: "뭔가 해줘" });
  await app.idle();
  expect(gateway.emojis("m1")).toContain(REACTIONS.error);
  expect(gateway.sent[0]!.text).toContain("jev down");
});

async function delegatedMessage() {
  // A Discord conversation whose head thread produced the message the approval points at.
  let messageId = "";
  kernel.respond = async (_p, onUpdate) => {
    onUpdate({ kind: "delegation", state: "delegated", taskId: "t1", harness: "local.codex" });
    return { text: "local.codex에 맡겼어요.", route: "delegate" };
  };
  gateway.receive({ messageId: "m1", content: "버그 고쳐줘" });
  await app.idle();
  for (const m of kernel.messages.values()) messageId = m.id;
  return { messageId, threadId: kernel.chats[0]!.threadId };
}

test("approval cards go to the originating conversation; only the owner decides, with amend.harness", async () => {
  const { messageId } = await delegatedMessage();
  expect(gateway.emojis("m1")).toContain(REACTIONS.delegated);
  const approvalId = crypto.randomUUID();
  app.onKernelEvent("kernel.approval.pending", {
    approvalId,
    requester: "gjc-head",
    summary: "local.claude-code에 위임: fix bug",
    risk: "medium",
    payload: { harness: "local.claude-code", harnesses: ["local.claude-code", "local.codex", "local.gjc"], brief: "Fix the bug", messageId },
  });
  // A repeated event (or the startup backlog) does not post a second card.
  app.onKernelEvent("kernel.approval.pending", { approvalId, payload: { messageId } });
  await app.idle();

  const cards = gateway.sent.filter((s) => s.rows.length);
  expect(cards).toHaveLength(1);
  const card = cards[0]!;
  expect(card.origin).toEqual(ownerDm);
  expect(card.text).toContain("승인 요청");
  expect(card.rows[0]!.map((c) => c.id)).toEqual([ids.approve(approvalId), ids.reject(approvalId)]);
  const select = card.rows[1]![0] as Select;
  expect(select.options.map((o) => o.value)).toEqual(["local.claude-code", "local.codex", "local.gjc"]);

  // Someone else: ephemeral refusal, nothing decided or changed.
  expect((await gateway.press(ids.approve(approvalId), "555")).text).toContain("주인만");
  expect((await gateway.press(ids.harness(approvalId), "555", ["local.gjc"])).text).toContain("주인만");
  expect(kernel.decisions).toHaveLength(0);

  // Owner picks another harness, then approves: the decision carries amend.harness.
  expect((await gateway.press(ids.harness(approvalId), OWNER, ["local.codex"])).text).toContain("local.codex");
  await gateway.press(ids.approve(approvalId));
  expect(kernel.decisions).toEqual([{ approvalId, decision: "approve", amend: { harness: "local.codex" } }]);

  app.onKernelEvent("kernel.approval.decided", { approvalId, decision: "approve", amend: { harness: "local.codex" } });
  await app.idle();
  const closed = gateway.edits.at(-1)!;
  expect(closed).toMatchObject({ messageId: card.id, rows: [] });
  expect(closed.text).toContain("승인함");
});

test("approving without changing the harness sends no amend; reject is plain", async () => {
  const { messageId } = await delegatedMessage();
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();
  for (const approvalId of [a, b]) {
    app.onKernelEvent("kernel.approval.pending", { approvalId, summary: "s", risk: "low", payload: { harness: "local.gjc", harnesses: ["local.gjc", "local.codex"], messageId } });
  }
  await app.idle();
  await gateway.press(ids.harness(a), OWNER, ["local.gjc"]);
  await gateway.press(ids.approve(a));
  await gateway.press(ids.reject(b));
  expect(kernel.decisions).toEqual([
    { approvalId: a, decision: "approve" },
    { approvalId: b, decision: "reject" },
  ]);
});

test("approvals from other windows go to the owner's DM only when approvalsToOwnerDm is set", async () => {
  const pending = { approvalId: crypto.randomUUID(), summary: "web에서 온 요청", risk: "low", payload: { harness: "local.gjc", messageId: "unknown" } };
  app.onKernelEvent("kernel.approval.pending", pending);
  await app.idle();
  expect(gateway.sent).toHaveLength(0);

  app.stop();
  app = makeApp({ approvalsToOwnerDm: true });
  kernel.approvals = [pending];
  await app.start();
  expect(gateway.sent).toHaveLength(1);
  expect(gateway.sent[0]!.origin).toEqual(ownerDm);
});

test("a sealed task tied to a Discord conversation posts its result with accept/reject/diff for the owner", async () => {
  const { threadId } = await delegatedMessage();
  const taskId = crypto.randomUUID();
  kernel.tasks.set(taskId, { taskId, harness: "local.codex", state: "sealed", resultText: "고쳤어요\n" + "r".repeat(3000), origin: { plugin: "gjc-head", threadId, messageId: "x" } });
  kernel.tasks.set("other", { taskId: "other", harness: "local.codex", state: "sealed", resultText: "web", origin: { plugin: "gjc-head", threadId: "web-thread" } });
  app.onKernelEvent("brgr.task.sealed", { taskId, state: "sealed", harness: "local.codex" });
  app.onKernelEvent("brgr.task.sealed", { taskId: "other", state: "sealed", harness: "local.codex" });
  await app.idle();

  const cards = gateway.sent.filter((s) => s.rows.length);
  expect(cards).toHaveLength(1);
  const card = cards[0]!;
  expect(card.origin).toEqual(ownerDm);
  expect(card.text.length).toBeLessThan(DISCORD_LIMIT);
  expect(card.text).toContain("고쳤어요");
  expect(card.rows[0]!.map((c) => c.id)).toEqual([ids.task(taskId, "accept"), ids.task(taskId, "reject"), ids.task(taskId, "diff")]);

  expect((await gateway.press(ids.task(taskId, "accept"), "555")).text).toContain("주인만");
  expect(kernel.accepted).toHaveLength(0);

  const diff = await gateway.press(ids.task(taskId, "diff"));
  expect(diff.file).toEqual({ name: `${taskId.slice(0, 8)}.diff`, content: "diff --git a/x b/x\n+hello\n" });

  await gateway.press(ids.task(taskId, "accept"));
  expect(kernel.accepted).toEqual([taskId]);

  app.onKernelEvent("brgr.task.applied", { taskId, state: "applied" });
  await app.idle();
  expect(gateway.edits.at(-1)).toMatchObject({ messageId: card.id, rows: [] });
});

test("posts an awaiting question and routes an admitted Discord thread reply to brgr", async () => {
  const { threadId } = await delegatedMessage();
  const taskId = "waiting-question";
  kernel.tasks.set(taskId, { taskId, harness: "local.codex", state: "awaiting-input", resultText: null, origin: { threadId }, question: { id: "q1", text: "계속할까요?", at: "2026-10-13T00:00:00Z", kind: "message" } });
  app.onKernelEvent("brgr.task.awaiting-input", { taskId, state: "awaiting-input" });
  await app.idle();
  expect(gateway.sent.at(-1)?.text).toContain("질문이 왔어요");
  gateway.receive({ place: "dm", messageId: "answer-1", content: "네", repliesToBot: true });
  await app.idle();
  expect(kernel.answers).toEqual([{ taskId, text: "네", questionId: "q1" }]);
  expect(kernel.chats.at(-1)?.text).not.toBe("네");
});

test("routes a numbered Discord menu reply as native input choice", async () => {
  const { threadId } = await delegatedMessage();
  const taskId = "waiting-menu";
  kernel.tasks.set(taskId, { taskId, harness: "local.codex", state: "awaiting-input", resultText: null, origin: { threadId }, question: { id: "q-menu", text: "어느 쪽인가요?", at: "2026-10-13T00:00:00Z", kind: "menu", options: ["첫째", "둘째"] } });
  gateway.receive({ place: "dm", messageId: "answer-menu", content: "2", repliesToBot: true });
  await app.idle();
  expect(kernel.answers).toEqual([{ taskId, choice: "2", questionId: "q-menu" }]);
});

test("crash recovery reissues an uncertain reply with the duplicate label", async () => {
  gateway.failWith = new Error("socket hang up");
  gateway.receive({ messageId: "m1", content: "답해줘" });
  await app.idle();
  expect(gateway.sent).toHaveLength(0);
  expect(deliveries()[0]!.state).toBe("sending");

  // Restart: a new process opens the same ledger file.
  app.stop();
  ledger.close();
  ledger = new Ledger(join(dir, "ledger.sqlite"));
  gateway = new FakeGateway();
  app = makeApp();
  await app.start();

  expect(gateway.sent).toHaveLength(1);
  expect(gateway.sent[0]!.text).toBe(`answer to: 답해줘\n\n${DUPLICATE_LABEL}`);
  expect(gateway.sent[0]!.replyTo).toBe("m1");
  const rows = deliveries();
  expect(rows.map((d) => d.state)).toEqual(["failed", "sent"]);
  expect(rows[1]!.duplicate_of).toBe(rows[0]!.id);
});

test("a definite refusal is not reissued as a duplicate", async () => {
  const { SendRejected } = await import("@me/messenger");
  gateway.failWith = new SendRejected("403 Missing Access", false);
  gateway.receive({ messageId: "m1", content: "x" });
  await app.idle();
  expect(deliveries()[0]!.state).toBe("failed");
  expect(ledger.recoverUncertain()).toHaveLength(0);
});

test("/new starts a new epoch and a new head thread for that conversation only", async () => {
  gateway.receive({ messageId: "m1", content: "first" });
  gateway.receive({ place: "guild", channelId: "c1", messageId: "g1", content: `<@${BOT}> team`, mentionsBot: true });
  await app.idle();
  const oldThread = kernel.chats[0]!.threadId;
  const teamThread = kernel.chats[1]!.threadId;

  gateway.receive({ messageId: "m2", content: "/new" });
  await app.idle();
  expect(ledger.conversation(ownerDm).epoch).toBe(1);
  expect(gateway.sent.at(-1)!.text).toBe("새 대화를 시작했어요.");
  const newThread = ledger.conversation(ownerDm).sessionId!;
  expect(newThread).not.toBe(oldThread);
  expect(kernel.conversations.get(newThread)).toMatchObject({ originKey: "discord/dm/100", epoch: 1 });
  // The old thread still maps back, so its late approvals and tasks find the conversation.
  expect(kernel.conversations.get(oldThread)).toMatchObject({ epoch: 0 });

  gateway.receive({ messageId: "m3", content: "second" });
  gateway.receive({ place: "guild", channelId: "c1", messageId: "g2", content: `<@${BOT}> again`, mentionsBot: true });
  await app.idle();
  expect(kernel.chats.find((c) => c.text === "second")!.threadId).toBe(newThread);
  expect(kernel.chats.find((c) => c.text === "again")!.threadId).toBe(teamThread);
});

test("notify posts to the default channel through the ledger", async () => {
  const napp = makeApp({ notifyChannel: "123" });
  const r = await napp.notify("⏱ 아침 브리핑\nhello");
  expect(r).toEqual({ channel: "123" });
  expect(gateway.sent).toHaveLength(1);
  expect(gateway.sent[0]).toMatchObject({ origin: { platform: "discord", kind: "group", conversationId: "123" }, text: "⏱ 아침 브리핑\nhello" });
  napp.stop();
});

test("notify without a channel or text refuses", async () => {
  await expect(app.notify("hi")).rejects.toThrow("notifyChannel");
  const napp = makeApp({ notifyChannel: "123" });
  await expect(napp.notify("  ")).rejects.toThrow("text");
  napp.stop();
  expect(() => parseConfig({ tokenFile: "/unused", ownerId: OWNER, notifyChannel: "nope" })).toThrow();
});
