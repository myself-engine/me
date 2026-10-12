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
    isAncestor: async (cwd, sha) => (await spawn([bin, "merge-base", "--is-ancestor", sha, "HEAD"], cwd)).code === 0,
    isMerge: async (cwd, sha) => {
      const r = await spawn([bin, "rev-list", "--parents", "-n", "1", sha], cwd);
      if (r.code !== 0) throw new Error((r.stderr.trim() || r.stdout.trim()).slice(0, 300));
      return r.stdout.trim().split(/\s+/).length > 2;
    },
    filesIn: async (cwd, sha) => {
      const r = await spawn([bin, "diff-tree", "--no-commit-id", "--name-only", "-r", sha], cwd);
      if (r.code !== 0) throw new Error((r.stderr.trim() || r.stdout.trim()).slice(0, 300));
      return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    },
    changedSince: async (cwd, from, to = "HEAD") => {
      const head = await git(cwd, ["rev-parse", to]);
      if (from === head.trim()) return [];
      const r = await spawn([bin, "diff", "--name-only", `${from}..${to}`], cwd);
      if (r.code !== 0) throw new Error((r.stderr.trim() || r.stdout.trim()).slice(0, 300));
      return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    },
    revert: async (cwd, sha) => {
      const r = await spawn([bin, "revert", "--no-edit", sha], cwd);
      if (r.code !== 0) throw new Error((r.stderr.trim() || r.stdout.trim()).slice(0, 300));
    },
    abortRevert: async (cwd) => {
      await spawn([bin, "revert", "--abort"], cwd);
    },
  };
}
