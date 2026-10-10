import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifySymlink, conformanceConfig, diffVersions, loadConfig, probeTool, scanOk, scanSymlinks, type ToolVersion } from "./doctor.ts";

const v = (name: string, version: string | null): ToolVersion => ({ name, path: version ? `/bin/${name}` : null, version });

describe("diffVersions", () => {
  test("no previous snapshot means no changes", () => {
    expect(diffVersions(null, [v("gjc", "1.0.0")])).toEqual([]);
  });

  test("reports changed, appeared and disappeared tools, not unchanged ones", () => {
    const prev = [v("bun", "1.3.0"), v("gjc", "0.3.1"), v("herdr", null), v("codex", "0.9.0"), v("old", "1")];
    const next = [v("bun", "1.3.0"), v("gjc", "0.3.2"), v("herdr", "2.0.0"), v("codex", null), v("new", "5")];
    expect(diffVersions(prev, next)).toEqual([
      { name: "gjc", from: "0.3.1", to: "0.3.2" },
      { name: "herdr", from: null, to: "2.0.0" },
      { name: "codex", from: "0.9.0", to: null },
      { name: "old", from: "1", to: null },
      { name: "new", from: null, to: "5" },
    ]);
  });
});

describe("probeTool", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "me-doctor-bin-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const script = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };

  test("missing, first line of output, and fallback to the next flag", async () => {
    script("fake", 'echo ""; echo "fake 1.2.3"; echo "extra"');
    script("picky", '[ "$1" = version ] && { echo "picky v9" >&2; exit 0; }; exit 2');
    script("broken", "exit 3");
    expect(await probeTool("nope", [["--version"]], { PATH: dir })).toEqual({ name: "nope", path: null, version: null });
    expect((await probeTool("fake", [["--version"]], { PATH: dir })).version).toBe("fake 1.2.3");
    expect((await probeTool("picky", [["--version"], ["version"]], { PATH: dir })).version).toBe("picky v9");
    const b = await probeTool("broken", [["--version"]], { PATH: dir });
    expect(b.path).toBe(join(dir, "broken"));
    expect(b.version).toBeNull();
    expect(b.error).toContain("exit 3");
  });
});

describe("symlink classification", () => {
  let tmp: string;
  beforeEach(() => (tmp = mkdtempSync(join(tmpdir(), "me-doctor-links-"))));
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  test("ok, broken and outside, with tmpdir realpaths (/var → /private/var) compared correctly", () => {
    const root = join(tmp, "repo");
    const links = join(root, "node_modules", "@me");
    mkdirSync(join(root, "kernel"), { recursive: true });
    mkdirSync(links, { recursive: true });
    mkdirSync(join(tmp, "elsewhere"));
    mkdirSync(join(tmp, "repo-sibling"));
    symlinkSync("../../kernel", join(links, "kernel")); // relative, inside
    symlinkSync(join(root, "gone"), join(links, "gone")); // broken
    symlinkSync(join(tmp, "elsewhere"), join(links, "outside")); // outside
    symlinkSync(join(tmp, "repo-sibling"), join(links, "prefix")); // shares a string prefix with the root, still outside
    symlinkSync("loop", join(links, "loop")); // self-loop: broken
    mkdirSync(join(links, "real-dir")); // not a symlink: ignored

    expect(classifySymlink(join(links, "kernel"), root).status).toBe("ok");
    expect(classifySymlink(join(links, "gone"), root)).toMatchObject({ status: "broken", target: join(root, "gone") });
    expect(classifySymlink(join(links, "outside"), root).status).toBe("outside");
    expect(classifySymlink(join(links, "prefix"), root).status).toBe("outside");
    expect(classifySymlink(join(links, "outside")).status).toBe("ok"); // no expected root: only broken counts

    const scan = scanSymlinks(links, root, true);
    expect(Object.fromEntries(scan.links.map((l) => [l.path.split("/").pop(), l.status]))).toEqual({
      gone: "broken",
      kernel: "ok",
      loop: "broken",
      outside: "outside",
      prefix: "outside",
    });
    expect(scanOk(scan)).toBe(false);
  });

  test("a missing directory fails only when required", () => {
    expect(scanOk(scanSymlinks(join(tmp, "none")))).toBe(true);
    expect(scanOk(scanSymlinks(join(tmp, "none"), tmp, true))).toBe(false);
  });
});

describe("config", () => {
  let tmp: string;
  beforeEach(() => (tmp = mkdtempSync(join(tmpdir(), "me-doctor-cfg-"))));
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  test("merges me.local.json like the kernel and reads the doctor section", async () => {
    writeFileSync(
      join(tmp, "me.config.json"),
      JSON.stringify({ dataDir: "~/.me", plugins: ["plugins/a"], pluginConfig: { a: { x: 1, port: 7420 } }, doctor: { skipConformance: ["a"] } }),
    );
    writeFileSync(join(tmp, "me.local.json"), JSON.stringify({ extraPlugins: ["plugins/mcp-b"], pluginConfig: { a: { y: 2 } }, doctor: { symlinkRoots: [] } }));
    const cfg = await loadConfig(join(tmp, "me.config.json"), { ME_HOME: join(tmp, "home") });
    expect(cfg.dataDir).toBe(join(tmp, "home"));
    expect(cfg.plugins).toEqual([join(tmp, "plugins/a"), join(tmp, "plugins/mcp-b")]);
    expect(cfg.pluginConfig.a).toEqual({ x: 1, port: 7420, y: 2 });
    expect(cfg.doctor).toEqual({ skipConformance: ["a"], symlinkRoots: [] });
    expect(conformanceConfig(cfg.pluginConfig.a)).toEqual({ x: 1, port: 0, y: 2 });
  });
});
