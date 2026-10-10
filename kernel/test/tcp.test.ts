// Exec mode B over TCP: plugins on other machines (tailnet servers) connect in to the kernel.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPipePair, ErrorCode, RpcError, type KernelPluginEntity, type Manifest } from "@me/protocol";
import { connect, definePlugin, type Plugin, type PluginDefinition } from "@me/sdk";
import { isAllowedTcpHost, Kernel } from "../src/kernel.ts";
import { validateManifest } from "../src/manifest.ts";

let dir: string;
let tokenPath: string;
let kernel: Kernel;
let port: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "me-tcp-"));
  tokenPath = join(dir, "connect.token");
  kernel = new Kernel({ dataDir: dir, log: () => {} });
  ({ port } = await kernel.listenTcp({ host: "127.0.0.1", port: 0, tokenPath }));
});

afterEach(async () => {
  await kernel.stop();
  rmSync(dir, { recursive: true, force: true });
});

function manifest(m: Partial<Manifest> & { id: string }): Manifest {
  return { version: "0.0.0", protocol: { min: 1, max: 1 }, run: { command: ["true"] }, permissions: [], ...m };
}

async function attach(m: Partial<Manifest> & { id: string }, def: PluginDefinition = {}): Promise<Plugin> {
  const plugin = definePlugin(def);
  const [kSide, pSide] = createPipePair();
  void plugin.run(pSide);
  await kernel.attach(validateManifest(manifest(m), dir), kSide);
  return plugin;
}

const entity = (id: string) => kernel.store.get("kernel.plugin", id)?.data as KernelPluginEntity | undefined;
const journal = () => kernel.store.query({ limit: 1000 }).map((e) => e.body as any);

async function until(cond: () => boolean, ms = 3_000) {
  for (let t = 0; t < ms && !cond(); t += 20) await Bun.sleep(20);
  expect(cond()).toBe(true);
}

describe("kernel TCP listener", () => {
  test("a plugin connects in over 127.0.0.1, is called, and records its remote address", async () => {
    const caller = await attach({ id: "caller", permissions: ["call:remote"] });
    const plugin = definePlugin({ methods: { echo: (p) => ({ said: p.text }) } });
    const conn = await connect({
      tcp: { host: "127.0.0.1", port },
      tokenPath,
      manifest: manifest({ id: "remote", permissions: ["emit", "journal.read"], provides: { methods: ["echo"] } }),
      plugin,
    });
    await until(() => kernel.pluginState("remote") === "running");

    expect(await caller.invoke<unknown>("remote", "echo", { text: "hi" })).toEqual({ said: "hi" });
    expect(conn.grantedPermissions).toEqual(["emit"]); // remotePermissions defaults to the connect allowlist
    const e = entity("remote")!;
    expect(e).toMatchObject({ state: "running", mode: "connected", pid: null, remote: { address: "127.0.0.1" } });
    expect(e.remote!.port).toBeGreaterThan(0);
    expect(entity("caller")?.remote).toBeUndefined();
    const accepted = journal().find((b) => b?.connect === "accepted");
    expect(accepted).toMatchObject({ pluginId: "remote", remote: { address: "127.0.0.1", port: e.remote!.port } });
  });

  test("the token can be passed inline, and remotePermissions caps TCP plugins separately", async () => {
    await kernel.stop();
    kernel = new Kernel({ dataDir: dir, log: () => {} });
    ({ port } = await kernel.listenTcp({ host: "127.0.0.1", port: 0, tokenPath, permissions: ["call:*"] }));
    await attach({ id: "echo", provides: { methods: ["echo"] } }, { methods: { echo: () => "x" } });
    const token = (await Bun.file(tokenPath).text()).trim();
    const plugin = definePlugin({});
    const { grantedPermissions } = await connect({ tcp: { host: "127.0.0.1", port }, token, manifest: manifest({ id: "ops", permissions: ["call:echo", "emit"] }), plugin });
    await until(() => kernel.pluginState("ops") === "running");
    expect(grantedPermissions).toEqual(["call:echo"]);
    expect(await plugin.invoke<unknown>("echo", "echo", {})).toBe("x");
  });

  test("rejects a bad token, and drops an address after 5 failed hellos", async () => {
    writeFileSync(join(dir, "bad.token"), "not-the-token");
    const tcp = { host: "127.0.0.1", port };
    for (let i = 0; i < 5; i++) {
      const attempt = connect({ tcp, tokenPath: join(dir, "bad.token"), manifest: manifest({ id: "intruder" }), plugin: {} });
      await expect(attempt).rejects.toMatchObject({ code: ErrorCode.PermissionDenied });
    }
    expect(kernel.pluginState("intruder")).toBeNull();
    expect(journal().filter((b) => b?.connect === "rejected" && b.remote?.address === "127.0.0.1")).toHaveLength(5);
    expect(journal().find((b) => b?.connect === "rate-limited")).toMatchObject({ remote: { address: "127.0.0.1" }, forSec: 60 });

    // Even the right token is dropped without a reply while the address is banned.
    const err = await connect({ tcp, tokenPath, manifest: manifest({ id: "legit" }), plugin: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RpcError);
    expect(String(err.message)).toContain("no hello reply");
    expect(kernel.pluginState("legit")).toBeNull();

    // The Unix socket path is not rate limited by TCP failures.
    const sock = join(dir, "kernel.sock");
    await kernel.listen({ path: sock, tokenPath });
    await connect({ socketPath: sock, tokenPath, manifest: manifest({ id: "local" }), plugin: {} });
    await until(() => kernel.pluginState("local") === "running");
  });

  test("refuses to bind wildcard and non-tailnet addresses without allowAnyHost", async () => {
    const k = new Kernel({ dataDir: dir, log: () => {} });
    try {
      for (const host of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.5", "8.8.8.8", "100.128.0.1", "fd7a:115c:a1e1::1", "example.com"]) {
        await expect(k.listenTcp({ host, port: 0, tokenPath })).rejects.toThrow(/refusing to listen/);
      }
    } finally {
      await k.stop();
    }
  });

  test("host allowlist: loopback and Tailscale ranges, or anything with allowAnyHost", () => {
    for (const ok of ["127.0.0.1", "127.1.2.3", "::1", "100.64.0.1", "100.100.100.100", "100.127.255.255", "fd7a:115c:a1e0::1", "FD7A:115C:A1E0:ab12::5", "::ffff:100.101.1.2"]) {
      expect(isAllowedTcpHost(ok)).toBe(true);
    }
    for (const bad of ["0.0.0.0", "::", "100.63.255.255", "100.128.0.0", "192.168.0.1", "fd7a:115c:a1e1::1", "fe80::1", "localhost", "tailnet-mac"]) {
      expect(isAllowedTcpHost(bad)).toBe(false);
    }
    expect(isAllowedTcpHost("0.0.0.0", true)).toBe(true);
  });

});
