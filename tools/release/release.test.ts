import { describe, expect, test } from "bun:test";
import { changelogEntry, findKernelPane, nextVersion, parseBump } from "./release.ts";

describe("release", () => {
  test("parseBump defaults to patch", () => {
    expect(parseBump([])).toBe("patch");
    expect(parseBump(["--patch"])).toBe("patch");
    expect(parseBump(["--dry-run"])).toBe("patch");
    expect(parseBump(["--minor"])).toBe("minor");
    expect(parseBump(["--minor", "--dry-run"])).toBe("minor");
  });

  test("version bumps", () => {
    expect(nextVersion(null, "minor")).toBe("v0.1.0");
    expect(nextVersion("v0.3.2", "minor")).toBe("v0.4.0");
    expect(nextVersion("v0.3.2", "patch")).toBe("v0.3.3");
    expect(nextVersion("junk", "patch")).toBe("v0.1.0");
  });

  test("changelog prepends newest first and drops release commits", () => {
    const first = changelogEntry("", "v0.1.0", "2026-10-11", ["feat: a (abc)", "release: v0.0.9 (def)"]);
    expect(first).toBe("# CHANGELOG\n\n## v0.1.0 (2026-10-11)\n\n- feat: a (abc)\n");
    const second = changelogEntry(first, "v0.2.0", "2026-10-12", ["fix: b (123)"]);
    expect(second.indexOf("v0.2.0")).toBeLessThan(second.indexOf("v0.1.0"));
    expect(second.match(/# CHANGELOG/g)?.length).toBe(1);
  });

  test("finds the pane running this repository's kernel only", () => {
    const panes = [
      { paneId: "a", procs: [{ argv: ["bun", "bin/me.ts", "start", "me.config.json"], cwd: "/other/me", pid: 1 }] },
      { paneId: "b", procs: [{ argv: ["bun", "src/main.ts"], cwd: "/r/plugins/web", pid: 2 }, { argv: ["bun", "bin/me.ts", "start", "me.config.json"], cwd: "/r", pid: 3 }] },
    ];
    expect(findKernelPane(panes, "/r")).toEqual({ paneId: "b", pid: 3, argv: ["bun", "bin/me.ts", "start", "me.config.json"] });
    expect(findKernelPane(panes, "/none")).toBeNull();
  });
});
