import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptMcp, confirmPermissions } from "./adapt.ts";

const repo = join(import.meta.dir, "..", "..");
const fixtureServer = join(repo, "bridges", "mcp", "test", "fixture-server.ts");

describe("install-time permission gate", () => {
  test("shows permissions and highlights shell and network", async () => {
    const lines: string[] = [];
    await confirmPermissions("mcp-x", ["read-state", "shell", "network"], { yes: true, print: (l) => lines.push(l) });
    expect(lines.find((l) => l.includes("shell"))).toContain("!");
    expect(lines.find((l) => l.includes("network"))).toContain("!");
    expect(lines.find((l) => l.includes("read-state"))).not.toContain("!");
  });

  test("no TTY and no --yes ⇒ refused", async () => {
    await expect(confirmPermissions("mcp-x", ["shell"], { interactive: false, print: () => {} })).rejects.toThrow("--yes");
  });

  test("interactive: only y/yes confirms", async () => {
    const gate = (answer: string) => confirmPermissions("mcp-x", ["shell"], { interactive: true, ask: async () => answer, print: () => {} });
    await expect(gate("")).rejects.toThrow("not confirmed");
    await expect(gate("n")).rejects.toThrow("not confirmed");
    await expect(gate("Y")).resolves.toBeUndefined();
    await expect(gate("yes")).resolves.toBeUndefined();
  });
});

describe("adaptMcp", () => {
  let root: string;
  beforeEach(() => {
    // A scratch repo root that shares the real bridge, so nothing is written into this checkout.
    root = mkdtempSync(join(tmpdir(), "me-adapt-test-"));
    symlinkSync(join(repo, "bridges"), join(root, "bridges"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("refused without a TTY and without --yes: writes nothing", async () => {
    await expect(adaptMcp(root, "fixture", ["bun", fixtureServer], { interactive: false, print: () => {} })).rejects.toThrow("--yes");
    expect(existsSync(join(root, "plugins", "mcp-fixture"))).toBe(false);
    expect(existsSync(join(root, "me.local.json"))).toBe(false);
  });

  test("declined at the prompt: writes nothing", async () => {
    await expect(adaptMcp(root, "fixture", ["bun", fixtureServer], { interactive: true, ask: async () => "n", print: () => {} })).rejects.toThrow();
    expect(existsSync(join(root, "plugins", "mcp-fixture"))).toBe(false);
  });

  test(
    "with --yes: probes, passes conformance and registers",
    async () => {
      const r = await adaptMcp(root, "fixture", ["bun", fixtureServer], { yes: true, print: () => {} });
      expect(r.tools).toEqual(["add"]);
      expect(existsSync(r.manifestPath)).toBe(true);
      const local = JSON.parse(readFileSync(join(root, "me.local.json"), "utf8"));
      expect(local.extraPlugins).toEqual(["plugins/mcp-fixture"]);
      expect(local.pluginConfig["mcp-fixture"].server.command).toBe("bun");
    },
    90_000,
  );

  test(
    "conformance failure: refused, generated directory removed, nothing registered",
    async () => {
      const failing = async (dir: string) => ({
        pluginId: "mcp-fixture",
        dir,
        ok: false,
        checks: [{ name: "shutdown", ok: false, detail: "no response" }],
        stderr: [],
      });
      await expect(adaptMcp(root, "fixture", ["bun", fixtureServer], { yes: true, print: () => {}, conformance: failing })).rejects.toThrow(
        "conformance failed",
      );
      expect(existsSync(join(root, "plugins", "mcp-fixture"))).toBe(false);
      expect(existsSync(join(root, "me.local.json"))).toBe(false);
    },
    90_000,
  );

  test(
    "a server that never starts: no registration and the generated directory is removed",
    async () => {
      await expect(adaptMcp(root, "dead", ["false"], { yes: true, print: () => {} })).rejects.toThrow();
      expect(existsSync(join(root, "plugins", "mcp-dead"))).toBe(false);
      expect(existsSync(join(root, "me.local.json"))).toBe(false);
    },
    90_000,
  );
});
