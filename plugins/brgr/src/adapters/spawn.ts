import { childEnv } from "@me/env";
import type { CliResult } from "../ports/index.ts";

export async function spawn(cmd: string[], cwd?: string, envPass: string[] = []): Promise<CliResult> {
  // git and the brgr harness CLI get the allowlist only; they read keys
  // from files by path, so the base set (PATH, HOME, SSH_AUTH_SOCK, …) is enough.
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: childEnv(envPass, {}) });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}
