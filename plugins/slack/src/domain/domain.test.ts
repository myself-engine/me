import { expect, test } from "bun:test";
import { toBlocks } from "./blocks.ts";
import { parseConfig } from "./config.ts";
import { ids, parseAction } from "./ids.ts";
import { channelOrigin, isNewCommand, originOf, plainText, threadOf, toInbound, type SlackMessage } from "./inbound.ts";
import { escapeText, toMrkdwn } from "./mrkdwn.ts";
import { approvalCard, approvalView, taskCard } from "./render.ts";
import { SLACK_LIMIT, fenceCount, splitMessage } from "./split.ts";

const base: SlackMessage = { place: "channel", channelId: "C1", threadTs: null, ts: "1700.0001", userId: "U1", text: "<@UBOT> hi" };

test("DMs are keyed by user; channel messages are threads rooted at their own ts or their thread", () => {
  expect(originOf({ ...base, place: "dm", channelId: "D9" })).toEqual({ platform: "slack", kind: "dm", conversationId: "U1" });
  expect(originOf(base)).toEqual({ platform: "slack", kind: "thread", conversationId: "C1:1700.0001" });
  expect(originOf({ ...base, ts: "1700.0005", threadTs: "1700.0001" })).toEqual(originOf(base));
  expect(channelOrigin(base)).toEqual({ platform: "slack", kind: "group", conversationId: "C1" });
  expect(threadOf("C1:1700.0001")).toEqual({ channel: "C1", threadTs: "1700.0001" });
  expect(() => threadOf("C1")).toThrow();
});

test("bot mentions are detected and stripped; Slack markup reads as plain text", () => {
  const m = toInbound({ ...base, text: "<@UBOT|me> /new" }, "UBOT", false);
  expect(m).toMatchObject({ text: "/new", mentionsBot: true, repliesToBot: false, messageId: "1700.0001" });
  expect(isNewCommand(m.text)).toBe(true);
  expect(isNewCommand(" /new ")).toBe(true);
  expect(toInbound({ ...base, text: "hello" }, "UBOT", false).mentionsBot).toBe(false);
  // A thread the bot already talks in counts as a reply to the bot; a top-level message never does.
  expect(toInbound({ ...base, text: "more", threadTs: "1700.0000" }, "UBOT", true).repliesToBot).toBe(true);
  expect(toInbound({ ...base, text: "more" }, "UBOT", true).repliesToBot).toBe(false);
  expect(plainText("see <https://a.b/c?x=1&amp;y=2|docs>, <#C1|general>, <@U2> &lt;b&gt;")).toBe("see docs (https://a.b/c?x=1&y=2), #general, @U2 <b>");
});

test("Markdown becomes mrkdwn; code keeps its text and drops the fence language", () => {
  expect(toMrkdwn("# 제목\n**굵게** *기울임* ~~취소~~ [링크](https://x.y)")).toBe("*제목*\n*굵게* _기울임_ ~취소~ <https://x.y|링크>");
  expect(toMrkdwn("- a\n* b\n> q **x**\n---")).toBe("• a\n• b\n> q *x*\n──────────");
  expect(toMrkdwn("a < b & `c**d**<e`")).toBe("a &lt; b &amp; `c**d**&lt;e`");
  expect(toMrkdwn("```ts\nconst x = **y** < 1;\n```")).toBe("```\nconst x = **y** &lt; 1;\n```");
  expect(toMrkdwn("2*3*4")).toBe("2*3*4");
  expect(escapeText("<&>")).toBe("&lt;&amp;&gt;");
});

test("long replies split under Slack's limit with balanced fences", () => {
  const code = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const chunks = splitMessage(`intro\n\`\`\`\n${code}\n\`\`\`\nend`);
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) {
    expect(c.length).toBeLessThanOrEqual(SLACK_LIMIT);
    expect(fenceCount(c) % 2).toBe(0);
  }
});

test("action ids round-trip and junk is rejected", () => {
  const id = crypto.randomUUID();
  expect(parseAction(ids.approve(id))).toEqual({ type: "approval", approvalId: id, decision: "approve" });
  expect(parseAction(ids.harness(id))).toEqual({ type: "harness", approvalId: id });
  expect(parseAction(ids.task(id, "diff"))).toEqual({ type: "task", taskId: id, action: "diff" });
  expect(parseAction("me.ap:x:launch")).toBeNull();
});

test("cards become Block Kit: a mrkdwn section, buttons with Slack styles, a select with its initial option", () => {
  const view = approvalView({ approvalId: "a1", summary: "fix <bug>", risk: "high", payload: { harness: "local.codex", harnesses: ["local.codex", "local.gjc"], brief: "do it" } });
  const card = approvalCard(view, "local.gjc");
  expect(card.text).toContain("*승인 요청* · 위험도 높음");
  expect(card.text).toContain("fix &lt;bug&gt;");
  const blocks = toBlocks(card) as any[];
  expect(blocks[0]).toEqual({ type: "section", text: { type: "mrkdwn", text: card.text } });
  expect(blocks[1].elements.map((e: any) => [e.action_id, e.style])).toEqual([
    [ids.approve("a1"), "primary"],
    [ids.reject("a1"), "danger"],
  ]);
  expect(blocks[2].elements[0]).toMatchObject({ type: "static_select", action_id: ids.harness("a1"), initial_option: { value: "local.gjc" } });

  const task = toBlocks(taskCard({ taskId: "t".repeat(36), harness: "local.codex", state: "sealed", resultText: "**done**\n" + "r".repeat(5000) })) as any[];
  expect(task[0].text.text.length).toBeLessThanOrEqual(3000);
  expect(task[0].text.text).toContain("*done*");
  expect(task[1].elements.map((e: any) => e.style)).toEqual(["primary", "danger", undefined]);
});

test("config takes token files only, a Slack member id as owner, and channel ids as open groups", () => {
  const ok = { appTokenFile: "/a", botTokenFile: "/b", ownerId: "U0123ABCD" };
  expect(() => parseConfig({ ...ok, ownerId: "123" })).toThrow("ownerId");
  expect(() => parseConfig({ ...ok, botTokenFile: undefined })).toThrow("botTokenFile");
  expect(() => parseConfig({ ...ok, appTokenFile: "" })).toThrow("appTokenFile");
  for (const inline of ["token", "appToken", "botToken"]) expect(() => parseConfig({ ...ok, [inline]: "x" })).toThrow("inline");
  expect(() => parseConfig({ ...ok, openGroups: ["discord/group/1"] })).toThrow("openGroups");
  const c = parseConfig({ ...ok, openGroups: ["C42", "slack/group/G7"] });
  expect(c.policy).toEqual({ dm: "owner-only", ownerId: "U0123ABCD", allowlist: [], openGroups: ["slack/group/C42", "slack/group/G7"] });
  expect(c.streamIntervalMs).toBe(1_500);
});
