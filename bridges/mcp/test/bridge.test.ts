import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPipePair } from "@me/protocol";
import { definePlugin, type Plugin } from "@me/sdk";
import { Kernel, validateManifest } from "@me/kernel";

const bridgeMain = join(import.meta.dir, "..", "src", "main.ts");
const fixture = join(import.meta.dir, "fixture-server.ts");
let dir: string;
let kernel: Kernel;
let caller: Plugin;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "me-mcp-"));
  kernel = new Kernel({
    dataDir: dir,
    log: () => {},
    pluginConfig: { "mcp-fixture": { server: { command: "bun", args: [fixture] } } },
  });
  await kernel.spawn(
    validateManifest(
      {
        id: "mcp-fixture",
        version: "0.0.0",
        protocol: { min: 1, max: 1 },
        run: { command: ["bun", bridgeMain] },
        permissions: [],
        provides: { methods: ["tools.list", "tools.call", "resources.list", "resources.read"] },
      },
      dir,
    ),
  );
  caller = definePlugin({});
  const [k, p] = createPipePair();
  void caller.run(p);
  await kernel.attach(
    validateManifest({ id: "caller", version: "0", protocol: { min: 1, max: 1 }, run: { command: ["true"] }, permissions: ["call:mcp-fixture"] }, dir),
    k,
  );
});

afterAll(async () => {
  await kernel.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("bridge starts and lists the MCP server's tools", async () => {
  expect(kernel.pluginState("mcp-fixture")).toBe("running");
  const tools = await caller.invoke<{ name: string }[]>("mcp-fixture", "tools.list", {});
  expect(tools.map((t) => t.name)).toEqual(["add"]);
});

test("bridge calls a tool through the kernel", async () => {
  const res = await caller.invoke<any>("mcp-fixture", "tools.call", { name: "add", arguments: { a: 2, b: 3 } });
  expect(res.content[0].text).toBe("5");
});

test("bridge reads resources", async () => {
  const list = await caller.invoke<any[]>("mcp-fixture", "resources.list", {});
  expect(list.map((r) => r.uri)).toContain("fixture://greeting");
  const read = await caller.invoke<any>("mcp-fixture", "resources.read", { uri: "fixture://greeting" });
  expect(read.contents[0].text).toBe("hello from fixture");
});
