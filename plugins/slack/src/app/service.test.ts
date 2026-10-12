import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DUPLICATE_LABEL, Ledger, SendRejected, originKey, type Origin } from "@me/messenger";
import { sqliteCards } from "../adapters/sqlite-cards.ts";
import { parseConfig } from "../domain/config.ts";
import { ids } from "../domain/ids.ts";
import type { SlackMessage } from "../domain/inbound.ts";
import { REACTIONS } from "../domain/progress.ts";
import type { Row, Select } from "../domain/render.ts";
import { SLACK_LIMIT, fenceCount } from "../domain/split.ts";
import type { ChatResult, ComponentPress, ComponentReply, Conversation, HeadMessage, Kernel, OutboundMessage, PendingApproval, SlackGateway, Task } from "../ports/index.ts";
import { STREAMING, createSlackApp, type SlackApp } from "./service.ts";

const OWNER = "UOWNER";
const BOT = "UBOT";
const ownerDm: Origin = { platform: "slack", kind: "dm", conversationId: OWNER };
const thread = (channel: string, ts: string): Origin => ({ platform: "slack", kind: "thread", conversationId: `${channel}:${ts}` });

class FakeGateway implements SlackGateway {
  botUserId = BOT;
  sent: { origin: Origin; text: string; replyTo: string | null; rows: Row[] | undefined; id: string }[] = [];
  edits: { origin: Origin; messageId: string; text: string; rows: Row[] | undefined }[] = [];
  reactions: { messageId: string; emoji: string }[] = [];
  /** When set, send throws this (a plain Error = outcome unknown). */
  failWith: Error | null = null;
  /** When set, edit throws this. */
  editFailWith: Error | null = null;
  private n = 0;
  private messageHandler!: (m: SlackMessage) => void;
  private componentHandler!: (p: ComponentPress) => Promise<ComponentReply>;

  onMessage(h: (m: SlackMessage) => void) {
    this.messageHandler = h;
  }
  onComponent(h: (p: ComponentPress) => Promise<ComponentReply>) {
    this.componentHandler = h;
  }
  async send(origin: Origin, msg: OutboundMessage) {
    if (this.failWith) throw this.failWith;
    const id = `1800.${String(++this.n).padStart(4, "0")}`;
    this.sent.push({ origin, text: msg.text, replyTo: msg.replyTo ?? null, rows: msg.rows, id });
    return id;
  }
  async edit(origin: Origin, messageId: string, msg: { text: string; rows?: Row[] }) {
    if (this.editFailWith) throw this.editFailWith;
    this.edits.push({ origin, messageId, text: msg.text, rows: msg.rows });
  }
  async react(_o: Origin, messageId: string, emoji: string) {
    this.reactions.push({ messageId, emoji });
  }

  receive(m: Partial<SlackMessage>) {
    this.messageHandler({ place: "dm", channelId: "D1", threadTs: null, ts: "1700.0001", userId: OWNER, text: "hi", ...m });
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
let app: SlackApp;

function makeApp(raw: Record<string, unknown> = {}) {
  const config = parseConfig({ appTokenFile: "/unused", botTokenFile: "/unused", ownerId: OWNER, drainIntervalMs: 60_000, streamIntervalMs: 5, ...raw });
  return createSlackApp({ gateway, kernel, ledger, cards: sqliteCards(ledger.db), config, log: () => {} });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "me-slack-"));
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
  gateway.receive({ ts: "1700.0001", text: "안녕" });
  await app.idle();

  expect(kernel.chats).toHaveLength(1);
  const { threadId } = kernel.chats[0]!;
  expect(kernel.conversations.get(threadId)).toMatchObject({ originKey: originKey(ownerDm), epoch: 0 });
  expect(ledger.conversation(ownerDm).sessionId).toBe(threadId);

  expect(gateway.sent).toEqual([{ origin: ownerDm, text: "answer to: 안녕", replyTo: "1700.0001", rows: undefined, id: "1800.0001" }]);
  expect(deliveries()[0]).toMatchObject({ state: "sent", platform_message_id: "1800.0001", reply_to: "1700.0001", origin: "slack/dm/UOWNER" });
  expect(gateway.emojis("1700.0001")).toEqual([REACTIONS.received, REACTIONS.judging, REACTIONS.answering, REACTIONS.done]);

