// Git over the git binary.
import type { Git } from "../ports/index.ts";
import { spawn } from "./spawn.ts";

export function gitCli(bin = "git"): Git {
  const git = async (cwd: string, args: string[]) => {
    const r = await spawn([bin, ...args], cwd);
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr.trim() || r.stdout.trim()).slice(0, 300)}`);
    return r.stdout;
  };
  return {
    status: async (cwd) => (await git(cwd, ["status", "--porcelain", "--untracked-files=no"])).split("\n").filter((l) => l.trim() !== ""),
    add: async (cwd, files) => {
      // -A stages deletions too; `--` keeps paths from being read as options.
      await git(cwd, ["add", "-A", "--", ...files]);
    },
    commit: async (cwd, message) => {
      await git(cwd, ["commit", "-m", message]);
    },
    headSha: async (cwd) => (await git(cwd, ["rev-parse", "HEAD"])).trim(),
  };
}
