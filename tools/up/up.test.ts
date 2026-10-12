import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  binDir,
  binOnPath,
  decideBinLink,
  ensureBinLink,
  helpText,
  localUrl,
  phoneUrlFor,
  readWebPort,
  resolveWebPort,
} from "./up.ts";

describe("resolveWebPort", () => {
  const base = { pluginConfig: { web: { port: 7420 } } };
  test("me.local.json wins over the base config", () => {
    expect(resolveWebPort({ pluginConfig: { web: { port: 7520 } } }, base)).toBe(7520);
  });
  test("falls back to the base config, then 7420", () => {
    expect(resolveWebPort({}, base)).toBe(7420);
    expect(resolveWebPort(null, base)).toBe(7420);
    expect(resolveWebPort(null, null)).toBe(7420);
  });
  test("ignores invalid ports", () => {
    expect(resolveWebPort({ pluginConfig: { web: { port: "x" } } }, base)).toBe(7420);
    expect(resolveWebPort({ pluginConfig: { web: { port: 99999 } } }, base)).toBe(7420);
  });
});

describe("readWebPort", () => {
  test("reads both files from a temp root", () => {
    const root = mkdtempSync(join(tmpdir(), "me-up-port-"));
    writeFileSync(join(root, "me.config.json"), JSON.stringify({ pluginConfig: { web: { port: 7420 } } }));
    expect(readWebPort(root, "me.config.json")).toBe(7420);
    writeFileSync(join(root, "me.local.json"), JSON.stringify({ pluginConfig: { web: { port: 7531 } } }));
    expect(readWebPort(root, "me.config.json")).toBe(7531);
  });
  test("missing files mean the default", () => {
    expect(readWebPort(mkdtempSync(join(tmpdir(), "me-up-empty-")), "me.config.json")).toBe(7420);
  });
});

describe("urls", () => {
  test("localUrl", () => {
    expect(localUrl(7420)).toBe("http://127.0.0.1:7420");
  });
  test("phoneUrlFor picks the handler proxying this kernel", () => {
    const handlers = [
      { hostPort: "other.ts.net:8443", path: "/", proxy: "http://127.0.0.1:9999" },
      { hostPort: "mac.tail.ts.net:8443", path: "/", proxy: "http://127.0.0.1:7420" },
    ];
    expect(phoneUrlFor(handlers, 7420)).toBe("https://mac.tail.ts.net:8443/");
    expect(phoneUrlFor(handlers, 7520)).toBeNull();
    expect(phoneUrlFor([], 7420)).toBeNull();
  });
});

describe("first-run PATH link", () => {
  test("decideBinLink", () => {
    expect(decideBinLink("/r/bin/me.ts", "/r/bin/me.ts")).toBe("ok");
    expect(decideBinLink(null, "/r/bin/me.ts")).toBe("create");
    expect(decideBinLink("/old/bin/me.ts", "/r/bin/me.ts")).toBe("replace");
    // Someone else's `me` (a plain file or a link elsewhere) is left alone.
    expect(decideBinLink("", "/r/bin/me.ts")).toBe("keep-foreign");
    expect(decideBinLink("/opt/other/me", "/r/bin/me.ts")).toBe("keep-foreign");
  });
  test("binOnPath", () => {
    expect(binOnPath(`/usr/bin:${join("/h", ".local", "bin")}:/bin`, "/h")).toBe(true);
    expect(binOnPath("/usr/bin:/bin", "/h")).toBe(false);
    expect(binOnPath(undefined, "/h")).toBe(false);
  });
  test("ensureBinLink touches only the given temp home, and is idempotent", () => {
    const home = mkdtempSync(join(tmpdir(), "me-up-home-"));
    const root = mkdtempSync(join(tmpdir(), "me-up-root-"));
    const first = ensureBinLink(root, home);
    expect(first.changed).toBe(true);
    expect(first.path).toBe(join(binDir(home), "me"));
    expect(readlinkSync(first.path)).toBe(join(root, "bin", "me.ts"));
    expect(ensureBinLink(root, home).changed).toBe(false);
    // A stale link gets replaced.
    const other = mkdtempSync(join(tmpdir(), "me-up-other-"));
    const fixed = ensureBinLink(other, home);
    expect(fixed.changed).toBe(true);
    expect(readlinkSync(first.path)).toBe(join(other, "bin", "me.ts"));
    // A foreign program at ~/.local/bin/me is never replaced.
    const home2 = mkdtempSync(join(tmpdir(), "me-up-home-"));
    mkdirSync(binDir(home2), { recursive: true });
    writeFileSync(join(binDir(home2), "me"), "#!/bin/sh\necho other\n");
    const kept = ensureBinLink(root, home2);
    expect(kept).toMatchObject({ changed: false, foreign: true });
    expect(readFileSync(join(binDir(home2), "me"), "utf8")).toContain("echo other");
  });
});

describe("helpText", () => {
  test("covers every command in one-liners", () => {
    const h = helpText();
    for (const cmd of ["start", "adapt", "connect", "config", "tailscale", "doctor", "release", "autostart", "install", "help", "up"]) {
      expect(h).toContain(cmd);
    }
  });
});
