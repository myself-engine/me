import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConversationQueue,
  DUPLICATE_LABEL,
  Ledger,
  SendRejected,
  admit,
  drain,
  originKey,
  type InboundMessage,
  type Origin,
  type PlatformSender,
  type Policy,
} from "./index.ts";

let dir: string;
let ledger: Ledger;
const dm: Origin = { platform: "discord", kind: "dm", conversationId: "u1" };
const team: Origin = { platform: "discord", kind: "group", conversationId: "c9" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "me-messenger-"));
  ledger = new Ledger(join(dir, "ledger.sqlite"));
});
afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

const msg = (o: Partial<InboundMessage>): InboundMessage => ({
  origin: dm,
  authorId: "owner",
  messageId: "m1",
  text: "hi",
  mentionsBot: false,
  repliesToBot: false,
  ...o,
});
const policy: Policy = { dm: "owner-only", ownerId: "owner", allowlist: ["friend"], openGroups: ["discord/group/open1"] };

test("a DM and a channel are different conversations with separate sessions", () => {
  expect(ledger.hasConversation(dm)).toBe(false);
  ledger.setSession(dm, "s-dm");
  expect(ledger.hasConversation(dm)).toBe(true);
  expect(ledger.hasConversation(team)).toBe(false);
  ledger.setSession(team, "s-team");
  expect(ledger.conversation(dm).sessionId).toBe("s-dm");
  expect(ledger.conversation(team).sessionId).toBe("s-team");
  expect(originKey(dm)).not.toBe(originKey({ ...dm, kind: "group" }));
});

test("/new starts a fresh epoch for one conversation only and drops its stale pending replies", () => {
  ledger.setSession(dm, "old");
  ledger.setSession(team, "keep");
  const stale = ledger.enqueue(dm, "old reply");
  expect(ledger.newEpoch(dm)).toBe(1);
  expect(ledger.conversation(dm).sessionId).toBeNull();
  expect(ledger.conversation(team).sessionId).toBe("keep");
  expect(ledger.get(stale.id)!.state).toBe("failed");
  expect(ledger.pending()).toHaveLength(0);
});

test("inbound redelivery is ignored", () => {
  expect(ledger.recordInbound(msg({}))).toBe(true);
  expect(ledger.recordInbound(msg({}))).toBe(false);
  expect(ledger.recordInbound(msg({ messageId: "m2" }))).toBe(true);
});

test("policy: owner-only DMs, allowlist, mention-gated groups, open groups, own messages", () => {
  expect(admit(msg({}), policy, "bot")).toEqual({ admit: true });
  expect(admit(msg({ authorId: "stranger" }), policy, "bot")).toEqual({ admit: false, reason: "not-allowed" });
  expect(admit(msg({ authorId: "friend" }), { ...policy, dm: "allowlist" }, "bot")).toEqual({ admit: true });
  expect(admit(msg({ origin: team }), policy, "bot")).toEqual({ admit: false, reason: "not-addressed" });
  expect(admit(msg({ origin: team, mentionsBot: true }), policy, "bot")).toEqual({ admit: true });
  expect(admit(msg({ origin: team, repliesToBot: true }), policy, "bot")).toEqual({ admit: true });
  expect(admit(msg({ origin: { platform: "discord", kind: "group", conversationId: "open1" } }), policy, "bot")).toEqual({ admit: true });
  expect(admit(msg({ authorId: "bot" }), policy, "bot")).toEqual({ admit: false, reason: "own-message" });
});

test("a reply is recorded before sending and marked sent with the platform id", async () => {
  const d = ledger.enqueue(dm, "hello", "m1");
  expect(ledger.get(d.id)!.state).toBe("pending");
  const sender: PlatformSender = { send: async () => "p1" };
  expect(await drain(ledger, sender)).toEqual({ sent: 1, failed: 0, uncertain: 0 });
  expect(ledger.get(d.id)).toMatchObject({ state: "sent", platformMessageId: "p1", attempts: 1 });
});

test("a crash mid-send leaves the outcome unknown; recovery reissues it labeled as a duplicate", async () => {
  const d = ledger.enqueue(dm, "answer");
  const flaky: PlatformSender = { send: async () => Promise.reject(new Error("socket hang up")) };
  expect(await drain(ledger, flaky)).toEqual({ sent: 0, failed: 0, uncertain: 1 });
  expect(ledger.get(d.id)!.state).toBe("sending");

  // Simulate restart: reopen the ledger from disk.
  ledger.close();
  ledger = new Ledger(join(dir, "ledger.sqlite"));
  const [copy] = ledger.recoverUncertain();
  expect(copy!.duplicateOf).toBe(d.id);
  expect(copy!.text).toContain(DUPLICATE_LABEL);
  expect(ledger.get(d.id)!.state).toBe("failed");

  const sent: string[] = [];
  await drain(ledger, { send: async (_o, text) => (sent.push(text), "p2") });
  expect(sent).toEqual([`answer\n\n${DUPLICATE_LABEL}`]);
});

test("definite rejections retry up to maxAttempts, then fail without a duplicate", async () => {
  const d = ledger.enqueue(dm, "x");
  const reject: PlatformSender = { send: async () => Promise.reject(new SendRejected("rate limited", true)) };
  await drain(ledger, reject, 2);
  expect(ledger.get(d.id)!.state).toBe("pending");
  await drain(ledger, reject, 2);
  expect(ledger.get(d.id)!.state).toBe("failed");
  expect(ledger.recoverUncertain()).toHaveLength(0);
});

test("messages racing one conversation run in order; other conversations run concurrently", async () => {
  const q = new ConversationQueue();
  const log: string[] = [];
  const step = (name: string, ms: number) => async () => {
    log.push(`${name}:start`);
    await Bun.sleep(ms);
    log.push(`${name}:end`);
  };
  await Promise.all([q.run(dm, step("a", 30)), q.run(dm, step("b", 1)), q.run(team, step("t", 5))]);
  expect(log.indexOf("a:end")).toBeLessThan(log.indexOf("b:start"));
  expect(log.indexOf("t:start")).toBeLessThan(log.indexOf("a:end"));
  expect(q.active).toBe(0);
});

test("a failing task does not block the next message in the same conversation", async () => {
  const q = new ConversationQueue();
  await expect(q.run(dm, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  expect(await q.run(dm, async () => "next")).toBe("next");
});

test("origin parts cannot smuggle separators", () => {
  expect(() => originKey({ platform: "discord", kind: "dm", conversationId: "a/b" })).toThrow();
});