  // The next message continues the same head thread.
  gateway.receive({ ts: "1700.0002", text: "또" });
  await app.idle();
  expect(kernel.chats[1]!.threadId).toBe(threadId);
});

test("channel messages need a mention, then the Slack thread is the conversation; strangers are refused", async () => {
  gateway.receive({ place: "channel", channelId: "C1", ts: "1.1", text: "hello all" });
  gateway.receive({ place: "dm", userId: "USTRANGER", ts: "1.2", text: "let me in" });
  await app.idle();
  expect(kernel.chats).toHaveLength(0);
  expect(gateway.reactions).toHaveLength(0);

  gateway.receive({ place: "channel", channelId: "C1", ts: "2.0", text: `<@${BOT}> 요약해줘` });
  await app.idle();
  expect(kernel.chats.map((c) => c.text)).toEqual(["요약해줘"]);
  expect(gateway.sent[0]!.origin).toEqual(thread("C1", "2.0"));

  // A follow-up inside that thread needs no mention and stays on the same head thread.
  gateway.receive({ place: "channel", channelId: "C1", threadTs: "2.0", ts: "2.5", text: "더 자세히" });
  // A thread the bot is not part of still needs a mention; a stranger is refused even in the bot's thread.
  gateway.receive({ place: "channel", channelId: "C1", threadTs: "1.1", ts: "1.3", text: "anyone?" });
  gateway.receive({ place: "channel", channelId: "C1", threadTs: "2.0", ts: "2.6", userId: "USTRANGER", text: "me too" });
  await app.idle();
  expect(kernel.chats.map((c) => c.text)).toEqual(["요약해줘", "더 자세히"]);
  expect(kernel.chats[1]!.threadId).toBe(kernel.chats[0]!.threadId);
});

test("open groups need no mention", async () => {
  app.stop();
  app = makeApp({ openGroups: ["C7"] });
  gateway.receive({ place: "channel", channelId: "C7", ts: "3.0", text: "그냥 말" });
  await app.idle();
  expect(kernel.chats).toHaveLength(1);
});

test("a redelivered message is handled once", async () => {
  gateway.receive({ ts: "1700.0001", text: "once" });
  gateway.receive({ ts: "1700.0001", text: "once" });
  await app.idle();
  expect(kernel.chats).toHaveLength(1);
  expect(gateway.sent).toHaveLength(1);
});

test("two quick messages in one conversation are processed and answered in order", async () => {
  kernel.respond = async (p) => {
    await Bun.sleep(p.text === "first" ? 40 : 1);
    return { text: `re ${p.text}` };
  };
  gateway.receive({ ts: "1.1", text: "first" });
  gateway.receive({ ts: "1.2", text: "second" });
  await app.idle();
  expect(kernel.log).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  expect(gateway.sent.map((s) => s.text)).toEqual(["re first", "re second"]);
});

test("a long Markdown reply becomes ledgered mrkdwn chunks with balanced code fences", async () => {
  const code = Array.from({ length: 300 }, (_, i) => `print(${i})  # ${"z".repeat(20)}`).join("\n");
  kernel.respond = async () => ({ text: `**설명**\n\`\`\`py\n${code}\n\`\`\`\n끝` });
  gateway.receive({ ts: "1.1", text: "코드 줘" });
  await app.idle();

  expect(gateway.sent.length).toBeGreaterThan(1);
  expect(gateway.sent[0]!.text.startsWith("*설명*\n```\n")).toBe(true);
  for (const s of gateway.sent) {
    expect(s.text.length).toBeLessThanOrEqual(SLACK_LIMIT - DUPLICATE_LABEL.length - 2);
    expect(fenceCount(s.text) % 2).toBe(0);
  }
  expect(gateway.sent.map((s) => s.replyTo)).toEqual(["1.1", ...gateway.sent.slice(1).map(() => null)]);
  expect(deliveries().every((d) => d.state === "sent")).toBe(true);
});

