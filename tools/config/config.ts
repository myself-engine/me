// Entry points for a future `me config` command (plan / apply / import of harness configuration).
// Runs the harness-config plugin's service in-process, without a kernel. Reads me.config.json (and
// me.local.json) under `root` like `me doctor`; pluginConfig["harness-config"] supplies sourcePath
// and projectDir.
//
// There is no kernel approval here: `yes` (an explicit --yes or a TTY confirmation by the caller)
// stands in for it, like `me adapt --yes`, and the apply is recorded with a synthetic
// `cli:<timestamp>` approvalId.
import { homedir } from "node:os";
import { join } from "node:path";
import { composeService } from "../../plugins/harness-config/src/adapters/compose.ts";
import type { Plan } from "../../plugins/harness-config/src/app/service.ts";
import { loadConfig } from "../doctor/doctor.ts";

export interface ConfigOptions {
  /** Environment: HOME, ME_HOME and `${env:NAME}` references come from here. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  harnesses?: string[];
  force?: boolean;
}

async function service(root: string, env: Record<string, string | undefined>) {
  const cfg = await loadConfig(join(root, "me.config.json"), env);
  const own = cfg.pluginConfig["harness-config"] ?? {};
  return composeService({
    home: env.HOME ?? homedir(),
    meHome: cfg.dataDir,
    sourcePath: typeof own.sourcePath === "string" ? own.sourcePath : undefined,
    projectDir: typeof own.projectDir === "string" ? own.projectDir : undefined,
    env,
  });
}

export async function configPlan(root: string, opts: ConfigOptions = {}): Promise<Plan> {
  const env = opts.env ?? process.env;
  return (await service(root, env)).plan({ harnesses: opts.harnesses, force: opts.force });
}

export async function configApply(root: string, opts: ConfigOptions & { yes: boolean }) {
  const env = opts.env ?? process.env;
  const svc = await service(root, env);
  const plan = await svc.plan({ harnesses: opts.harnesses, force: opts.force });
  if (!opts.yes) return { applied: false as const, reason: "confirmation required (--yes)", plan };
  if (!plan.ok) return { applied: false as const, reason: "plan has errors", plan };
  if (plan.changes === 0) return { applied: false as const, reason: "nothing to change", plan };
  const result = await svc.apply({ planId: plan.planId, approvalId: `cli:${new Date().toISOString()}`, harnesses: opts.harnesses, force: opts.force });
  return { applied: true as const, plan, approvalId: result.approvalId, files: result.applied };
}

/** Returns the draft; writes source.draft.json only when `write` is set. */
export async function configImport(root: string, opts: ConfigOptions & { write?: boolean } = {}) {
  const env = opts.env ?? process.env;
  return (await service(root, env)).import({ write: opts.write, harnesses: opts.harnesses });
}
