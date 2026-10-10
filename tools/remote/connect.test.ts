// runRemote: an unmodified plugin on a "server" relayed to the kernel over TCP.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect as dialTcp, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPipePair, ErrorCode, type Manifest } from "@me/protocol";
import { definePlugin, type Plugin } from "@me/sdk";
import { Kernel } from "../../kernel/src/kernel.ts";
import { validateManifest } from "../../kernel/src/manifest.ts";
import { runRemote, type RemoteHandle } from "./connect.ts";

const ROOT = resolve(import.meta.dir, "../..");
const ECHO = join(ROOT, "kernel/test/fixtures/echo.ts");
const PY_ECHO = join(ROOT, "spec/conformance/fixtures/python-echo");
const python = Bun.which("python3");

let dir: string;
let tokenPath: string;
let kernel: Kernel;
let port: number;
let caller: Plugin;
const handles: RemoteHandle[] = [];
const servers: Server[] = [];

async function startKernel(p = 0) {
  kernel = new Kernel({ dataDir: join(dir, "kernel"), log: () => {} });
  ({ port } = await kernel.listenTcp({ host: "127.0.0.1", port: p, tokenPath }));
  caller = definePlugin({});
  const [kSide, pSide] = createPipePair();
  void caller.run(pSide);
  const m: Manifest = { id: "caller", version: "0", protocol: { min: 1, max: 1 }, run: { command: ["true"] }, permissions: ["call:*"] };
  await kernel.attach(validateManifest(m, dir), kSide);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "me-remote-"));
  tokenPath = join(dir, "kernel", "connect.token");
  await startKernel();
});

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.stop()));
  for (const s of servers.splice(0)) s.close();
  await kernel.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** A plugin folder on the "server": plugin.json plus, optionally, its source. */
function pluginDir(name: string, manifest: Omit<Manifest, "version" | "protocol" | "permissions"> & Partial<Manifest>, files: Record<string, string> = {}) {
  const d = join(dir, "server", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "plugin.json"), JSON.stringify({ version: "0.1.0", protocol: { min: 1, max: 1 }, permissions: [], ...manifest }));
  for (const [f, body] of Object.entries(files)) writeFileSync(join(d, f), body);
  return d;
}

async function relay(pluginDir: string, extra: Partial<Parameters<typeof runRemote>[0]> = {}) {
  const h = await runRemote({
    pluginDir,
    host: "127.0.0.1",
    port,
    tokenPath,
    dataDir: join(dir, "server-home"),
    backoff: { initialMs: 50, maxMs: 200 },
    log: () => {},
    ...extra,
  });
  handles.push(h);
  return h;
}

async function until(cond: () => boolean, ms = 10_000) {
  for (let t = 0; t < ms && !cond(); t += 25) await Bun.sleep(25);
  expect(cond()).toBe(true);
}

const echoDir = () => pluginDir("echo", { id: "echo", run: { command: ["bun", "run", ECHO] }, provides: { methods: ["echo"] } });

