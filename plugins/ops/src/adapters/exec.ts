// Exec over Bun.spawn: argv only (no shell), stdin closed, killed after the timeout.
import type { Exec, ExecResult } from "../ports/index.ts";

// Generous: `ps -axo command=` on a busy machine runs to hundreds of KB.
const MAX_OUTPUT = 8 * 1024 * 1024;

export function bunExec(): Exec {
  return {
    async run(argv, timeoutMs): Promise<ExecResult> {
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      } catch (err) {
        return { code: -1, stdout: "", stderr: "", timedOut: false, spawnError: String((err as Error)?.message ?? err) };
      }
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, timeoutMs);
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout as ReadableStream).text(),
          new Response(proc.stderr as ReadableStream).text(),
          proc.exited,
        ]);
        return { code, stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, MAX_OUTPUT), timedOut, pid: proc.pid };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
