import { expect, test } from "bun:test";
import { parseConfig } from "./config.ts";
import { ids, parseAction } from "./ids.ts";
import { originOf, toInbound } from "./inbound.ts";
import { DISCORD_LIMIT, fenceCount, splitMessage, truncate } from "./split.ts";

test("short replies are not split", () => {
  expect(splitMessage("hello\nworld")).toEqual(["hello\nworld"]);
});

test("long replies split at line boundaries under the limit", () => {
  const text = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const chunks = splitMessage(text);
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(DISCORD_LIMIT);
  expect(chunks.join("\n")).toBe(text);
});

test("splitting inside a code fence closes it and reopens it with its language", () => {
  const code = Array.from({ length: 200 }, (_, i) => `const v${i} = ${i}; // ${"y".repeat(10)}`).join("\n");
  const text = `before\n\`\`\`ts\n${code}\n\`\`\`\nafter`;
  const chunks = splitMessage(text);
  expect(chunks.length).toBeGreaterThan(2);
  for (const c of chunks) {
    expect(c.length).toBeLessThanOrEqual(DISCORD_LIMIT);
    expect(fenceCount(c) % 2).toBe(0);
  }
  expect(chunks[1]!.startsWith("```ts\n")).toBe(true);
  expect(chunks.at(-1)!.endsWith("after")).toBe(true);
});

test("an over-long single line is hard-split", () => {
  const chunks = splitMessage("z".repeat(4500));
  expect(chunks.map((c) => c.length)).toEqual([1996, 1996, 508]);
});

test("truncate keeps fences balanced", () => {
  const t = truncate("```\n" + "a\n".repeat(500) + "```", 300);
  expect(t.length).toBeLessThanOrEqual(300);
  expect(fenceCount(t) % 2).toBe(0);
});

test("component ids round-trip and junk is rejected", () => {
  const id = crypto.randomUUID();
  expect(parseAction(ids.approve(id))).toEqual({ type: "approval", approvalId: id, decision: "approve" });
  expect(parseAction(ids.harness(id))).toEqual({ type: "harness", approvalId: id });
  expect(parseAction(ids.task(id, "diff"))).toEqual({ type: "task", taskId: id, action: "diff" });
  expect(parseAction("me.ap:x:launch")).toBeNull();
  expect(parseAction("other")).toBeNull();
});

test("DMs are keyed by user; guild channels and threads by channel; bot mentions are stripped", () => {
  const base = { channelId: "c1", authorId: "u1", messageId: "m1", content: "<@b> hi", mentionsBot: true, repliesToBot: false };
  expect(originOf({ ...base, place: "dm" })).toEqual({ platform: "discord", kind: "dm", conversationId: "u1" });
  expect(originOf({ ...base, place: "guild" }).kind).toBe("group");
  expect(originOf({ ...base, place: "thread" }).kind).toBe("thread");
  expect(toInbound({ ...base, place: "guild" }, "b").text).toBe("hi");
});

test("config requires ownerId and a token file, never an inline token", () => {
  expect(() => parseConfig({ tokenFile: "/t" })).toThrow("ownerId");
  expect(() => parseConfig({ ownerId: "1" })).toThrow("tokenFile");
  expect(() => parseConfig({ ownerId: "1", tokenFile: "/t", token: "abc" })).toThrow("inline");
  const c = parseConfig({ ownerId: "1", tokenFile: "/t", openGroups: ["42"] });
  expect(c.policy).toEqual({ dm: "owner-only", ownerId: "1", allowlist: [], openGroups: ["discord/group/42"] });
});