test("a streamed reply is posted as a preview, edited as it grows, and replaced by the ledgered final text", async () => {
  kernel.respond = async (_p, onUpdate) => {
    onUpdate({ kind: "text_delta", delta: "첫 " });
    await Bun.sleep(30);
    onUpdate({ kind: "text_delta", delta: "둘 " });
    await Bun.sleep(30);
    onUpdate({ kind: "text_delta", delta: "셋" });
    return { text: "첫 둘 셋 (완성)" };
  };
  gateway.receive({ ts: "1.1", text: "길게" });
  await app.idle();

  expect(gateway.sent).toHaveLength(1);
  const preview = gateway.sent[0]!;
  expect(preview.text).toBe(`첫 \n\n${STREAMING}`);
  const onPreview = gateway.edits.filter((e) => e.messageId === preview.id);
  expect(onPreview.length).toBeGreaterThanOrEqual(2);
  expect(onPreview.slice(0, -1).every((e) => e.text.endsWith(STREAMING))).toBe(true);
  expect(onPreview.at(-1)!.text).toBe("첫 둘 셋 (완성)");
  expect(deliveries()).toMatchObject([{ state: "sent", platform_message_id: preview.id, text: "첫 둘 셋 (완성)" }]);
});

test("a preview Slack no longer accepts edits for is answered with a new message", async () => {
  kernel.respond = async (_p, onUpdate) => {
    onUpdate({ kind: "text_delta", delta: "partial" });
    await Bun.sleep(20);
    return { text: "final" };
  };
  gateway.receive({ ts: "1.1", text: "x" });
  await Bun.sleep(10);
  gateway.editFailWith = new SendRejected("message_not_found", false);
  await app.idle();
  expect(gateway.sent.map((s) => s.text)).toEqual([`partial\n\n${STREAMING}`, "final"]);
  expect(deliveries()[0]).toMatchObject({ state: "sent", platform_message_id: gateway.sent[1]!.id });
});

test("a head error is reported with the warning reaction", async () => {
  kernel.respond = async () => ({ text: "", status: "error", error: "jev down" });
  gateway.receive({ ts: "1.1", text: "뭔가 해줘" });
  await app.idle();
  expect(gateway.emojis("1.1")).toContain(REACTIONS.error);
  expect(gateway.sent[0]!.text).toContain("jev down");
});

async function delegatedMessage() {
  // A Slack conversation whose head thread produced the message the approval points at.
  let messageId = "";
  kernel.respond = async (_p, onUpdate) => {
    onUpdate({ kind: "delegation", state: "delegated", taskId: "t1", harness: "local.codex" });
    return { text: "local.codex에 맡겼어요.", route: "delegate" };
  };
  gateway.receive({ ts: "1.1", text: "버그 고쳐줘" });
  await app.idle();
  for (const m of kernel.messages.values()) messageId = m.id;
  return { messageId, threadId: kernel.chats[0]!.threadId };
}

