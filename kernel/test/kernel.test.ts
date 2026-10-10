import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPipePair, ErrorCode, type Manifest } from "@me/protocol";
import { definePlugin, type Plugin, type PluginDefinition } from "@me/sdk";
import { Kernel } from "../src/kernel.ts";
import { validateManifest } from "../src/manifest.ts";

let dir: string;
let kernel: Kernel;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "me-kernel-"));
  kernel = new Kernel({ dataDir: dir, log: () => {} });
});

afterEach(async () => {
  await kernel.stop();
  rmSync(dir, { recursive: true, force: true });
});

function manifest(m: Partial<Manifest> & { id: string }): ReturnType<typeof validateManifest> {
  return validateManifest(
    { version: "0.0.0", protocol: { min: 1, max: 1 }, run: { command: ["true"] }, permissions: [], ...m },
    dir,
  );
}

async function attach(m: Partial<Manifest> & { id: string }, def: PluginDefinition = {}): Promise<Plugin> {
  const plugin = definePlugin(def);
  const [kSide, pSide] = createPipePair();
  void plugin.run(pSide);
  await kernel.attach(manifest(m), kSide);
  return plugin;
}

describe("invoke", () => {
  test("routes a call through the kernel and journals call and result under one trace", async () => {
    await attach({ id: "echo", provides: { methods: ["echo"] } }, { methods: { echo: (p) => ({ said: p.text }) } });
    const caller = await attach({ id: "caller", permissions: ["call:echo", "journal.read"] });

    expect(await caller.invoke<unknown>("echo", "echo", { text: "hi" })).toEqual({ said: "hi" });

    const entries = kernel.store.query({ limit: 1000 }).filter((e) => e.type === "call" || e.type === "result");
    expect(entries.map((e) => [e.type, e.source])).toEqual([
      ["call", "caller"],
      ["result", "echo"],
    ]);
    expect(entries[0]!.traceId).toBeTruthy();
    expect(entries[1]!.traceId).toBe(entries[0]!.traceId);
    expect(entries[1]!.causationId).toBe(entries[0]!.seq);
  });

  test("denies a call without call:<target> and journals the denial", async () => {
    await attach({ id: "echo", provides: { methods: ["echo"] } }, { methods: { echo: () => "x" } });
    const caller = await attach({ id: "caller", permissions: [] });

    await expect(caller.invoke("echo", "echo", {})).rejects.toMatchObject({ code: ErrorCode.PermissionDenied });
    expect(kernel.store.query({ limit: 1000 }).some((e) => e.type === "permission.denied")).toBe(true);
  });

  test("rejects methods the target does not declare", async () => {
    await attach({ id: "echo", provides: { methods: ["echo"] } }, { methods: { echo: () => "x", hidden: () => "secret" } });
    const caller = await attach({ id: "caller", permissions: ["call:*"] });

    await expect(caller.invoke("echo", "hidden", {})).rejects.toMatchObject({ code: ErrorCode.TargetUnavailable });
  });

  test("propagates traceId and causationId through nested calls", async () => {
    await attach({ id: "c", provides: { methods: ["leaf"] } }, { methods: { leaf: () => "leaf" } });
    let b!: Plugin;
    b = await attach(
      { id: "b", permissions: ["call:c"], provides: { methods: ["mid"] } },
      { methods: { mid: async () => b.invoke("c", "leaf", {}) } },
    );
    const a = await attach({ id: "a", permissions: ["call:b"] });

    expect(await a.invoke<unknown>("b", "mid", {})).toBe("leaf");
    const calls = kernel.store.query({ limit: 1000 }).filter((e) => e.type === "call");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.traceId).toBe(calls[0]!.traceId);
    expect(calls[1]!.causationId).toBe(calls[0]!.seq);
  });
});

describe("streaming ops", () => {
  test("delivers updates then the final result, and journals each update", async () => {
    await attach(
      { id: "counter", provides: { methods: ["count"] } },
      {
        methods: {
          count: async (p, ctx) => {
            for (let i = 1; i <= p.to; i++) ctx.update({ n: i });
            return { total: p.to };
          },
        },
      },
    );
    const caller = await attach({ id: "caller", permissions: ["call:counter"] });

    const seen: number[] = [];
    const result = await caller.invoke("counter", "count", { to: 3 }, { stream: true, onUpdate: (u) => seen.push(u.n) });

    expect(seen).toEqual([1, 2, 3]);
    expect(result).toEqual({ total: 3 });
    const types = kernel.store.query({ limit: 1000 }).map((e) => e.type);
    expect(types.filter((t) => t === "op.update")).toHaveLength(3);
    expect(types).toContain("op.end");
  });

  test("turns a handler error into an op.end error", async () => {
    await attach({ id: "bad", provides: { methods: ["boom"] } }, { methods: { boom: () => Promise.reject(new Error("kaboom")) } });
    const caller = await attach({ id: "caller", permissions: ["call:bad"] });

    await expect(caller.invoke("bad", "boom", {}, { stream: true })).rejects.toThrow("kaboom");
  });
});

describe("events", () => {
  test("delivers emitted events to matching subscribers only", async () => {
    const got: string[] = [];
    await attach({ id: "listener", permissions: ["subscribe"], subscribes: ["src.task.*"] }, { onEvent: (name) => void got.push(name) });
    await attach({ id: "other", permissions: ["subscribe"], subscribes: ["nope.*"] }, { onEvent: (name) => void got.push(`other:${name}`) });
    const src = await attach({ id: "src", permissions: ["emit"] });

    await src.emit("task.sealed", { id: 1 });
    await Bun.sleep(10);
    expect(got).toEqual(["src.task.sealed"]);
  });

  test("refuses events outside the emitter's namespace", async () => {
    const src = await attach({ id: "src", permissions: ["emit"] });
    // the SDK prefixes names, so go around it to test the kernel check
    await expect((src as any).peer.request("emit", { name: "kernel.fake", data: {} })).rejects.toMatchObject({
      code: ErrorCode.PermissionDenied,
    });
  });
});

