// Exec mode B: plugins that connect in over the kernel's Unix socket.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPipePair, ErrorCode, takeFirstLine, type KernelPluginEntity, type Manifest } from "@me/protocol";
import { connect, definePlugin, socketTransport, type Plugin, type PluginDefinition } from "@me/sdk";
import { Kernel } from "../src/kernel.ts";
import { validateManifest } from "../src/manifest.ts";

let dir: string;
let sock: string;
let tokenPath: string;
let kernel: Kernel;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "me-sock-"));
  sock = join(dir, "kernel.sock");
  tokenPath = join(dir, "connect.token");
  kernel = new Kernel({ dataDir: dir, log: () => {} });
  await kernel.listen({ path: sock, tokenPath });
});

afterEach(async () => {
  await kernel.stop();
  rmSync(dir, { recursive: true, force: true });
});

function manifest(m: Partial<Manifest> & { id: string }): Manifest {
  return { version: "0.0.0", protocol: { min: 1, max: 1 }, run: { command: ["true"] }, permissions: [], ...m };
}

/** An in-process plugin over a pipe, for the other side of a test. */
async function attach(m: Partial<Manifest> & { id: string }, def: PluginDefinition = {}): Promise<Plugin> {
  const plugin = definePlugin(def);
  const [kSide, pSide] = createPipePair();
  void plugin.run(pSide);
  await kernel.attach(validateManifest(manifest(m), dir), kSide);
  return plugin;
}

const entity = (id: string) => kernel.store.get("kernel.plugin", id)?.data as KernelPluginEntity | undefined;

async function until(cond: () => boolean, ms = 3_000) {
  for (let t = 0; t < ms && !cond(); t += 20) await Bun.sleep(20);
  expect(cond()).toBe(true);
}

async function connectIn(m: Partial<Manifest> & { id: string }, def: PluginDefinition = {}) {
  const plugin = definePlugin(def);
  const conn = await connect({ socketPath: sock, tokenPath, manifest: manifest(m), plugin });
  await until(() => kernel.pluginState(m.id) === "running");
  return { plugin, ...conn };
}

