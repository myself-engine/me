import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptCli } from "./cli.ts";

const repo = join(import.meta.dir, "..", "..");
let root: string;

beforeEach(() => {
  // A scratch repo root that shares the real bridges/, so generated plugins and me.local.json stay out of the worktree.
  root = mkdtempSync(join(tmpdir(), "me-adapt-cli-"));
  symlinkSync(join(repo, "bridges"), join(root, "bridges"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("adaptCli generates, probes and registers a cli plugin", async () => {
  const configFile = join(root, "tools.json");
  const commands = {
    hello: { argv: ["echo", "hello"] },
    greet: { argv: ["echo", "hi", "{name}"], params: { name: { type: "string", required: true } } },
  };
  await Bun.write(configFile, JSON.stringify({ commands }));
  await Bun.write(join(root, "me.local.json"), JSON.stringify({ extraPlugins: ["plugins/other"] }));

  const r = await adaptCli(root, "demo", configFile, { yes: true, print: () => {} });
  expect(r.pluginId).toBe("cli-demo");
  expect(r.methods).toEqual(["hello", "greet"]);
  expect(r.probe).toEqual({ exitCode: 0, stdout: "hello\n", stderr: "" });

  const manifest = await Bun.file(join(root, "plugins", "cli-demo", "plugin.json")).json();
  expect(manifest.permissions).toEqual(["shell"]);
  expect(manifest.provides.methods).toEqual(["hello", "greet"]);
  expect(manifest.run.command).toEqual(["bun", "../../bridges/cli/src/main.ts"]);

  const local = await Bun.file(join(root, "me.local.json")).json();
  expect(local.extraPlugins).toEqual(["plugins/other", "plugins/cli-demo"]);
  expect(local.pluginConfig["cli-demo"].commands).toEqual(commands);
  expect(typeof local.pluginConfig["cli-demo"].cwd).toBe("string");

  await expect(adaptCli(root, "demo", configFile, { yes: true, print: () => {} })).rejects.toThrow("already exists");
}, 30_000);

test("adaptCli only checks startup when the first command needs params", async () => {
  const configFile = join(root, "tools.json");
  await Bun.write(configFile, JSON.stringify({ commands: { greet: { argv: ["echo", "{name}"], params: { name: { type: "string", required: true } } } } }));
  const r = await adaptCli(root, "cli-needs", configFile, { yes: true, print: () => {} });
  expect(r.pluginId).toBe("cli-needs");
  expect(r.probe).toBeUndefined();
}, 30_000);

test("adaptCli rejects an invalid config without leaving a plugin behind", async () => {
  const configFile = join(root, "tools.json");
  await Bun.write(configFile, JSON.stringify({ commands: { bad: { argv: ["echo", "{undeclared}"] } } }));
  await expect(adaptCli(root, "bad", configFile, { yes: true, print: () => {} })).rejects.toThrow("undeclared param");
});

test("refuses without --yes when there is no TTY, and writes nothing", async () => {
  const configFile = join(root, "tools.json");
  await Bun.write(configFile, JSON.stringify({ commands: { hello: { argv: ["echo", "hello"] } } }));
  await expect(adaptCli(root, "nogate", configFile, { interactive: false, print: () => {} })).rejects.toThrow("not confirmed");
  expect(await Bun.file(join(root, "plugins", "cli-nogate", "plugin.json")).exists()).toBe(false);
  expect(existsSync(join(root, "plugins", "cli-bad"))).toBe(false);
  expect(existsSync(join(root, "me.local.json"))).toBe(false);
});
