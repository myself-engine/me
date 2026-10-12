// BrgrCli over the brgr binary. Every command carries the fixed owner session.
import type { BrgrCli } from "../ports/index.ts";
import { spawn } from "./spawn.ts";

export function brgrCli(owner: () => string, bin = "brgr"): BrgrCli {
  const brgr = (args: string[], cwd?: string) => spawn([bin, ...args, "--owner-session", owner()], cwd);
  return {
    run: (r) =>
      brgr(
        [
          "run", r.objective, "--harness", r.harness, "--criterion", r.criterion, "--capture-diff", "--deadline-seconds", String(r.deadlineSeconds),
          ...(r.model ? ["--model", r.model] : []),
          ...(r.effort ? ["--effort", r.effort] : []),
          "--json",
        ],
        r.project,
      ),
    wait: (taskId) => brgr(["wait", taskId, "--json"]),
    result: (taskId) => brgr(["result", taskId, "--json"]),
    diff: (taskId, stat) => brgr(["diff", taskId, ...(stat ? ["--stat"] : [])]),
    status: (taskId) => brgr(["status", taskId, "--json"]),
    accept: (taskId, reason) => brgr(["accept", taskId, "--reason", reason, "--json"]),
    reject: (taskId, reason) => brgr(["reject", taskId, "--reason", reason, "--json"]),
    cancel: (taskId) => brgr(["cancel", taskId, "--json"]),
    apply: (taskId, workspace) => brgr(["apply", taskId, "--workspace", workspace, "--execute", "--json"]),
  };
}
