import { describe, expect, test } from "bun:test";
import { configListFor, matchGlob, parsePatterns, planSnapshots, toGlob, wantedBy, SNAPSHOT_CAP_BYTES } from "./snapshot.ts";

describe(".worktreeinclude patterns", () => {
  test("parse skips blanks and comments, splits negation", () => {
    expect(parsePatterns("# comment\n\n.env\n.env.local\n!*.log\n")).toEqual({ include: [".env", ".env.local"], exclude: ["*.log"] });
  });

  test("config matches full path first, then repo name", () => {
    const cfg = { "/repo": ["a"], repo: ["b"], other: ["c"] };
    expect(configListFor("/repo", cfg)).toEqual(["a"]);
    expect(configListFor("/x/repo", cfg)).toEqual(["b"]);
    expect(configListFor("/x/y", cfg)).toEqual([]);
    expect(configListFor("/x/y", undefined)).toEqual([]);
  });

  test("bare names match at any depth", () => {
    expect(toGlob(".env")).toEqual({ glob: "**/.env", dirOnly: false });
    expect(wantedBy(".env", [".env"], [])).toBe(true);
    expect(wantedBy("sub/.env", [".env"], [])).toBe(true);
    expect(wantedBy(".env.local", [".env"], [])).toBe(false);
  });

  test("stars do not cross directories, double stars do", () => {
    expect(matchGlob("**/*.key", "a.key")).toBe(true);
    expect(matchGlob("**/*.key", "sub/dir/a.key")).toBe(true);
    expect(matchGlob("*.key", "sub/a.key")).toBe(false);
    expect(matchGlob("*.key", "a.key")).toBe(true);
    // No slash in the pattern means basename match at any depth (gitignore rule).
    expect(wantedBy("sub/a.key", ["*.key"], [])).toBe(true);
    expect(wantedBy("sub/a.key", ["sub/*.key"], [])).toBe(true);
    expect(wantedBy("sub/a.key", ["**/*.key"], [])).toBe(true);
  });

  test("trailing slash matches the directory and everything beneath", () => {
    expect(wantedBy("certs", ["certs/"], [])).toBe(true);
    expect(wantedBy("certs/a.pem", ["certs/"], [])).toBe(true);
    expect(wantedBy("other/a.pem", ["certs/"], [])).toBe(false);
  });

  test("negation deselects", () => {
    expect(wantedBy(".env.local", [".env*"], ["*.local"])).toBe(false);
    expect(wantedBy(".env", [".env*"], ["*.local"])).toBe(true);
    expect(wantedBy("a.log", ["*.log"], ["*.log"])).toBe(false);
  });

  test("cap rejects over-large snapshots", () => {
    expect(planSnapshots([{ path: "/p/.env", bytes: 10 }])).toEqual({ paths: ["/p/.env"], totalBytes: 10 });
    expect(planSnapshots([])).toEqual({ paths: [], totalBytes: 0 });
    expect(planSnapshots([{ path: "/p/big", bytes: SNAPSHOT_CAP_BYTES + 1 }])).toBeNull();
  });
});
