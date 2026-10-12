import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, install, plist, plistPath, uninstall } from "./autostart.ts";

const root = "/Users/x/dev/me";
const kernel = { argv: ["bun", "bin/me.ts", "start", "me.config.json"], cwd: root, pid: 1 };

describe("decide", () => {
  test("waits for a kernel that already runs from this repository", () => {
    expect(decide([{ paneId: "w1:p2", label: null, procs: [kernel] }], root, "me.config.json")).toEqual({ kind: "running", paneId: "w1:p2" });
  });
  test("reuses an idle pane labelled me kernel, never one running something", () => {
    const busy = { paneId: "w1:p3", label: "me kernel", procs: [{ argv: ["vim"], cwd: root, pid: 2 }] };
    const idle = { paneId: "w1:p4", label: "me kernel", procs: [{ argv: ["-zsh"], cwd: root, pid: 3 }] };
    expect(decide([busy, idle], root, "me.config.json")).toEqual({ kind: "reuse", paneId: "w1:p4" });
    expect(decide([busy], root, "me.config.json")).toEqual({ kind: "create" });
  });
  test("a kernel from another checkout or with another config does not count", () => {
    expect(decide([{ paneId: "w1:p5", label: null, procs: [{ ...kernel, cwd: "/tmp/wt" }] }], root, "me.config.json")).toEqual({ kind: "create" });
    expect(decide([{ paneId: "w1:p2", label: null, procs: [kernel] }], root, "/tmp/t/test.config.json")).toEqual({ kind: "create" });
    expect(decide([{ paneId: "w1:p2", label: null, procs: [kernel] }], root, `${root}/me.config.json`)).toEqual({ kind: "running", paneId: "w1:p2" });
  });
});

describe("launch agent", () => {
  test("runs once at login, not kept alive", () => {
    const xml = plist({ bun: "/opt/bun", root, config: "me.config.json", path: "/usr/bin", log: "/l" });
    expect(xml).toContain("<string>dev.me.autostart</string>");
    expect(xml).toContain("<string>autostart</string>");
    expect(xml).toContain("<key>RunAtLoad</key>");
    expect(xml).not.toContain("KeepAlive");
  });
  test("install and uninstall touch only the plist under the given home", () => {
    const home = mkdtempSync(join(tmpdir(), "me-autostart-"));
    const path = install({ root, config: "me.config.json", home, log: () => {} });
    expect(path).toBe(plistPath(home));
    expect(readFileSync(path, "utf8")).toContain(root);
    expect(uninstall({ home, log: () => {} })).toBe(true);
    expect(uninstall({ home, log: () => {} })).toBe(false);
  });
});
