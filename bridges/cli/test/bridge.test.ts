import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPipePair } from "@me/protocol";
import { definePlugin, type Plugin } from "@me/sdk";
import { Kernel, validateManifest } from "@me/kernel";
import { renderManifest, type CliConfig } from "../src/config.ts";
import { formatResult, runConformance } from "../../../spec/conformance/run.ts";

const bridgeMain = join(import.meta.dir, "..", "src", "main.ts");
const argvFixture = join(import.meta.dir, "fixtures", "argv.ts");

const config: CliConfig = {
  commands: {
    hello: { argv: ["echo", "hello"] },
    args: { argv: ["bun", argvFixture, "{v}"], params: { v: { type: "string", required: true } }, parse: "json" },
    count: {
      argv: ["bun", "-e", "for (let i = 1; i <= 3; i++) { console.log('line ' + i); await Bun.sleep(20) }"],
      parse: "lines",
      stream: true,
    },
    slow: { argv: ["sleep", "30"], stream: true },
  },
};

let dir: string;
let kernel: Kernel;
let caller: Plugin;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "me-cli-"));
  kernel = new Kernel({ dataDir: dir, log: () => {}, pluginConfig: { "cli-test": config as any } });
  await kernel.spawn(validateManifest(renderManifest("cli-test", config, bridgeMain), dir));
  caller = definePlugin({});
  const [k, p] = createPipePair();
  void caller.run(p);
  await kernel.attach(
    validateManifest({ id: "caller", version: "0", protocol: { min: 1, max: 1 }, run: { command: ["true"] }, permissions: ["call:cli-test"] }, dir),
    k,
  );
});

afterAll(async () => {
  await kernel.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("bridge runs a configured command through the kernel", async () => {
  expect(kernel.pluginState("cli-test")).toBe("running");
  expect(await caller.invoke<any>("cli-test", "hello", {})).toEqual({ exitCode: 0, stdout: "hello\n", stderr: "" });
  const v = "x; rm -rf / $(id)";
  expect((await caller.invoke<any>("cli-test", "args", { v })).stdout).toEqual([v]);
  await expect(caller.invoke("cli-test", "args", { v: 1 })).rejects.toThrow("must be a string");
});

test("streaming call sends each line as op.update and returns the final result", async () => {
  const updates: unknown[] = [];
  const res = await caller.invoke<any>("cli-test", "count", {}, { stream: true, onUpdate: (u) => updates.push(u) });
  expect(updates).toEqual([{ line: "line 1" }, { line: "line 2" }, { line: "line 3" }]);
  expect(res).toEqual({ exitCode: 0, stdout: ["line 1", "line 2", "line 3"], stderr: "" });
});

test("op.cancel kills the child", async () => {
  const started = Date.now();
  const { opId, done } = await caller.invokeStream("cli-test", "slow", {});
  await Bun.sleep(100);
  await caller.cancelOp(opId);
  await expect(done).rejects.toThrow("cancelled");
  expect(Date.now() - started).toBeLessThan(3_000);
});

test(
  "bridge passes the conformance suite with a sample config",
  async () => {
    const sample: CliConfig = {
      commands: {
        hello: { argv: ["echo", "hello"] },
        count: { argv: ["printf", "a\\nb\\nc\\n"], parse: "lines", stream: true },
        info: { argv: ["printf", '{"ok":true}'], parse: "json" },
        greet: { argv: ["echo", "hi", "{name}"], params: { name: { type: "string", required: true } } },
      },
    };
    const r = await runConformance(join(import.meta.dir, "fixtures", "conformance"), { config: sample as any });
    if (!r.ok) console.error(formatResult(r));
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.checks.find((c) => c.name === "stream count")?.detail).toContain("3 op.update");
  },
  60_000,
);
