import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVerifier, execWithTimeout, type ExecResult, type VerifyAdapterDeps } from "./verify.ts";

const okExec = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "", ms: 12 });

function setup(opts: {
  files?: string[];
  packageJson?: string | null;
  exec?: (cmd: string[], cwd: string) => ExecResult;
  config?: VerifyAdapterDeps["config"];
  listDir?: (dir: string) => Promise<string[]>;
}) {
  const execCalls: { cmd: string[]; cwd: string }[] = [];
  const written: { path: string; text: string }[] = [];
  const removed: string[] = [];
  const tempDirs: string[] = [];
  const deps: VerifyAdapterDeps = {
    exec: async (cmd, cwd, _timeoutMs) => {
      execCalls.push({ cmd, cwd });
      if (opts.exec) return opts.exec(cmd, cwd);
      return okExec();
    },
    readFile: async (path) => (path.endsWith("package.json") ? (opts.packageJson ?? null) : null),
    listDir: opts.listDir ?? (async () => opts.files ?? []),
    mkTemp: async (prefix) => {
      tempDirs.push(prefix);
      return "/tmp/me-verify-test";
    },
    writeFile: async (path, text) => void written.push({ path, text }),
    removeDir: async (dir) => void removed.push(dir),
    config: opts.config ?? (() => ({})),
  };
  return { deps, execCalls, written, removed, tempDirs };
}

const shOf = (calls: { cmd: string[] }[]) =>
  calls.filter((c) => c.cmd[0] === "sh").map((c) => c.cmd.slice(2).join(" "));

