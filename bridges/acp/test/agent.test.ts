import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorCode } from "@me/protocol";
import { AgentConnection } from "../src/agent.ts";
import type { AcpConfig } from "../src/config.ts";

const fixture = join(import.meta.dir, "fixtures", "agent.ts");
const base: AcpConfig = { agent: { command: "bun", args: [fixture] } };
let dir: string;
const open: AgentConnection[] = [];

function connect(extra: Partial<AcpConfig> = {}) {
  const c = new AgentConnection({ ...base, ...extra, agent: { ...base.agent, ...(extra.agent ?? {}) } });
  open.push(c);
  return c;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "me-acp-"));
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("initialize advertises no fs or terminal and returns the agent's info", async () => {
  const info: any = await connect().info();
  expect(info.protocolVersion).toBe(1);
  expect(info.agentInfo.name).toBe("fixture-agent");
  expect(info._meta.clientCapabilities).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
});

test("an agent with another protocol version is refused", async () => {
  await expect(connect({ agent: { command: "bun", args: [fixture], env: { FIXTURE_PROTOCOL: "2" } } }).get()).rejects.toThrow(
    "ACP version 2",
  );
});

test("an agent that cannot start is reported", async () => {
  await expect(connect({ agent: { command: join(dir, "no-such-agent") } }).get()).rejects.toThrow();
});

test("session/new uses the configured cwd and no MCP servers", async () => {
  const s: any = await connect({ cwd: dir }).newSession();
  expect(s.sessionId).toBe("s1");
  expect(s._meta).toEqual({ cwd: dir, mcpServers: [] });
});

test("a prompt streams every session/update and returns the stop reason and text", async () => {
  const c = connect();
  const { sessionId } = await c.newSession();
  const updates: any[] = [];
  const r = await c.prompt(sessionId, [{ type: "text", text: "hi" }], (u) => updates.push(u));
  expect(updates.map((u) => u.content.text)).toEqual(["echo", ": ", "hi"]);
  expect(r).toEqual({ sessionId, stopReason: "end_turn", text: "echo: hi", usage: { inputTokens: 1, outputTokens: 3, totalTokens: 4 } });
});

test("permission requests are rejected by default and reported as an update", async () => {
  const c = connect();
  const { sessionId } = await c.newSession();
  const updates: any[] = [];
  const r = await c.prompt(sessionId, [{ type: "text", text: "permission" }], (u) => updates.push(u));
  expect(r.text).toBe("permission: no");
  const p = updates.find((u) => u.permission)?.permission;
  expect(p.outcome).toEqual({ outcome: "selected", optionId: "no" });
  expect(p.toolCall.title).toBe("rm -rf /");
});

test("permission: allow selects the allow option", async () => {
  const c = connect({ permission: "allow" });
  const { sessionId } = await c.newSession();
  expect((await c.prompt(sessionId, [{ type: "text", text: "permission" }], () => {})).text).toBe("permission: yes");
});

test("client file system requests are refused as unknown methods", async () => {
  const c = connect();
  const { sessionId } = await c.newSession();
  expect((await c.prompt(sessionId, [{ type: "text", text: "fs" }], () => {})).text).toBe("fs: -32601");
});

test("aborting the signal sends session/cancel and ends the turn as cancelled", async () => {
  const c = connect();
  const { sessionId } = await c.newSession();
  const ac = new AbortController();
  const started = Date.now();
  const p = c.prompt(sessionId, [{ type: "text", text: "slow" }], () => ac.abort(), ac.signal);
  const err: any = await p.catch((e) => e);
  expect(err.code).toBe(ErrorCode.Cancelled);
  expect(err.data.stopReason).toBe("cancelled");
  expect(Date.now() - started).toBeLessThan(3_000);
});

test("a turn the agent never ends after cancel fails as cancelled after cancelGraceMs", async () => {
  const c = connect({ cancelGraceMs: 200 });
  const { sessionId } = await c.newSession();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const started = Date.now();
  const err: any = await c.prompt(sessionId, [{ type: "text", text: "stubborn" }], () => {}, ac.signal).catch((e) => e);
  expect(err.code).toBe(ErrorCode.Cancelled);
  expect(err.message).toContain("did not end the turn");
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("session.cancel ends a running prompt with stopReason cancelled; one prompt per session at a time", async () => {
  const c = connect();
  const { sessionId } = await c.newSession();
  let started!: () => void;
  const running = new Promise<void>((r) => (started = r));
  const p = c.prompt(sessionId, [{ type: "text", text: "slow" }], () => started());
  await running;
  await expect(c.prompt(sessionId, [{ type: "text", text: "hi" }], () => {})).rejects.toThrow("already has a prompt running");
  await c.cancel(sessionId);
  expect((await p).stopReason).toBe("cancelled");
});

test("a prompt that outlives promptTimeoutMs fails as a timeout", async () => {
  const c = connect({ promptTimeoutMs: 200 });
  const { sessionId } = await c.newSession();
  const err: any = await c.prompt(sessionId, [{ type: "text", text: "slow" }], () => {}).catch((e) => e);
  expect(err.code).toBe(ErrorCode.Timeout);
});

test("an agent that dies fails the prompt and is respawned on the next call", async () => {
  const c = connect();
  const { sessionId } = await c.newSession();
  const err: any = await c.prompt(sessionId, [{ type: "text", text: "crash" }], () => {}).catch((e) => e);
  expect(err.code).toBe(ErrorCode.TargetUnavailable);
  expect(err.message).toContain("exited");
  const again = await c.newSession();
  expect(again.sessionId).toBe("s1"); // a fresh process numbers sessions from 1 again
  expect((await c.prompt(again.sessionId, [{ type: "text", text: "ok" }], () => {})).text).toBe("echo: ok");
});

test("envFiles are read by path and passed to the agent", async () => {
  const keyPath = join(dir, "token");
  writeFileSync(keyPath, "fake-token\n");
  const c = connect({ agent: { command: "bun", args: [fixture], envFiles: { FIXTURE_TOKEN: keyPath } } });
  const { sessionId } = await c.newSession();
  expect((await c.prompt(sessionId, [{ type: "text", text: "env" }], () => {})).text).toBe("env: fake-token");
  await expect(connect({ agent: { command: "bun", args: [fixture], envFiles: { X: join(dir, "missing") } } }).get()).rejects.toThrow(
    `env file for X is unreadable: ${join(dir, "missing")}`,
  );
});
