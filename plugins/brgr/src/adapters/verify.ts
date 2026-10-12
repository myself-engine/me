// Verifier: runs a sealed diff's project checks, preferably in the task's own
// brgr worktree (the worker's result and installed dependencies are already
// there). Only when that worktree is gone does it fall back to a clean local
// clone at the task's base commit with the diff applied. Neither path touches
// the user's tree.
import { join } from "node:path";
import { childEnv } from "@me/env";
import { configCommandsFor, detectArgv, installCommandFor, needsInstall, tailText, TAIL_CAP } from "../domain/verify.ts";
import type { VerifyInfo } from "../domain/task.ts";
import type { BrgrConfig, Verifier } from "../ports/index.ts";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

export interface VerifyAdapterDeps {
  /** Runs a command with cwd and a timeout; resolves with the outcome, never throws on exit codes. */
  exec(cmd: string[], cwd: string, timeoutMs: number): Promise<ExecResult>;
  readFile(path: string): Promise<string | null>;
  listDir(dir: string): Promise<string[]>;
  mkTemp(prefix: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  removeDir(dir: string): Promise<void>;
  config: () => BrgrConfig;
}

/** The install step's command entry, so the review panel shows it in Korean. */
export const INSTALL_LABEL = "의존성 설치";

/**
 * Runs `cmd` with a timeout and an allowlisted environment, killing the
 * process when it overruns. The default env keeps the childEnv base set only,
 * so a secret in the parent's environment never leaks into a check; callers
 * pass a wider set only for names the brgr manifest allows (run.envPass).
 */
export async function execWithTimeout(
  cmd: string[],
  cwd: string,
  timeoutMs: number,
  env: Record<string, string> = childEnv(),
): Promise<ExecResult> {
  const started = Date.now();
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const killer = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // Already exited; the reads below still resolve.
      }
      reject(new Error(`timeout after ${timeoutMs}ms: ${cmd.join(" ")}`));
    }, timeoutMs);
  });
  try {
    const [stdout, stderr, code] = await Promise.race([
      Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
      killer,
    ]);
    return { code, stdout, stderr, ms: Date.now() - started };
  } catch (err) {
    // A timeout kill still leaves pipe reads behind; drain them so nothing leaks.
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]).catch(
      () => ["", ""] as const,
    );
    return { code: 124, stdout, stderr: `${stderr}\n${String((err as Error)?.message ?? err)}`.trim(), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

export function createVerifier(deps: VerifyAdapterDeps): Verifier {
  return {
    async verify({ project, diff, workspace, base }): Promise<VerifyInfo> {
      const cfg = deps.config();
      const timeoutMs = cfg.verifyTimeoutMs ?? 600_000;
      const failed = (tail: string, cmd: string, exitCode: number): VerifyInfo => ({
        state: "error",
        commands: [{ cmd, exitCode, ms: 0, tail: tailText(tail) }],
      });
      // The task's own worktree already holds the worker's result (and usually
      // its installed dependencies), so checks run there directly. Nothing is
      // applied and no tracked file is modified by the verifier itself; when a
      // check writes files that is fine, the worktree is disposable.
      let tree: string | null = null;
      if (workspace) {
        try {
          await deps.listDir(workspace);
          tree = workspace;
        } catch {
          tree = null;
        }
      }
      let work = "";
      try {
        if (!tree) {
          work = await deps.mkTemp("me-verify-").catch((err: unknown) => {
            throw new Error(`임시 디렉토리를 만들지 못했어요: ${String((err as Error)?.message ?? err)}`);
          });
          const src = join(work, "src");
          // A local clone is fast (hardlinks) and never needs the network.
          const cloned = await deps.exec(["git", "clone", "--quiet", project, src], work, timeoutMs);
          if (cloned.code !== 0) return failed(cloned.stderr.trim() || cloned.stdout.trim() || "git clone failed", "git clone", cloned.code);
          if (base) {
            const atBase = await deps.exec(["git", "-C", src, "checkout", "--quiet", base], work, timeoutMs);
            if (atBase.code !== 0)
              return failed(atBase.stderr.trim() || atBase.stdout.trim() || "git checkout failed", "git checkout", atBase.code);
          }
          if (diff.trim()) {
            await deps.writeFile(join(work, "sealed.patch"), diff);
            const applied = await deps.exec(["git", "apply", "--whitespace=nowarn", join(work, "sealed.patch")], src, timeoutMs);
            if (applied.code !== 0)
              return failed(applied.stderr.trim() || applied.stdout.trim() || "git apply failed", "git apply", applied.code);
          }
          tree = src;
        }
        let scripts: Record<string, unknown> | undefined;
        try {
          const pkg = await deps.readFile(join(tree, "package.json"));
          scripts = (pkg ? JSON.parse(pkg).scripts : undefined) as Record<string, unknown> | undefined;
        } catch {
          scripts = undefined;
        }
        let files: string[] = [];
        try {
          files = await deps.listDir(tree);
        } catch {
          files = [];
        }
        // An explicit empty list stays explicit (no checks); otherwise the
        // detected scripts run. `argv` runs directly, `null` needs a shell.
        const explicit = configCommandsFor(project, cfg.verify);
        const detected = explicit === null ? (detectArgv(scripts, files) ?? []) : [];
        const checks = (explicit ?? []).map((cmd) => ({ cmd, argv: null as string[] | null })).concat(
          detected.map((argv) => ({ cmd: argv.join(" "), argv: argv as string[] | null })),
        );
        if (checks.length === 0) return { state: "skipped", commands: [] };
        const results: VerifyInfo["commands"] = [];
        if (needsInstall(files)) {
          const install = installCommandFor(files)!;
          const r = await deps.exec(install, tree, timeoutMs);
          const out = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`;
          if (r.code !== 0) {
            const reason = `의존성 설치에 실패했어요 (${install.join(" ")})`;
            return {
              state: "error",
              commands: [{ cmd: INSTALL_LABEL, exitCode: r.code, ms: r.ms, tail: `${reason}\n${tailText(out, TAIL_CAP - reason.length - 1)}` }],
            };
          }
          results.push({ cmd: INSTALL_LABEL, exitCode: r.code, ms: r.ms, tail: tailText(out) });
        }
        for (const { cmd, argv } of checks) {
          // Explicit per-project commands are free-form shell (`bun test foo.ts`,
          // pipes, env assignments), so they run through `sh -c` for PATH lookup
          // and argument handling. Detected `manager run script` checks are fixed
          // words and run directly, without a shell.
          const r = await deps.exec(argv ?? ["sh", "-c", cmd], tree, timeoutMs);
          const tail = tailText(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`);
          results.push({ cmd, exitCode: r.code, ms: r.ms, tail });
        }
        return { state: results.every((r) => r.exitCode === 0) ? "passed" : "failed", commands: results };
      } finally {
        if (work) await deps.removeDir(work).catch(() => {});
      }
    },
  };
}