describe("kernel socket", () => {
  test("socket and token files are 0600", () => {
    expect(statSync(sock).mode & 0o777).toBe(0o600);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  test("a connect-in plugin can be called and can emit", async () => {
    const seen: string[] = [];
    await attach({ id: "watcher", permissions: ["subscribe"], subscribes: ["remote.*"] }, { onEvent: (name) => void seen.push(name) });
    const caller = await attach({ id: "caller", permissions: ["call:remote"] });
    const { plugin: remote } = await connectIn(
      { id: "remote", permissions: ["emit"], provides: { methods: ["echo"] } },
      { methods: { echo: (p) => ({ said: p.text }) } },
    );

    expect(await caller.invoke<unknown>("remote", "echo", { text: "hi" })).toEqual({ said: "hi" });
    await remote.emit("ping", { n: 1 });
    await until(() => seen.includes("remote.ping"));

    expect(entity("remote")).toMatchObject({ state: "running", mode: "connected", pid: null });
    expect(entity("caller")?.mode).toBe("attached");
  });

  test("rejects a wrong token with a JSON-RPC error and closes", async () => {
    writeFileSync(join(dir, "bad.token"), "not-the-token");
    const attempt = connect({ socketPath: sock, tokenPath: join(dir, "bad.token"), manifest: manifest({ id: "intruder" }), plugin: {} });
    await expect(attempt).rejects.toMatchObject({ code: ErrorCode.PermissionDenied });
    expect(kernel.pluginState("intruder")).toBeNull();
  });

  test("rejects a malformed manifest and a non-hello first frame", async () => {
    const token = (await Bun.file(tokenPath).text()).trim();
    const exchange = async (frame: unknown) => {
      const raw = socketTransport(sock);
      const { first } = takeFirstLine(raw);
      const closed = new Promise<void>((r) => raw.onClose(r));
      raw.send(JSON.stringify(frame));
      const reply = JSON.parse(await first);
      await closed;
      return reply;
    };
    const bad = await exchange({ jsonrpc: "2.0", id: 0, method: "hello", params: { token, manifest: { id: "Bad Id" } } });
    expect(bad).toMatchObject({ id: 0, error: { code: -32602 } });
    const notHello = await exchange({ jsonrpc: "2.0", id: 7, method: "invoke", params: {} });
    expect(notHello).toMatchObject({ id: 7, error: { code: -32600 } });
  });

  test("rejects an id that is already registered and running", async () => {
    await attach({ id: "local" });
    await expect(connect({ socketPath: sock, tokenPath, manifest: manifest({ id: "local" }), plugin: {} })).rejects.toMatchObject({
      code: -32600,
    });
    await connectIn({ id: "remote" });
    await expect(connect({ socketPath: sock, tokenPath, manifest: manifest({ id: "remote" }), plugin: {} })).rejects.toMatchObject({
      code: -32600,
    });
    expect(kernel.pluginState("remote")).toBe("running");
  });

  test("caps permissions to the connect allowlist", async () => {
    await attach({ id: "echo", provides: { methods: ["echo"] } }, { methods: { echo: () => "x" } });
    const { plugin, grantedPermissions } = await connectIn({ id: "greedy", permissions: ["call:echo", "emit", "read-state", "journal.read"] });

    expect(grantedPermissions).toEqual(["emit", "read-state"]);
    expect(plugin.info.grantedPermissions).toEqual(["emit", "read-state"]);
    await expect(plugin.invoke("echo", "echo", {})).rejects.toMatchObject({ code: ErrorCode.PermissionDenied });
    await expect(plugin.journal({ limit: 1 })).rejects.toMatchObject({ code: ErrorCode.PermissionDenied });

    expect(entity("greedy")?.permissions).toEqual(["emit", "read-state"]);
    const accepted = kernel.store.query({ limit: 1000 }).find((e) => (e.body as any)?.connect === "accepted");
    expect(accepted?.body).toMatchObject({ pluginId: "greedy", declared: ["call:echo", "emit", "read-state", "journal.read"], granted: ["emit", "read-state"] });
  });

  test("a configured allowlist can grant more", async () => {
    await kernel.stop();
    kernel = new Kernel({ dataDir: dir, log: () => {} });
    await kernel.listen({ path: sock, tokenPath, permissions: ["call:*", "read-state"] });
    await attach({ id: "echo", provides: { methods: ["echo"] } }, { methods: { echo: () => "x" } });
    const { plugin, grantedPermissions } = await connectIn({ id: "trusted", permissions: ["call:echo", "emit"] });

    expect(grantedPermissions).toEqual(["call:echo"]);
    expect(await plugin.invoke<unknown>("echo", "echo", {})).toBe("x");
  });

  test("stops on disconnect without restarting, and reconnects under the same id", async () => {
    const caller = await attach({ id: "caller", permissions: ["call:remote"] });
    const first = await connectIn({ id: "remote", provides: { methods: ["who"] } }, { methods: { who: () => "first" } });
    expect(await caller.invoke<unknown>("remote", "who", {})).toBe("first");

    (first.plugin as any).peer.close();
    await first.done;
    await until(() => kernel.pluginState("remote") === "stopped");
    await Bun.sleep(300); // a spawned plugin would be restarting by now
    expect(kernel.pluginState("remote")).toBe("stopped");
    await expect(caller.invoke("remote", "who", {})).rejects.toMatchObject({ code: ErrorCode.TargetUnavailable });

    await connectIn({ id: "remote", provides: { methods: ["who"] } }, { methods: { who: () => "second" } });
    expect(await caller.invoke<unknown>("remote", "who", {})).toBe("second");
    expect(entity("remote")).toMatchObject({ state: "running", restarts: 0 });
  });
});