describe("entities", () => {
  test("owner can write, others need write-state plus allowWriters, schema is enforced", async () => {
    const owner = await attach({ id: "owner", provides: { kinds: ["thing"] }, allowWriters: { thing: ["helper"] }, permissions: ["read-state"] });
    await owner.entity.registerKind("thing", { type: "object", required: ["state"], properties: { state: { enum: ["a", "b"] } } });
    const helper = await attach({ id: "helper", permissions: ["write-state:owner.thing"] });
    const stranger = await attach({ id: "stranger", permissions: ["read-state"] });

    await owner.entity.upsert("owner.thing", "1", { state: "a" });
    await helper.entity.upsert("owner.thing", "2", { state: "b" });
    await expect(stranger.entity.upsert("owner.thing", "3", { state: "a" })).rejects.toMatchObject({ code: ErrorCode.PermissionDenied });
    await expect(owner.entity.upsert("owner.thing", "4", { state: "z" })).rejects.toMatchObject({ code: ErrorCode.SchemaViolation });

    const listed = await stranger.entity.list({ kind: "owner.thing", where: { state: "b" } });
    expect(listed.map((d) => d.id)).toEqual(["2"]);
  });

  test("exposes plugin state as kernel.plugin entities", async () => {
    const reader = await attach({ id: "reader", permissions: ["read-state"] });
    const doc = await reader.entity.get("kernel.plugin", "reader");
    expect(doc?.data).toMatchObject({ id: "reader", state: "running" });
  });
});

describe("approvals", () => {
  test("only another plugin with approve.decide can resolve a request", async () => {
    let pending: any = null;
    const ui = await attach(
      { id: "ui", permissions: ["approve.decide", "subscribe"], subscribes: ["kernel.approval.*"] },
      { onEvent: (name, data) => void (name === "kernel.approval.pending" && (pending = data)) },
    );
    const head = await attach({ id: "head", permissions: ["approve.request", "approve.decide"] });

    const decision = head.approval.request({ summary: "delegate X", risk: "medium" });
    for (let i = 0; i < 50 && !pending; i++) await Bun.sleep(5);
    expect(pending).toMatchObject({ requester: "head", summary: "delegate X", risk: "medium" });

    await expect(head.approval.decide(pending.approvalId, { decision: "approve" })).rejects.toMatchObject({
      code: ErrorCode.PermissionDenied,
    });
    await ui.approval.decide(pending.approvalId, { decision: "approve", note: "ok" });
    expect(await decision).toMatchObject({ decision: "approve", note: "ok" });
  });

  test("the decider can amend the request when approving", async () => {
    let pending: any = null;
    const ui = await attach(
      { id: "ui", permissions: ["approve.decide", "subscribe"], subscribes: ["kernel.approval.*"] },
      { onEvent: (name, data) => void (name === "kernel.approval.pending" && (pending = data)) },
    );
    const head = await attach({ id: "head", permissions: ["approve.request"] });
    const decision = head.approval.request({ summary: "delegate", risk: "low", payload: { harness: "local.gjc" } });
    for (let i = 0; i < 50 && !pending; i++) await Bun.sleep(5);
    await ui.approval.decide(pending.approvalId, { decision: "approve", amend: { harness: "local.claude-code" } });
    expect(await decision).toMatchObject({ decision: "approve", amend: { harness: "local.claude-code" } });
  });

  test("expired approvals resolve as rejected", async () => {
    const head = await attach({ id: "head", permissions: ["approve.request"] });
    const decision = await head.approval.request({ summary: "x", risk: "low", expiresInSec: 0.05 });
    expect(decision).toMatchObject({ decision: "reject", note: "expired" });
  });
});

describe("spawned plugins", () => {
  const fixtures = join(import.meta.dir, "fixtures");

  test("spawns a process plugin and routes calls to it", async () => {
    await kernel.spawn(manifest({ id: "echo-proc", run: { command: ["bun", join(fixtures, "echo.ts")] }, provides: { methods: ["echo"] } }));
    const caller = await attach({ id: "caller", permissions: ["call:echo-proc"] });
    expect(await caller.invoke<unknown>("echo-proc", "echo", { text: "proc" })).toEqual({ said: "proc", pid: expect.any(Number) });
  });

  test("spawn resolves even when the process can never start", async () => {
    const started = kernel.spawn(
      manifest({ id: "nope", run: { command: ["bun", "x.ts"], cwd: "does-not-exist" }, restart: { policy: "on-failure", maxRestarts: 1, windowSec: 60 } }),
    );
    const winner = await Promise.race([started.then(() => "resolved"), Bun.sleep(8_000).then(() => "hung")]);
    expect(winner).toBe("resolved");
    expect(kernel.pluginState("nope")).toBe("quarantined");
  });

  test("restarts a crashing plugin and quarantines it after maxRestarts", async () => {
    await kernel.spawn(
      manifest({
        id: "crashy",
        run: { command: ["bun", join(fixtures, "crash.ts")] },
        restart: { policy: "on-failure", maxRestarts: 2, windowSec: 60 },
      }),
    );
    for (let i = 0; i < 200 && kernel.pluginState("crashy") !== "quarantined"; i++) await Bun.sleep(25);
    expect(kernel.pluginState("crashy")).toBe("quarantined");
    const events = kernel.store.query({ limit: 1000 }).filter((e) => e.type === "event").map((e: any) => e.body.name);
    expect(events).toContain("kernel.plugin.quarantined");
  });
});
