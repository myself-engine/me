import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPipePair } from "@me/protocol";
import { definePlugin, type Plugin } from "@me/sdk";
import { Kernel, validateManifest } from "@me/kernel";
import { renderManifest, type AcpConfig } from "../src/config.ts";
import { formatResult, runConformance } from "../../../spec/conformance/run.ts";

const bridgeMain = join(import.meta.dir, "..", "src", "main.ts");
const fixture = join(import.meta.dir, "fixtures", "agent.ts");

let dir: string;
let kernel: Kernel;
let caller: Plugin;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "me-acp-"));
  const config: AcpConfig = { agent: { command: "bun", args: [fixture] }, cwd: dir };
  kernel = new Kernel({ dataDir: dir, log: () => {}, pluginConfig: { "acp-test": config as any } });
  await kernel.spawn(validateManifest(renderManifest("acp-test", config, bridgeMain), dir));
  caller = definePlugin({});
  const [k, p] = createPipePair();
  void caller.run(p);
  await kernel.attach(
    validateManifest({ id: "caller", version: "0", protocol: { min: 1, max: 1 }, run: { command: ["true"] }, permissions: ["call:acp-test"] }, dir),
    k,
  );
});

afterAll(async () => {
  await kernel.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("bridge initializes the agent on start and exposes its info", async () => {
  expect(kernel.pluginState("acp-test")).toBe("running");
  const info = await caller.invoke<any>("acp-test", "agent.info", {});
  expect(info.agentInfo.name).toBe("fixture-agent");
});

test("streaming session.prompt sends each session/update as op.update", async () => {
  const { sessionId } = await caller.invoke<any>("acp-test", "session.new", {});
  const updates: any[] = [];
  const res = await caller.invoke<any>("acp-test", "session.prompt", { sessionId, prompt: "hi" }, { stream: true, onUpdate: (u) => updates.push(u) });
  expect(updates.map((u) => u.sessionUpdate)).toEqual(["agent_message_chunk", "agent_message_chunk", "agent_message_chunk"]);
  expect(res).toMatchObject({ sessionId, stopReason: "end_turn", text: "echo: hi" });
});

test("session.prompt without a sessionId opens a session; bad params are rejected", async () => {
  const res = await caller.invoke<any>("acp-test", "session.prompt", { prompt: "x" });
  expect(res.text).toBe("echo: x");
  expect(typeof res.sessionId).toBe("string");
  await expect(caller.invoke("acp-test", "session.prompt", {})).rejects.toThrow("prompt must be");
  await expect(caller.invoke("acp-test", "session.new", { cwd: "rel" })).rejects.toThrow("absolute");
  await expect(caller.invoke("acp-test", "session.cancel", {})).rejects.toThrow("sessionId is required");
});

test("op.cancel on a streaming prompt sends session/cancel", async () => {
  const { sessionId } = await caller.invoke<any>("acp-test", "session.new", {});
  const started = Date.now();
  const { opId, done } = await caller.invokeStream("acp-test", "session.prompt", { sessionId, prompt: "slow" });
  await Bun.sleep(100);
  await caller.cancelOp(opId);
  await expect(done).rejects.toThrow("cancelled");
  expect(Date.now() - started).toBeLessThan(3_000);
});

test("session.cancel method ends a running prompt", async () => {
  const { sessionId } = await caller.invoke<any>("acp-test", "session.new", {});
  const { done } = await caller.invokeStream("acp-test", "session.prompt", { sessionId, prompt: "slow" });
  await Bun.sleep(100);
  expect(await caller.invoke<any>("acp-test", "session.cancel", { sessionId })).toEqual({});
  expect((await done).stopReason).toBe("cancelled");
});

test(
  "bridge passes the conformance suite with the fake agent",
  async () => {
    const r = await runConformance(join(import.meta.dir, "fixtures", "conformance"), { config: { agent: { command: "bun", args: [fixture] } } });
    if (!r.ok) console.error(formatResult(r));
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
  },
  60_000,
);