describe("runRemote", () => {
  test("relays an unmodified SDK plugin so the kernel can call it", async () => {
    const h = await relay(echoDir());
    await until(() => kernel.pluginState("echo") === "running");
    const res = await caller.invoke<{ said: string; pid: number }>("echo", "echo", { text: "hi" });
    expect(res.said).toBe("hi");
    expect(res.pid).toBe(h.pid!); // answered by the process the relay spawned
    const e = kernel.store.get("kernel.plugin", "echo")?.data as any;
    expect(e).toMatchObject({ mode: "connected", pid: null, remote: { address: "127.0.0.1" } });
  });

  test.skipIf(!python)("relays the plain-Python plugin, including a stream", async () => {
    await relay(PY_ECHO);
    await until(() => kernel.pluginState("python-echo") === "running");
    expect(await caller.invoke<unknown>("python-echo", "echo", { text: "py" })).toEqual({ said: "py" });
    const updates: unknown[] = [];
    const result = await caller.invoke("python-echo", "count", { n: 3 }, { stream: true, onUpdate: (u) => updates.push(u) });
    expect(updates).toHaveLength(3);
    expect(result).toEqual({ count: 3 });
  });

  test("passes the relay's config in initialize", async () => {
    const sdk = join(ROOT, "sdk/src/index.ts");
    const d = pluginDir(
      "cfg",
      { id: "cfg", run: { command: ["bun", "run", "main.ts"] }, provides: { methods: ["config"] } },
      { "main.ts": `import { definePlugin } from ${JSON.stringify(sdk)};\nconst p = definePlugin({ methods: { config: () => ({ config: p.config, id: process.env.ME_PLUGIN_ID }) } });\nawait p.run();\n` },
    );
    await relay(d, { config: { region: "seoul", n: 2 } });
    await until(() => kernel.pluginState("cfg") === "running");
    expect(await caller.invoke<unknown>("cfg", "config", {})).toEqual({ config: { region: "seoul", n: 2 }, id: "cfg" });
  });

  test("restarts the local plugin when it dies", async () => {
    const h = await relay(echoDir());
    await until(() => kernel.pluginState("echo") === "running");
    const first = h.pid!;
    process.kill(first, "SIGKILL");
    await until(() => kernel.pluginState("echo") === "stopped" || (h.pid !== null && h.pid !== first));
    await until(() => h.pid !== null && h.pid !== first && kernel.pluginState("echo") === "running");
    const res = await caller.invoke<{ pid: number }>("echo", "echo", { text: "again" });
    expect(res.pid).toBe(h.pid!);
    expect(res.pid).not.toBe(first);
  });

  test("reconnects when the network drops, keeping the plugin process", async () => {
    // A TCP proxy stands in for the tailnet so the link can be cut without stopping either end.
    const links = new Set<Socket>();
    const proxy = createServer((client) => {
      const upstream = dialTcp({ host: "127.0.0.1", port });
      links.add(client).add(upstream);
      client.pipe(upstream).pipe(client);
      const cut = () => (client.destroy(), upstream.destroy());
      client.on("error", cut).on("close", cut);
      upstream.on("error", cut).on("close", cut);
    });
    servers.push(proxy);
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const h = await relay(echoDir(), { port: (proxy.address() as { port: number }).port });
    await until(() => kernel.pluginState("echo") === "running");
    const pid = h.pid;

    for (const s of links) s.destroy();
    links.clear();
    // The stopped state can be brief, so look for it in the journal rather than polling for it.
    const sawStop = () => kernel.store.query({ limit: 1000 }).some((e) => (e.body as any)?.pluginId === "echo" && (e.body as any)?.to === "stopped");
    await until(sawStop);
    await until(() => kernel.pluginState("echo") === "running" && h.connected);
    expect((await caller.invoke<{ pid: number }>("echo", "echo", {})).pid).toBe(pid!);
  });

  test("reconnects to a restarted kernel on the same port", async () => {
    const h = await relay(echoDir());
    await until(() => kernel.pluginState("echo") === "running");
    await kernel.stop(); // sends shutdown; the relay restarts the plugin and keeps dialing
    await startKernel(port);
    await until(() => kernel.pluginState("echo") === "running");
    const res = await caller.invoke<{ said: string; pid: number }>("echo", "echo", { text: "back" });
    expect(res).toEqual({ said: "back", pid: h.pid! });
  });

  test("gives up on a bad token instead of tripping the rate limit", async () => {
    writeFileSync(join(dir, "bad.token"), "nope");
    const h = await relay(echoDir(), { tokenPath: join(dir, "bad.token") });
    await expect(h.done).rejects.toMatchObject({ code: ErrorCode.PermissionDenied });
    expect(h.pid).toBeNull();
    expect(kernel.store.query({ limit: 1000 }).filter((e) => (e.body as any)?.connect === "rejected")).toHaveLength(1);
  });
});
