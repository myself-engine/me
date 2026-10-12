// Project discovery for the web plugin: finding git repositories the user is
// likely to want, without typing absolute paths. Pure parts (skipping,
// worktree detection, sorting, completion matching) are tested in projects.test.ts.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** Roots scanned when the user has not configured their own. */
export const DEFAULT_PROJECT_ROOTS = ["~/dev", "~/code", "~/src", "~/Projects", "~/Developer", "~/work"];
/** Upper bound on discovered repositories per scan. */
export const DISCOVER_LIMIT = 200;
/** Upper bound on one scan, so a huge home directory never blocks the socket. */
export const DISCOVER_BUDGET_MS = 1500;
/** Upper bound on path-completion suggestions. */
export const COMPLETE_LIMIT = 20;
/** How deep below each root repositories are found (root/child and root/child/grandchild). */
export const DISCOVER_DEPTH = 2;

export interface DiscoveredProject {
  path: string;
  name: string;
  registered: boolean;
  mtime: number;
}

export interface CompletionMatch {
  path: string;
  name: string;
  isRepo: boolean;
}

export const expandProjectPath = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export const repoNameOf = (p: string) => basename(p) || p;

/** Directories never descended into or offered: hidden dots and dependency dumps. */
export const isSkippedDir = (name: string) => name.startsWith(".") || name === "node_modules";

/** True when the path lives inside a worktree container, not a repository the user would pick. */
export const pathIsInWorktreeDir = (path: string) => {
  const segs = path.split("/").filter(Boolean);
  return segs.some((s, i) => (s === ".claude" && segs[i + 1] === "worktrees") || (s === "brgr" && segs[i + 1] === "worktrees"));
};

/** True when a .git file's gitdir pointer belongs to a linked worktree, not the main checkout. */
export const isWorktreeGitdir = (content: string) => {
  const line = content.trim();
  return line.startsWith("gitdir:") && line.includes("worktrees");
};

/** Most recent activity wins; missing stamps sort last. */
export const latestActivity = (...stamps: (number | null)[]) => Math.max(0, ...stamps.filter((n): n is number => typeof n === "number"));

/** Newest first, then by name for stable ties. Pure: returns a new array. */
export function sortProjectsByActivity<T extends { path: string; mtime: number }>(xs: T[]): T[] {
  return [...xs].sort((a, b) => b.mtime - a.mtime || repoNameOf(a.path).localeCompare(repoNameOf(b.path)));
}

const mtimeOf = (p: string): number | null => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
};

/** Activity stamp for a repository checkout: the freshest of .git/HEAD and .git/index. */
export function repoActivity(_dir: string, gitPath: string, gitIsDir: boolean): number {
  // The checkout directory itself is ignored: any file write there would look like activity.
  if (gitIsDir) return latestActivity(mtimeOf(join(gitPath, "HEAD")), mtimeOf(join(gitPath, "index")), mtimeOf(gitPath));
  return latestActivity(mtimeOf(gitPath));
}

const childDirs = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !isSkippedDir(e.name))
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
};

export interface DiscoverOptions {
  roots: string[];
  registered?: Set<string>;
  limit?: number;
  budgetMs?: number;
}

/** Scans each root to depth 2 for git repositories. Synchronous and budgeted. */
export function discoverProjects(opts: DiscoverOptions): DiscoveredProject[] {
  const limit = opts.limit ?? DISCOVER_LIMIT;
  const deadline = Date.now() + (opts.budgetMs ?? DISCOVER_BUDGET_MS);
  const found: { path: string; mtime: number }[] = [];
  const seen = new Set<string>();
  const consider = (dir: string) => {
    if (pathIsInWorktreeDir(dir) || seen.has(dir)) return;
    seen.add(dir);
    const git = join(dir, ".git");
    let stat: ReturnType<typeof statSync> | null = null;
    try {
      stat = statSync(git);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      found.push({ path: dir, mtime: repoActivity(dir, git, true) });
      return;
    }
    if (stat.isFile()) {
      try {
        if (isWorktreeGitdir(readFileSync(git, "utf8"))) return;
      } catch {
        return;
      }
      found.push({ path: dir, mtime: repoActivity(dir, git, false) });
    }
  };
  for (const raw of opts.roots) {
    const root = expandProjectPath(raw);
    if (pathIsInWorktreeDir(root)) continue;
    for (const child of childDirs(root)) {
      if (Date.now() > deadline || found.length >= limit) break;
      consider(child);
      if (found.length >= limit) break;
      for (const grand of childDirs(child)) {
        if (Date.now() > deadline || found.length >= limit) break;
        consider(grand);
      }
    }
    if (Date.now() > deadline || found.length >= limit) break;
  }
  return sortProjectsByActivity(found)
    .slice(0, limit)
    .map((r) => ({ path: r.path, name: repoNameOf(r.path), registered: opts.registered?.has(r.path) ?? false, mtime: r.mtime }));
}

/** Lists subdirectories matching a partially typed path, so a manual path is completed, not typed blind. */
export function completeProjectPath(partial: string, limit = COMPLETE_LIMIT): CompletionMatch[] {
  const expanded = expandProjectPath(partial.trim());
  const dir = expanded.endsWith("/") ? expanded : expanded.includes("/") ? expanded.slice(0, expanded.lastIndexOf("/") + 1) || "/" : homedir() + "/";
  const prefix = expanded.endsWith("/") ? "" : (expanded.split("/").pop() ?? "");
  let entries: { name: string; isDir: boolean }[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return [];
  }
  const q = prefix.toLowerCase();
  return entries
    .filter((e) => e.isDir && !e.name.startsWith(".") && e.name.toLowerCase().startsWith(q))
    .map((e) => join(dir, e.name))
    .sort((a, b) => repoNameOf(a).localeCompare(repoNameOf(b)))
    .slice(0, limit)
    .map((path) => ({ path, name: repoNameOf(path), isRepo: existsSync(join(path, ".git")) }));
}
