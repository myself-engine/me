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

  test("delivers every delta live but journals runs of one kind as one entry", async () => {
    await attach(
      { id: "talker", provides: { methods: ["talk"] } },
      {
        methods: {
          talk: async (_p, ctx) => {
            for (const c of "abc") ctx.update({ kind: "thought_delta", delta: c });
            for (const c of "hello") ctx.update({ kind: "text_delta", delta: c });
            ctx.phase("answering");
            ctx.update({ kind: "text_delta", delta: "!" });
            ctx.update({ kind: "text_delta", delta: "?", extra: 1 });
            return "ok";
          },
        },
      },
    );
    const caller = await attach({ id: "caller", permissions: ["call:talker"] });
    const seen: any[] = [];
    await caller.invoke("talker", "talk", {}, { stream: true, onUpdate: (u) => seen.push(u) });

    expect(seen).toHaveLength(11);
    expect(seen.filter((u) => u.kind === "text_delta").map((u) => u.delta).join("")).toBe("hello!?");
    const rows = kernel.store.query({ limit: 1000 }).filter((e) => e.type === "op.update" || e.type === "op.end");
    expect(rows.map((e) => (e.type === "op.end" ? "end" : `${(e.body as any).update.kind}:${(e.body as any).update.delta ?? (e.body as any).update.phase}`))).toEqual([
      "thought_delta:abc",
      "text_delta:hello",
      "phase:answering",
      "text_delta:!",
      "text_delta:?",
      "end",
    ]);
    expect((rows[1]!.body as any).coalesced).toBe(5);
  });

  test("journals buffered deltas after the flush interval while the op is still running", async () => {
    await kernel.stop();
    kernel = new Kernel({ dataDir: dir, log: () => {}, journal: { deltaFlushMs: 30 } });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await attach(
      { id: "slow", provides: { methods: ["talk"] } },
      {
        methods: {
          talk: async (_p, ctx) => {
            ctx.update({ kind: "text_delta", delta: "a" });
            ctx.update({ kind: "text_delta", delta: "b" });
            await gate;
            return "ok";
          },
        },
      },
    );
    const caller = await attach({ id: "caller", permissions: ["call:slow"] });
    const done = caller.invoke("slow", "talk", {}, { stream: true });
    const deltas = () => kernel.store.query({ limit: 1000 }).filter((e) => e.type === "op.update").map((e) => (e.body as any).update.delta);
    await Bun.sleep(20);
    expect(deltas()).toEqual([]);
    await Bun.sleep(80);
    expect(deltas()).toEqual(["ab"]);
    release();
    await done;
    expect(deltas()).toEqual(["ab"]);
  });

  test("journals buffered deltas when the kernel stops mid-stream", async () => {
    await attach(
      { id: "hang", provides: { methods: ["talk"] } },
      {
        methods: {
          talk: async (_p, ctx) => {
            ctx.update({ kind: "text_delta", delta: "x" });
            ctx.update({ kind: "text_delta", delta: "y" });
            await new Promise(() => {});
          },
        },
      },
    );
    const caller = await attach({ id: "caller", permissions: ["call:hang"] });
    const seen: string[] = [];
    void caller.invoke("hang", "talk", {}, { stream: true, onUpdate: (u) => seen.push(u.delta) }).catch(() => {});
    for (let i = 0; i < 50 && seen.length < 2; i++) await Bun.sleep(5);
    await kernel.stop();
    kernel = new Kernel({ dataDir: dir, log: () => {} });
    const rows = kernel.store.query({ limit: 1000 }).filter((e) => e.type === "op.update");
    expect(rows.map((e) => (e.body as any).update.delta)).toEqual(["xy"]);
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

  test("an upsert with unchanged data is not journaled or announced", async () => {
    const owner = await attach({ id: "owner", provides: { kinds: ["thing"] }, permissions: ["read-state"] });
    await owner.entity.registerKind("thing", { type: "object" });
    const seen: unknown[] = [];
    await attach(
      { id: "watcher", permissions: ["subscribe"], subscribes: ["kernel.entity.changed"] },
      { onEvent: (_name, data: any) => void (data.kind === "owner.thing" && seen.push(data.updatedSeq)) },
    );
    const changes = () =>
      kernel.store.query({ limit: 1000 }).filter((e) => e.type === "event" && (e.body as any).data?.kind === "owner.thing").length;

    const first = await owner.entity.upsert("owner.thing", "1", { state: "a", n: 1 });
    const again = await owner.entity.upsert("owner.thing", "1", { state: "a", n: 1 });
    expect(again.updatedSeq).toBe(first.updatedSeq);
    expect(changes()).toBe(1);

    const changed = await owner.entity.upsert("owner.thing", "1", { state: "b", n: 1 });
    expect(changed.updatedSeq).toBeGreaterThan(first.updatedSeq);
    expect(changes()).toBe(2);
    expect((await owner.entity.get<any>("owner.thing", "1"))!.data.state).toBe("b");
    await Bun.sleep(20);
    expect(seen).toEqual([first.updatedSeq, changed.updatedSeq]);
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

describe("op state and traces", () => {
  test("streaming ops are mirrored as kernel.op with phases, and end as done", async () => {
    await attach(
      { id: "worker", provides: { methods: ["work"] } },
      {
        methods: {
          work: async (_p, ctx) => {
            ctx.phase("judging", "판정 중", 0.3);
            ctx.phase("answering", "답변 작성 중");
            return "ok";
          },
        },
      },
    );
    const caller = await attach({ id: "caller", permissions: ["call:worker", "read-state", "journal.read"] });
    await caller.invoke("worker", "work", {}, { stream: true });
    const ops = await caller.entity.list<any>({ kind: "kernel.op" });
    expect(ops).toHaveLength(1);
    expect(ops[0]!.data).toMatchObject({ caller: "caller", callee: "worker", method: "work", state: "done", phase: "answering", phaseLabel: "답변 작성 중" });
    expect(ops[0]!.data.durationMs).toBeGreaterThanOrEqual(0);
    const plugin = await caller.entity.get<any>("kernel.plugin", "worker");
    expect(plugin!.data.activeOps).toBe(0);
  });

  test("approvals appear as waiting ops until decided", async () => {
    let pending: any = null;
    const ui = await attach(
      { id: "ui", permissions: ["approve.decide", "subscribe", "read-state"], subscribes: ["kernel.approval.*"] },
      { onEvent: (name, data) => void (name === "kernel.approval.pending" && (pending = data)) },
    );
    const head = await attach({ id: "head", permissions: ["approve.request"] });
    const decision = head.approval.request({ summary: "위임할까요", risk: "low" });
    for (let i = 0; i < 50 && !pending; i++) await Bun.sleep(5);
    const waiting = await ui.entity.list<any>({ kind: "kernel.op", where: { state: "waiting" } });
    expect(waiting.map((d) => d.data)).toEqual([expect.objectContaining({ method: "approval", callee: "kernel", phaseLabel: "위임할까요" })]);
    await ui.approval.decide(pending.approvalId, { decision: "approve" });
    await decision;
    expect((await ui.entity.list<any>({ kind: "kernel.op", where: { state: "done" } })).length).toBe(1);
  });

  test("trace.get nests calls under the call that caused them, with phases and timings", async () => {
    await attach({ id: "leaf", provides: { methods: ["judge"] } }, { methods: { judge: () => 0.9 } });
    let head!: Plugin;
    head = await attach(
      { id: "head", permissions: ["call:leaf"], provides: { methods: ["send"] } },
      {
        methods: {
          send: async (_p, ctx) => {
            ctx.phase("judging", "판정 중");
            await head.invoke("leaf", "judge", {});
            ctx.phase("answering");
            return "done";
          },
        },
      },
    );
    const ui = await attach({ id: "ui", permissions: ["call:head", "journal.read"] });
    const traceId = crypto.randomUUID();
    await ui.withTrace(traceId, () => ui.invoke("head", "send", {}, { stream: true }));
    const t = await ui.getTrace(traceId);
    expect(t.nodes).toHaveLength(1);
    const root = t.nodes[0]!;
    expect(root).toMatchObject({ caller: "ui", target: "head", method: "send", stream: true, status: "ok" });
    expect(root.phases.map((p) => p.phase)).toEqual(["judging", "answering"]);
    expect(root.children.map((c) => [c.target, c.method, c.status])).toEqual([["leaf", "judge", "ok"]]);
    expect(root.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("a failing call is recorded as the plugin's lastError", async () => {
    await attach({ id: "bad", provides: { methods: ["boom"] } }, { methods: { boom: () => Promise.reject(new Error("kaboom")) } });
    const caller = await attach({ id: "caller", permissions: ["call:bad", "read-state"] });
    await expect(caller.invoke("bad", "boom", {})).rejects.toThrow("kaboom");
    const p = await caller.entity.get<any>("kernel.plugin", "bad");
    expect(p!.data.lastError).toMatchObject({ method: "boom", message: expect.stringContaining("kaboom") });
  });
});

describe("journal retention", () => {
  const fill = (n: number, ts: string) => {
    const stmt = kernel.store.db.prepare("INSERT INTO journal (ts, source, type, body) VALUES (?, 'x', 'lifecycle', '{}')");
    for (let i = 0; i < n; i++) stmt.run(ts);
  };
  const count = () => (kernel.store.db.prepare("SELECT COUNT(*) AS n FROM journal").get() as any).n as number;

  test("deletes entries older than maxAgeDays and keeps newer ones", async () => {
    await kernel.stop();
    kernel = new Kernel({ dataDir: dir, log: () => {}, journal: { maxAgeDays: 14, maxRows: 0, pruneIntervalSec: 0 } });
    const before = count();
    fill(5, new Date(Date.now() - 20 * 86_400_000).toISOString());
    fill(3, new Date(Date.now() - 86_400_000).toISOString());
    expect(kernel.pruneJournal()).toBe(5 + before);
    expect(count()).toBe(3);
  });

  test("keeps only the newest maxRows entries and prunes again at startup", async () => {
    await kernel.stop();
    kernel = new Kernel({ dataDir: dir, log: () => {}, journal: { maxAgeDays: 0, maxRows: 10, pruneIntervalSec: 0 } });
    fill(25, new Date().toISOString());
    expect(kernel.pruneJournal()).toBeGreaterThanOrEqual(15);
    expect(count()).toBe(10);
    fill(7, new Date().toISOString());
    await kernel.stop();
    kernel = new Kernel({ dataDir: dir, log: () => {}, journal: { maxAgeDays: 0, maxRows: 10, pruneIntervalSec: 0 } });
    expect(count()).toBe(10);
  });

  test("checkpoints the WAL after pruning", async () => {
    await kernel.stop();
    kernel = new Kernel({ dataDir: dir, log: () => {}, journal: { maxAgeDays: 1, maxRows: 0, pruneIntervalSec: 0 } });
    fill(2000, new Date(Date.now() - 3 * 86_400_000).toISOString());
    const wal = join(dir, "me.sqlite-wal");
    expect(Bun.file(wal).size).toBeGreaterThan(0);
    kernel.pruneJournal();
    expect(Bun.file(wal).size).toBe(0);
  });

  test("vacuums when most of the file is free after pruning", async () => {
    await kernel.stop();
    kernel = new Kernel({ dataDir: dir, log: () => {}, journal: { maxAgeDays: 1, maxRows: 0, pruneIntervalSec: 0 } });
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const stmt = kernel.store.db.prepare("INSERT INTO journal (ts, source, type, body) VALUES (?, 'x', 'lifecycle', ?)");
    kernel.store.db.transaction(() => {
      for (let i = 0; i < 30_000; i++) stmt.run(old, JSON.stringify({ pad: "x".repeat(300) }));
    })();
    kernel.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    const db = join(dir, "me.sqlite");
    expect(Bun.file(db).size).toBeGreaterThan(8 * 1024 * 1024);
    kernel.pruneJournal();
    expect(Bun.file(db).size).toBeLessThan(1024 * 1024);
  });

  test("keeps everything when both limits are off", async () => {
    await kernel.stop();
    kernel = new Kernel({ dataDir: dir, log: () => {}, journal: { maxAgeDays: 0, maxRows: 0, pruneIntervalSec: 0 } });
    fill(5, "2000-01-01T00:00:00.000Z");
    expect(kernel.pruneJournal()).toBe(0);
    expect(count()).toBeGreaterThanOrEqual(5);
  });
});
