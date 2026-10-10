import type { CliResult } from "../ports/index.ts";

export async function spawn(cmd: string[], cwd?: string): Promise<CliResult> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}