describe("createVerifier", () => {
  test("clones, applies the diff, and runs detected scripts in order without a shell", async () => {
    const { deps, execCalls, written, removed } = setup({
      files: ["package.json"],
      packageJson: JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "bun test" } }),
    });
    const v = await createVerifier(deps).verify({ taskId: "t1", project: "/repo/me", diff: "diff --git a/x b/x" });
    expect(v.state).toBe("passed");
    expect(v.commands.map((c) => c.cmd)).toEqual(["bun run typecheck", "bun run test"]);
    expect(v.commands.every((c) => c.exitCode === 0 && typeof c.ms === "number")).toBe(true);
    expect(execCalls[0]!.cmd.slice(0, 2)).toEqual(["git", "clone"]);
    expect(execCalls[0]!.cmd).toContain("/repo/me");
    expect(execCalls[1]!.cmd.slice(0, 2)).toEqual(["git", "apply"]);
    // Detected checks are fixed words: no shell involved.
    expect(execCalls.slice(2).map((c) => c.cmd)).toEqual([
      ["bun", "run", "typecheck"],
      ["bun", "run", "test"],
    ]);
    expect(written.map((w) => w.path)).toContain("/tmp/me-verify-test/sealed.patch");
    expect(shOf(execCalls)).toEqual([]);
    expect(removed).toEqual(["/tmp/me-verify-test"]);
  });

  test("explicit config commands win and run through sh", async () => {
    const { deps, execCalls } = setup({
      files: ["package.json"],
      packageJson: JSON.stringify({ scripts: { test: "bun test" } }),
      config: () => ({ verify: { me: ["bun test foo.test.ts", "bunx tsc --noEmit -p ."] } }),
    });
    const v = await createVerifier(deps).verify({ taskId: "t1", project: "/repo/me", diff: "" });
    expect(v.state).toBe("passed");
    expect(shOf(execCalls)).toEqual(["bun test foo.test.ts", "bunx tsc --noEmit -p ."]);
  });

  test("a failing command fails the gate and keeps the last 4000 chars", async () => {
    const { deps } = setup({
      files: ["package.json"],
      packageJson: JSON.stringify({ scripts: { test: "bun test" } }),
      exec: (cmd) => (cmd[0] === "bun" ? { code: 1, stdout: "x".repeat(5000), stderr: "boom", ms: 3 } : okExec()),
    });
    const v = await createVerifier(deps).verify({ taskId: "t1", project: "/repo/me", diff: "" });
    expect(v.state).toBe("failed");
    expect(v.commands).toHaveLength(1);
    expect(v.commands[0]).toMatchObject({ cmd: "bun run test", exitCode: 1 });
    expect(v.commands[0]!.tail.length).toBe(4000);
    expect(v.commands[0]!.tail).toContain("boom");
  });

  test("no scripts and no config means skipped, with the temp dir still cleaned up", async () => {
    const { deps, removed } = setup({ files: [], packageJson: JSON.stringify({ scripts: { build: "tsc" } }) });
    const v = await createVerifier(deps).verify({ taskId: "t1", project: "/repo/me", diff: "" });
    expect(v).toEqual({ state: "skipped", commands: [] });
    expect(removed).toEqual(["/tmp/me-verify-test"]);
  });

  test("a clone failure is an error, not a pass or a fail", async () => {
    const { deps } = setup({ exec: (cmd) => (cmd[1] === "clone" ? { code: 128, stdout: "", stderr: "not a repo", ms: 1 } : okExec()) });
    const v = await createVerifier(deps).verify({ taskId: "t1", project: "/repo/me", diff: "" });
    expect(v.state).toBe("error");
    expect(v.commands[0]).toMatchObject({ cmd: "git clone", exitCode: 128 });
    expect(v.commands[0]!.tail).toContain("not a repo");
  });

  test("an unappliable diff is an error", async () => {
    const { deps } = setup({ exec: (cmd) => (cmd[1] === "apply" ? { code: 1, stdout: "", stderr: "patch failed", ms: 1 } : okExec()) });
    const v = await createVerifier(deps).verify({ taskId: "t1", project: "/repo/me", diff: "diff --git a/x b/x" });
    expect(v.state).toBe("error");
    expect(v.commands[0]).toMatchObject({ cmd: "git apply", exitCode: 1 });
  });

  test("a live worktree is checked in place: no clone, no patch, no temp dir", async () => {
    const { deps, execCalls, written, removed, tempDirs } = setup({
      files: ["package.json"],
      packageJson: JSON.stringify({ scripts: { test: "bun test" } }),
    });
    const v = await createVerifier(deps).verify({
      taskId: "t1",
      project: "/repo/me",
      diff: "diff --git a/x b/x",
      workspace: "/tmp/wt-1",
      base: "abc123",
    });
    expect(v.state).toBe("passed");
    expect(v.commands.map((c) => c.cmd)).toEqual(["bun run test"]);
    // The worker's result is already in the worktree: nothing to clone or apply.
    expect(execCalls.map((c) => c.cmd[0])).toEqual(["bun"]);
    expect(execCalls[0]!.cwd).toBe("/tmp/wt-1");
    expect(written).toEqual([]);
    expect(tempDirs).toEqual([]);
    expect(removed).toEqual([]);
  });

  test("a gone worktree falls back to a clone checked out at the base commit", async () => {
    const { deps, execCalls, written, removed } = setup({
      packageJson: JSON.stringify({ scripts: { test: "bun test" } }),
      listDir: async (dir) => {
        if (dir === "/tmp/wt-gone") throw new Error("no such directory");
        return ["package.json"];
      },
    });
    const v = await createVerifier(deps).verify({
      taskId: "t1",
      project: "/repo/me",
      diff: "diff --git a/x b/x",
      workspace: "/tmp/wt-gone",
      base: "abc123",
    });
    expect(v.state).toBe("passed");
    expect(execCalls[0]!.cmd.slice(0, 2)).toEqual(["git", "clone"]);
    expect(execCalls[1]!.cmd).toEqual(["git", "-C", "/tmp/me-verify-test/src", "checkout", "--quiet", "abc123"]);
    expect(execCalls[2]!.cmd.slice(0, 2)).toEqual(["git", "apply"]);
    expect(written.map((w) => w.path)).toContain("/tmp/me-verify-test/sealed.patch");
    expect(removed).toEqual(["/tmp/me-verify-test"]);
  });

  test("without a base commit the clone stays at HEAD", async () => {
    const { deps, execCalls } = setup({
      files: ["package.json"],
      packageJson: JSON.stringify({ scripts: { test: "bun test" } }),
    });
    const v = await createVerifier(deps).verify({ taskId: "t1", project: "/repo/me", diff: "" });
    expect(v.state).toBe("passed");
    expect(execCalls.map((c) => c.cmd.slice(0, 2))).toEqual([
      ["git", "clone"],
      ["bun", "run"],
    ]);
  });

  test("a bad base commit is an error", async () => {
    const { deps } = setup({
      exec: (cmd) => (cmd.includes("checkout") ? { code: 128, stdout: "", stderr: "no such commit", ms: 1 } : okExec()),
    });
    const v = await createVerifier(deps).verify({ taskId: "t1", project: "/repo/me", diff: "", base: "nope" });
    expect(v.state).toBe("error");
    expect(v.commands[0]).toMatchObject({ cmd: "git checkout", exitCode: 128 });
    expect(v.commands[0]!.tail).toContain("no such commit");
  });

  test("installs once when the lockfile is there but node_modules is not", async () => {
    const { deps, execCalls } = setup({
      files: ["package.json", "bun.lock"],
      packageJson: JSON.stringify({ scripts: { test: "bun test" } }),
    });
    const v = await createVerifier(deps).verify({ taskId: "t1", project: "/repo/me", diff: "" });
    expect(v.state).toBe("passed");
    expect(execCalls.map((c) => c.cmd)).toEqual([
      ["git", "clone", "--quiet", "/repo/me", "/tmp/me-verify-test/src"],
      ["bun", "install", "--frozen-lockfile"],
      ["bun", "run", "test"],
    ]);
    expect(v.commands.map((c) => c.cmd)).toEqual(["의존성 설치", "bun run test"]);
  });

  test("skips the install when node_modules is already there", async () => {
    const { deps, execCalls } = setup({
      files: ["package.json", "bun.lock", "node_modules"],
      packageJson: JSON.stringify({ scripts: { test: "bun test" } }),
    });
    const v = await createVerifier(deps).verify({ taskId: "t1", project: "/repo/me", diff: "" });
    expect(v.state).toBe("passed");
    expect(execCalls.map((c) => c.cmd)).toEqual([
      ["git", "clone", "--quiet", "/repo/me", "/tmp/me-verify-test/src"],
      ["bun", "run", "test"],
    ]);
    expect(v.commands.map((c) => c.cmd)).toEqual(["bun run test"]);
  });

  test("a failing install is an error with a Korean reason, not a failed gate", async () => {
    const { deps } = setup({
      files: ["package.json", "package-lock.json"],
      packageJson: JSON.stringify({ scripts: { test: "x" } }),
      exec: (cmd) => (cmd[0] === "npm" ? { code: 1, stdout: "npm ERR", stderr: "EAI_AGAIN", ms: 3 } : okExec()),
    });
    const v = await createVerifier(deps).verify({ taskId: "t1", project: "/repo/me", diff: "" });
    expect(v.state).toBe("error");
    expect(v.commands).toHaveLength(1);
    expect(v.commands[0]).toMatchObject({ cmd: "의존성 설치", exitCode: 1 });
    expect(v.commands[0]!.tail).toContain("의존성 설치에 실패했어요");
    expect(v.commands[0]!.tail).toContain("npm ci");
    expect(v.commands[0]!.tail.length).toBeLessThanOrEqual(4000);
  });

  test("real spawns: clones a tiny repo and runs its test script", async () => {
    const dir = await mkdtemp(join(tmpdir(), "me-verify-real-"));
    try {
      const repo = join(dir, "repo");
      await mkdir(repo, { recursive: true });
      await fsWriteFile(join(repo, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
      const git = (args: string[], cwd: string) => execWithTimeout(["git", ...args], cwd, 30_000);
      expect((await git(["init", "-q", repo], dir)).code).toBe(0);
      expect((await git(["add", "-A"], repo)).code).toBe(0);
      const commit = await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], repo);
      expect(commit.code).toBe(0);
      const deps: VerifyAdapterDeps = {
        exec: (cmd, cwd, ms) => execWithTimeout(cmd, cwd, ms),
        readFile: (p) => readFile(p, "utf8").catch(() => null),
        listDir: (d) => readdir(d),
        mkTemp: (prefix) => mkdtemp(join(tmpdir(), prefix)),
        writeFile: (p, t) => fsWriteFile(p, t),
        removeDir: (d) => rm(d, { recursive: true, force: true }),
        config: () => ({}),
      };
      // No lockfile, so no install runs; the `true` script passes as-is.
      const v = await createVerifier(deps).verify({ taskId: "t1", project: repo, diff: "" });
      expect(v.state).toBe("passed");
      expect(v.commands.map((c) => c.cmd)).toEqual(["bun run test"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
