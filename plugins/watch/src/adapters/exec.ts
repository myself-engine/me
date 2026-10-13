import type { HerdrAgent } from "../ports/index.ts";
import { childEnv } from "@me/env";

const MAX_OUTPUT = 1_000_000;

/** Executes only read-only Herdr and brgr status/read commands, without a shell. */
export function commandExec(bin: string): HerdrAgent {
  return {
    async exec(args, timeoutMs) {
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: childEnv() });
      } catch (error) {
        return { code: -1, stdout: "", stderr: String((error as Error)?.message ?? error) };
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
        return {
          code: timedOut ? -1 : code,
          stdout: stdout.slice(0, MAX_OUTPUT),
          stderr: timedOut ? "command timed out" : stderr.slice(0, MAX_OUTPUT),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
