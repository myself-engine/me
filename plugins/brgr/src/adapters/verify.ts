// Verifier: runs a sealed diff's project checks in an isolated worktree.
// A clean local clone of the project gets the diff applied, then the
// project's own commands run there. The user's tree is never touched.
import { join } from "node:path";
import { commandsForProject, tailText } from "../domain/verify.ts";
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

/** Runs `cmd` with a timeout, killing the process when it overruns. */
export async function execWithTimeout(cmd: string[], cwd: string, timeoutMs: number): Promise<ExecResult> {
  const started = Date.now();
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
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
    async verify({ project, diff }): Promise<VerifyInfo> {
      const cfg = deps.config();
      const timeoutMs = cfg.verifyTimeoutMs ?? 600_000;
      const failed = (tail: string, cmd: string, exitCode: number): VerifyInfo => ({
        state: "error",
        commands: [{ cmd, exitCode, ms: 0, tail: tailText(tail) }],
      });
      const work = await deps.mkTemp("me-verify-").catch((err: unknown) => {
        throw new Error(`임시 디렉토리를 만들지 못했어요: ${String((err as Error)?.message ?? err)}`);
      });
      const src = join(work, "src");
      try {
        // A local clone is fast (hardlinks) and never needs the network.
        const cloned = await deps.exec(["git", "clone", "--quiet", project, src], work, timeoutMs);
        if (cloned.code !== 0) return failed(cloned.stderr.trim() || cloned.stdout.trim() || "git clone failed", "git clone", cloned.code);
        if (diff.trim()) {
          await deps.writeFile(join(work, "sealed.patch"), diff);
          const applied = await deps.exec(["git", "apply", "--whitespace=nowarn", join(work, "sealed.patch")], src, timeoutMs);
          if (applied.code !== 0)
            return failed(applied.stderr.trim() || applied.stdout.trim() || "git apply failed", "git apply", applied.code);
        }
        let scripts: Record<string, unknown> | undefined;
        try {
          const pkg = await deps.readFile(join(src, "package.json"));
          scripts = (pkg ? JSON.parse(pkg).scripts : undefined) as Record<string, unknown> | undefined;
        } catch {
          scripts = undefined;
        }
        let files: string[] = [];
        try {
          files = await deps.listDir(src);
        } catch {
          files = [];
        }
        const commands = commandsForProject(project, scripts, files, cfg.verify);
        if (!commands || commands.length === 0) return { state: "skipped", commands: [] };
        const results: VerifyInfo["commands"] = [];
        for (const cmd of commands) {
          // Config and detected script commands are plain words (`bun test`);
          // sh -c keeps PATH lookup and any arguments working without a shell port.
          const r = await deps.exec(["sh", "-c", cmd], src, timeoutMs);
          const tail = tailText(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`);
          results.push({ cmd, exitCode: r.code, ms: r.ms, tail });
        }
        return { state: results.every((r) => r.exitCode === 0) ? "passed" : "failed", commands: results };
      } finally {
        await deps.removeDir(work).catch(() => {});
      }
    },
  };
}
