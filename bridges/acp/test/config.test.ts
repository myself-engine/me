import { expect, test } from "bun:test";
import { BRIDGE_METHODS, decidePermission, messageText, renderManifest, toPromptBlocks, validateConfig } from "../src/config.ts";

test("validateConfig accepts a well-formed config", () => {
  expect(() => validateConfig({ agent: { command: "gjc", args: ["--mode", "acp"], envFiles: { KEY: "~/.config/me/secrets/k" } } })).not.toThrow();
  expect(() => validateConfig({ agent: { command: "x" }, cwd: "/tmp", permission: "allow", promptTimeoutMs: 0 })).not.toThrow();
});

test("validateConfig rejects bad fields", () => {
  const bad = (cfg: unknown) => () => validateConfig(cfg);
  expect(bad({})).toThrow("config.agent");
  expect(bad({ agent: {} })).toThrow("agent.command is required");
  expect(bad({ agent: { command: "x", args: [1] } })).toThrow("agent.args");
  expect(bad({ agent: { command: "x", env: { A: 1 } } })).toThrow("agent.env");
  expect(bad({ agent: { command: "x", envFiles: { "A-B": "/k" } } })).toThrow("invalid variable name");
  expect(bad({ agent: { command: "x" }, cwd: "rel" })).toThrow("absolute");
  expect(bad({ agent: { command: "x" }, permission: "ask" })).toThrow("permission");
  expect(bad({ agent: { command: "x" }, initTimeoutMs: 0 })).toThrow("initTimeoutMs");
  expect(bad({ agent: { command: "x" }, promptTimeoutMs: -1 })).toThrow("promptTimeoutMs");
});

test("prompts are a string or content blocks", () => {
  expect(toPromptBlocks("hi")).toEqual([{ type: "text", text: "hi" }]);
  const blocks = [{ type: "text", text: "a" }, { type: "resource_link", uri: "file:///x", name: "x" }];
  expect(toPromptBlocks(blocks)).toBe(blocks);
  for (const bad of [undefined, "", [], [{}], [{ type: 1 }], 3]) expect(() => toPromptBlocks(bad)).toThrow();
});

test("permission policy picks once before always and falls back to cancelled", () => {
  const all = [
    { optionId: "aa", kind: "allow_always" },
    { optionId: "ao", kind: "allow_once" },
    { optionId: "ra", kind: "reject_always" },
    { optionId: "ro", kind: "reject_once" },
  ];
  expect(decidePermission("reject", all)).toEqual({ outcome: "selected", optionId: "ro" });
  expect(decidePermission("allow", all)).toEqual({ outcome: "selected", optionId: "ao" });
  expect(decidePermission("reject", [all[2]!])).toEqual({ outcome: "selected", optionId: "ra" });
  expect(decidePermission("reject", [all[0]!])).toEqual({ outcome: "cancelled" });
  expect(decidePermission("allow", [])).toEqual({ outcome: "cancelled" });
});

test("messageText reads only agent text chunks", () => {
  expect(messageText({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } })).toBe("a");
  expect(messageText({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "a" } })).toBe("");
  expect(messageText({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "" } })).toBe("");
});

test("renderManifest has the fixed method set and declares shell", () => {
  const m = renderManifest("acp-gjc", { agent: { command: "gjc" } }, "../../bridges/acp/src/main.ts");
  expect(m.provides.methods).toEqual(BRIDGE_METHODS);
  expect(m.permissions).toEqual(["shell"]);
  expect(() => renderManifest("acp-x", { agent: {} } as any, "m.ts")).toThrow();
});
