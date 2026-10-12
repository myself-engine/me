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
 * Commands from package.json scripts, or null when none of the known
 * scripts exist (the task then records "검사 없음").
 */
export function detectCommands(scripts: Record<string, unknown> | undefined, files: string[]): string[] | null {
  const found = SCRIPT_ORDER.filter((n) => typeof scripts?.[n] === "string");
  if (found.length === 0) return null;
  const pm = packageManagerFor(files);
  return found.map((n) => `${pm} run ${n}`);
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
