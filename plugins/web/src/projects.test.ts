// Tests for project discovery pure parts and the filesystem scan, using a temp dir fixture.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  completeProjectPath,
  discoverProjects,
  isSkippedDir,
  isWorktreeGitdir,
  latestActivity,
  pathIsInWorktreeDir,
  repoNameOf,
  sortProjectsByActivity,
} from "./projects.ts";

describe("project discovery helpers", () => {
  test("skips hidden dirs and node_modules, keeps the rest", () => {
    expect(isSkippedDir(".git")).toBe(true);
    expect(isSkippedDir(".claude")).toBe(true);
    expect(isSkippedDir("node_modules")).toBe(true);
    expect(isSkippedDir("me")).toBe(false);
  });
  test("detects worktree containers and gitdir pointers", () => {
    expect(pathIsInWorktreeDir("/Users/a/dev/me")).toBe(false);
    expect(pathIsInWorktreeDir("/Users/a/dev/w/.claude/worktrees/x")).toBe(true);
    expect(pathIsInWorktreeDir("/tmp/brgr/worktrees/me/abc")).toBe(true);
    expect(isWorktreeGitdir("gitdir: /elsewhere/repo/.git/worktrees/x")).toBe(true);
    expect(isWorktreeGitdir("gitdir: /elsewhere/repo/.git/modules/sub")).toBe(false);
    expect(isWorktreeGitdir("ref: refs/heads/main")).toBe(false);
  });
  test("sorts by most recent activity, ties by name", () => {
    const sorted = sortProjectsByActivity([
      { path: "/r/old", mtime: 10 },
      { path: "/r/new", mtime: 30 },
      { path: "/r/b-tie", mtime: 20 },
      { path: "/r/a-tie", mtime: 20 },
    ]).map((r) => r.path);
    expect(sorted).toEqual(["/r/new", "/r/a-tie", "/r/b-tie", "/r/old"]);
  });
  test("latestActivity ignores missing stamps", () => {
    expect(latestActivity(null, 5, null)).toBe(5);
    expect(latestActivity(null, null)).toBe(0);
  });
  test("repoNameOf uses the last segment", () => {
    expect(repoNameOf("/Users/a/dev/me")).toBe("me");
  });
});

describe("discoverProjects fixture", () => {
  const root = mkdtempSync(join(tmpdir(), "me-discover-"));
  const repo = (rel: string, mtimeMs: number, gitFile?: string) => {
    mkdirSync(join(root, rel), { recursive: true });
    const t = new Date(mtimeMs);
    if (gitFile !== undefined) {
      writeFileSync(join(root, rel, ".git"), gitFile);
      utimesSync(join(root, rel, ".git"), t, t);
    } else {
      mkdirSync(join(root, rel, ".git"), { recursive: true });
      writeFileSync(join(root, rel, ".git", "HEAD"), "ref: refs/heads/main");
      utimesSync(join(root, rel, ".git", "HEAD"), t, t);
      utimesSync(join(root, rel, ".git"), t, t);
    }
    return join(root, rel);
  };
  const oldRepo = repo("old", 1_000);
  const newRepo = repo("new", 9_000);
  repo(".hidden/repo", 8_000);
  repo("old/node_modules/nested", 7_000);
  repo("w/.claude/worktrees/x", 9_500);
  repo("linked", 9_900, "gitdir: /elsewhere/main/.git/worktrees/linked\n");
  repo("submod", 6_000, "gitdir: /elsewhere/main/.git/modules/submod\n");

  test("finds repos, skips hidden/node_modules/worktrees, sorts newest first", () => {
    const found = discoverProjects({ roots: [root], registered: new Set([oldRepo]) });
    const paths = found.map((r) => r.path);
    expect(paths).toContain(oldRepo);
    expect(paths).toContain(newRepo);
    expect(paths).toContain(join(root, "submod"));
    expect(paths.find((p) => p.includes(".hidden"))).toBeUndefined();
    expect(paths.find((p) => p.includes("node_modules"))).toBeUndefined();
    expect(paths.find((p) => p.includes(".claude/worktrees"))).toBeUndefined();
    expect(paths.find((p) => p.endsWith(`${"/"}linked`))).toBeUndefined();
    // Newest first: new (9000) before submod (6000) before old (1000).
    expect(paths.indexOf(newRepo)).toBeLessThan(paths.indexOf(join(root, "submod")));
    expect(paths.indexOf(join(root, "submod"))).toBeLessThan(paths.indexOf(oldRepo));
    expect(found.find((r) => r.path === oldRepo)?.registered).toBe(true);
    expect(found.find((r) => r.path === newRepo)?.registered).toBe(false);
    expect(found.find((r) => r.path === newRepo)).toMatchObject({ name: "new" });
  });
  test("depth 2: grandchild repos are found, deeper ones are not", () => {
    const deep = join(root, "new", "child", "grand");
    mkdirSync(deep, { recursive: true });
    expect(discoverProjects({ roots: [root] }).find((r) => r.path === deep)).toBeUndefined();
  });
  test("caps the result", () => {
    for (let i = 0; i < 5; i++) repo(`cap${i}`, 100 + i);
    expect(discoverProjects({ roots: [root], limit: 3 }).length).toBe(3);
  });
  test("complete lists matching subdirectories and marks git repos", () => {
    const matches = completeProjectPath(root + "/ne");
    expect(matches.map((m) => m.name)).toContain("new");
    expect(matches.find((m) => m.name === "new")?.isRepo).toBe(true);
    expect(completeProjectPath(root + "/zzz")).toEqual([]);
    expect(completeProjectPath(root + "/").length).toBeGreaterThan(0);
  });
  test("cleanup", () => {
    rmSync(root, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
