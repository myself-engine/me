import { describe, expect, test } from "bun:test";
import { createVerifier, type ExecResult, type VerifyAdapterDeps } from "./verify.ts";

const okExec = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "", ms: 12 });

function setup(opts: {
  files?: string[];
  packageJson?: string | null;
  exec?: (cmd: string[], cwd: string) => ExecResult;
  config?: VerifyAdapterDeps["config"];
}) {
  const execCalls: { cmd: string[]; cwd: string }[] = [];
  const written: { path: string; text: string }[] = [];
  const removed: string[] = [];
  const deps: VerifyAdapterDeps = {
    exec: async (cmd, cwd, _timeoutMs) => {
      execCalls.push({ cmd, cwd });
      if (opts.exec) return opts.exec(cmd, cwd);
      return okExec();
    },
    readFile: async (path) => (path.endsWith("package.json") ? (opts.packageJson ?? null) : null),
    listDir: async () => opts.files ?? [],
    mkTemp: async () => "/tmp/me-verify-test",
    writeFile: async (path, text) => void written.push({ path, text }),
    removeDir: async (dir) => void removed.push(dir),
    config: opts.config ?? (() => ({})),
  };
  return { deps, execCalls, written, removed };
}

const shOf = (calls: { cmd: string[] }[]) =>
  calls.filter((c) => c.cmd[0] === "sh").map((c) => c.cmd.slice(2).join(" "));

describe("createVerifier", () => {
  test("clones, applies the diff, and runs detected scripts in order", async () => {
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
    expect(written.map((w) => w.path)).toContain("/tmp/me-verify-test/sealed.patch");
    expect(shOf(execCalls)).toEqual(["bun run typecheck", "bun run test"]);
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
      exec: (cmd) => (cmd[0] === "sh" ? { code: 1, stdout: "x".repeat(5000), stderr: "boom", ms: 3 } : okExec()),
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
});
