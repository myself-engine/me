import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPipePair } from "@me/protocol";
import { definePlugin, type Plugin } from "@me/sdk";
import { Kernel, validateManifest } from "@me/kernel";
import { renderManifest, type HttpConfig } from "../src/config.ts";
import { formatResult, runConformance } from "../../../spec/conformance/run.ts";
import { startServer } from "./fixtures/server.ts";

const bridgeMain = join(import.meta.dir, "..", "src", "main.ts");

let server: ReturnType<typeof startServer>;
let config: HttpConfig;
let dir: string;
let kernel: Kernel;
let caller: Plugin;

beforeAll(async () => {
  server = startServer();
  config = {
    baseUrl: `http://127.0.0.1:${server.port}`,
    endpoints: {
      hello: { url: "/hello" },
      echo: { url: "/echo/{id}", params: { id: { type: "string", required: true } }, parse: "json" },
      slow: { url: "/slow" },
    },
  };
  dir = mkdtempSync(join(tmpdir(), "me-http-"));
  kernel = new Kernel({ dataDir: dir, log: () => {}, pluginConfig: { "http-test": config as any } });
  await kernel.spawn(validateManifest(renderManifest("http-test", config, bridgeMain), dir));
  caller = definePlugin({});
  const [k, p] = createPipePair();
  void caller.run(p);
  await kernel.attach(
    validateManifest({ id: "caller", version: "0", protocol: { min: 1, max: 1 }, run: { command: ["true"] }, permissions: ["call:http-test"] }, dir),
    k,
  );
});

afterAll(async () => {
  await kernel.stop();
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

test("bridge sends a configured request through the kernel", async () => {
  expect(kernel.pluginState("http-test")).toBe("running");
  expect(await caller.invoke<any>("http-test", "hello", {})).toMatchObject({ status: 200, ok: true, body: "hello\n" });
  expect((await caller.invoke<any>("http-test", "echo", { id: "x y" })).body.path).toBe("/echo/x%20y");
  await expect(caller.invoke("http-test", "echo", {})).rejects.toThrow("missing required param: id");
});

test("op.cancel aborts the request", async () => {
  const started = Date.now();
  const { opId, done } = await caller.invokeStream("http-test", "slow", {});
  await Bun.sleep(100);
  await caller.cancelOp(opId);
  await expect(done).rejects.toThrow("cancelled");
  expect(Date.now() - started).toBeLessThan(3_000);
});

test(
  "bridge passes the conformance suite with a sample config",
  async () => {
    const sample: HttpConfig = {
      baseUrl: `http://127.0.0.1:${server.port}`,
      endpoints: {
        hello: { url: "/hello" },
        info: { url: "/echo/info", parse: "json" },
        echo: { url: "/echo/{id}", params: { id: { type: "string", required: true } } },
      },
    };
    const r = await runConformance(join(import.meta.dir, "fixtures", "conformance"), { config: sample as any });
    if (!r.ok) console.error(formatResult(r));
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
  },
  60_000,
);
