// Verify gate helpers: pure functions only, no I/O.
// Picks which project checks to run for a sealed diff, before accept.

/** How many trailing chars of command output to keep on the task. */
export const TAIL_CAP = 4000;

export type PackageManager = "bun" | "pnpm" | "npm" | "yarn";

/** The repo's package manager, inferred from its lockfile. Bun is the default. */
export function packageManagerFor(files: string[]): PackageManager {
  if (files.includes("bun.lock") || files.includes("bun.lockb")) return "bun";
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  return "bun";
}

/** Script names to try, in order, when they exist in package.json. */
const SCRIPT_ORDER = ["typecheck", "lint", "test"] as const;

/**
 * Detected checks as argv (no shell needed): one [manager, "run", script]
 * entry per known script, in typecheck, lint, test order. Null when none of
 * the known scripts exist (the task then records "검사 없음").
 */
export function detectArgv(scripts: Record<string, unknown> | undefined, files: string[]): string[][] | null {
  const found = SCRIPT_ORDER.filter((n) => typeof scripts?.[n] === "string");
  if (found.length === 0) return null;
  const pm = packageManagerFor(files);
  return found.map((n) => [pm, "run", n]);
}

/**
 * Commands from package.json scripts, or null when none of the known
 * scripts exist (the task then records "검사 없음").
 */
export function detectCommands(scripts: Record<string, unknown> | undefined, files: string[]): string[] | null {
  return detectArgv(scripts, files)?.map((a) => a.join(" ")) ?? null;
}
/** A lockfile present in the tree means this install command, else null. */
export function installCommandFor(files: string[]): string[] | null {
  if (files.includes("bun.lock") || files.includes("bun.lockb")) return ["bun", "install", "--frozen-lockfile"];
  if (files.includes("pnpm-lock.yaml")) return ["pnpm", "install", "--frozen-lockfile"];
  if (files.includes("yarn.lock")) return ["yarn", "install", "--immutable"];
  if (files.includes("package-lock.json")) return ["npm", "ci"];
  return null;
}

/**
 * True when the tree has a package.json with a lockfile but no installed
 * dependencies: the verifier must install once before running checks.
 */
export function needsInstall(files: string[]): boolean {
  return files.includes("package.json") && installCommandFor(files) !== null && !files.includes("node_modules");
}

/**
 * Explicit per-project commands from pluginConfig brgr `verify`.
 * Matches the full project path first, then the repo (directory) name.
 */
export function configCommandsFor(project: string, verify: Record<string, string[]> | undefined): string[] | null {
  if (!verify) return null;
  if (verify[project] !== undefined) return verify[project];
  const name = project.split("/").filter(Boolean).pop();
  if (name && verify[name] !== undefined) return verify[name];
  return null;
}

/** Explicit config wins; otherwise fall back to detected scripts. May be null (no checks). */
export function commandsForProject(
  project: string,
  scripts: Record<string, unknown> | undefined,
  files: string[],
  verify: Record<string, string[]> | undefined,
): string[] | null {
  return configCommandsFor(project, verify) ?? detectCommands(scripts, files);
}

/** Keeps the last TAIL_CAP chars of combined command output. */
export const tailText = (s: string, cap = TAIL_CAP) => s.slice(-cap);

/** The first failing command, for the Korean reason shown to the user. */
export function firstFailure(commands: { cmd: string; exitCode: number }[]): string | null {
  return commands.find((c) => c.exitCode !== 0)?.cmd ?? null;
}
/** Where the task's own brgr worktree is, and which commit to check out, when known. */
export interface TaskWorktree {
  workspace: string | null;
  base: string | null;
}

const idOf = (e: Record<string, unknown>) =>
  typeof e.task_id === "string" ? e.task_id : typeof e.taskId === "string" ? e.taskId : typeof e.id === "string" ? e.id : null;

/** Keys holding the base commit, in new and old shapes. */
const BASE_KEYS = ["base_commit", "baseCommit", "base_sha", "baseSha", "base"] as const;

const pickBase = (o: Record<string, unknown> | null | undefined): string | null => {
  if (!o || typeof o !== "object") return null;
  for (const k of BASE_KEYS) {
    const x = o[k];
    if (typeof x === "string" && x) return x;
  }
  return null;
};

/**
 * Reads `brgr status <task> --json`: the task's own worktree (the worker's
 * result is already there) and, when the server reports it, the base commit
 * a fallback clone must check out. Unknown shapes mean "clone at HEAD".
 */
export function parseTaskStatus(text: string, taskId: string): TaskWorktree {
  const none: TaskWorktree = { workspace: null, base: null };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    // stdout may start with a non-JSON notice line; parse from the first object/array.
    const objAt = text.indexOf("{");
    const arrAt = text.indexOf("[");
    const start = objAt < 0 ? arrAt : arrAt < 0 ? objAt : Math.min(objAt, arrAt);
    if (start < 0) return none;
    try {
      v = JSON.parse(text.slice(start));
    } catch {
      return none;
    }
  }
  const matchesId = (e: Record<string, unknown>) => {
    if (idOf(e) === taskId) return true;
    const t = e.task;
    return typeof t === "object" && t !== null && idOf(t as Record<string, unknown>) === taskId;
  };
  const entry = (
    Array.isArray(v)
      ? ((v.find((e) => typeof e === "object" && e !== null && matchesId(e as Record<string, unknown>)) ?? v[0]) as unknown)
      : v
  ) as Record<string, unknown> | null;
  if (!entry || typeof entry !== "object") return none;
  const task = entry.task && typeof entry.task === "object" ? (entry.task as Record<string, unknown>) : null;
  const evidence = task?.evidence && typeof task.evidence === "object" ? (task.evidence as Record<string, unknown>) : null;
  const rawWorkspace = typeof task?.workspace === "string" && task.workspace ? task.workspace : typeof entry.workspace === "string" && entry.workspace ? entry.workspace : null;
  const gone = entry.workspace_present === false || task?.workspace_present === false;
  const workspace = gone ? null : rawWorkspace;
  const base = pickBase(evidence) ?? pickBase(task) ?? pickBase(entry) ?? null;
  return { workspace, base };
}