test("approval cards go to the originating conversation; only the owner decides, with amend.harness", async () => {
  const { messageId } = await delegatedMessage();
  expect(gateway.emojis("1.1")).toContain(REACTIONS.delegated);
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

  const cards = gateway.sent.filter((s) => s.rows?.length);
  expect(cards).toHaveLength(1);
  const card = cards[0]!;
  expect(card.origin).toEqual(ownerDm);
  expect(card.text).toContain("승인 요청");
  expect(card.rows![0]!.map((c) => c.id)).toEqual([ids.approve(approvalId), ids.reject(approvalId)]);
  const select = card.rows![1]![0] as Select;
  expect(select.options.map((o) => o.value)).toEqual(["local.claude-code", "local.codex", "local.gjc"]);

  // Someone else: ephemeral refusal, nothing decided or changed.
  expect((await gateway.press(ids.approve(approvalId), "USTRANGER")).text).toContain("주인만");
  expect((await gateway.press(ids.harness(approvalId), "USTRANGER", ["local.gjc"])).text).toContain("주인만");
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

test("a sealed task tied to a Slack conversation posts its result with accept/reject/diff for the owner", async () => {
  const { threadId } = await delegatedMessage();
  const taskId = crypto.randomUUID();
  kernel.tasks.set(taskId, { taskId, harness: "local.codex", state: "sealed", resultText: "고쳤어요\n" + "r".repeat(5000), origin: { plugin: "gjc-head", threadId, messageId: "x" } });
  kernel.tasks.set("other", { taskId: "other", harness: "local.codex", state: "sealed", resultText: "web", origin: { plugin: "gjc-head", threadId: "web-thread" } });
  app.onKernelEvent("brgr.task.sealed", { taskId, state: "sealed", harness: "local.codex" });
  app.onKernelEvent("brgr.task.sealed", { taskId: "other", state: "sealed", harness: "local.codex" });
  await app.idle();

  const cards = gateway.sent.filter((s) => s.rows?.length);
  expect(cards).toHaveLength(1);
  const card = cards[0]!;
  expect(card.origin).toEqual(ownerDm);
  expect(card.text.length).toBeLessThan(3000);
  expect(card.text).toContain("고쳤어요");
  expect(card.rows![0]!.map((c) => c.id)).toEqual([ids.task(taskId, "accept"), ids.task(taskId, "reject"), ids.task(taskId, "diff")]);

  expect((await gateway.press(ids.task(taskId, "accept"), "USTRANGER")).text).toContain("주인만");
  expect(kernel.accepted).toHaveLength(0);

  const diff = await gateway.press(ids.task(taskId, "diff"));
  expect(diff.file).toEqual({ name: `${taskId.slice(0, 8)}.diff`, content: "diff --git a/x b/x\n+hello\n" });

  await gateway.press(ids.task(taskId, "accept"));
  expect(kernel.accepted).toEqual([taskId]);
  await gateway.press(ids.task(taskId, "reject"));
  expect(kernel.rejected).toEqual([taskId]);

  app.onKernelEvent("brgr.task.applied", { taskId, state: "applied" });
  await app.idle();
  expect(gateway.edits.at(-1)).toMatchObject({ messageId: card.id, rows: [] });
});

test("crash recovery reissues an uncertain reply with the duplicate label", async () => {
  gateway.failWith = new Error("socket hang up");
  gateway.receive({ ts: "1.1", text: "답해줘" });
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
  expect(gateway.sent[0]!.replyTo).toBe("1.1");
  const rows = deliveries();
  expect(rows.map((d) => d.state)).toEqual(["failed", "sent"]);
  expect(rows[1]!.duplicate_of).toBe(rows[0]!.id);
});

test("a definite refusal is not reissued as a duplicate", async () => {
  gateway.failWith = new SendRejected("not_in_channel", false);
  gateway.receive({ ts: "1.1", text: "x" });
  await app.idle();
  expect(deliveries()[0]!.state).toBe("failed");
  expect(ledger.recoverUncertain()).toHaveLength(0);
});

test("/new starts a new epoch and a new head thread for that conversation only", async () => {
  gateway.receive({ ts: "1.1", text: "first" });
  gateway.receive({ place: "channel", channelId: "C1", ts: "5.0", text: `<@${BOT}> team` });
  await app.idle();
  const oldThread = kernel.chats[0]!.threadId;
  const teamThread = kernel.chats[1]!.threadId;

  gateway.receive({ ts: "1.2", text: " /new" });
  await app.idle();
  expect(ledger.conversation(ownerDm).epoch).toBe(1);
  expect(gateway.sent.at(-1)!.text).toBe("새 대화를 시작했어요.");
  const newThread = ledger.conversation(ownerDm).sessionId!;
  expect(newThread).not.toBe(oldThread);
  expect(kernel.conversations.get(newThread)).toMatchObject({ originKey: "slack/dm/UOWNER", epoch: 1 });
  // The old thread still maps back, so its late approvals and tasks find the conversation.
  expect(kernel.conversations.get(oldThread)).toMatchObject({ epoch: 0 });

  gateway.receive({ ts: "1.3", text: "second" });
  gateway.receive({ place: "channel", channelId: "C1", threadTs: "5.0", ts: "5.1", text: "again" });
  await app.idle();
  expect(kernel.chats.find((c) => c.text === "second")!.threadId).toBe(newThread);
  expect(kernel.chats.find((c) => c.text === "again")!.threadId).toBe(teamThread);
});

test("notify posts to the default channel through the ledger", async () => {
  const napp = makeApp({ notifyChannel: "C123" });
  const r = await napp.notify("⏱ 아침 브리핑\nhello");
  expect(r).toEqual({ channel: "C123" });
  expect(gateway.sent).toHaveLength(1);
  expect(gateway.sent[0]).toMatchObject({ origin: { platform: "slack", kind: "group", conversationId: "C123" } });
  napp.stop();
});

test("notify without a channel or text refuses", async () => {
  await expect(app.notify("hi")).rejects.toThrow("notifyChannel");
  const napp = makeApp({ notifyChannel: "C123" });
  await expect(napp.notify("  ")).rejects.toThrow("text");
  napp.stop();
  expect(() => parseConfig({ appTokenFile: "/u", botTokenFile: "/u", ownerId: "UOWNER", notifyChannel: "no!" })).toThrow();
});
