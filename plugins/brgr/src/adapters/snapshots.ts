// Snapshot file collection for `brgr run --snapshot-path`: resolves
// .worktreeinclude + config patterns to project-absolute file paths.
// Never logs names or contents: matched files are often secrets (.env).
// Symlinks and paths escaping the project root are skipped.
import { join, relative, resolve, sep } from "node:path";
import type { SnapshotFiles } from "../ports/index.ts";
import { parsePatterns, toGlob, wantedBy } from "../domain/snapshot.ts";

export interface SnapshotFs {
  readText(path: string): Promise<string | null>;
  /** All file paths (project-absolute) under root, excluding .git; symlinks omitted by the implementation. */
  listFiles(root: string): Promise<string[]>;
  fileBytes(path: string): Promise<number | null>;
}

const toRel = (root: string, abs: string): string | null => {
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || resolve(root, rel) !== abs) return null;
  return rel.split(sep).join("/");
};

/** Resolves literal basenames fast, then globs for the rest; see domain/snapshot.ts for the syntax. */
async function resolvePatterns(fs: SnapshotFs, root: string, include: string[], exclude: string[]): Promise<string[]> {
  const literals = include.filter((p) => !/[*?[]/.test(p.replace(/\/+$/, "")));
  const globs = include.filter((p) => /[*?[]/.test(p.replace(/\/+$/, "")));
  const found = new Set<string>();
  for (const p of literals) {
    const { dirOnly } = toGlob(p);
    const clean = p.replace(/^\/+/, "").replace(/\/+$/, "");
    const abs = join(root, ...clean.split("/"));
    if (dirOnly) {
      for (const f of await fs.listFiles(abs).catch(() => [])) {
        const rel = toRel(root, f);
        if (rel) found.add(f);
      }
    } else if ((await fs.fileBytes(abs)) !== null) {
      found.add(abs);
    }
  }
  if (globs.length > 0 || exclude.length > 0) {
    // A full listing re-checks everything so `!` excludes also apply to literal hits.
    found.clear();
    const all = await fs.listFiles(root);
    for (const f of all) {
      const rel = toRel(root, f);
      if (!rel) continue;
      if (wantedBy(rel, [...literals, ...globs], exclude)) found.add(f);
    }
  }
  return [...found].sort();
}

export function fileSnapshots(fs: SnapshotFs): SnapshotFiles {
  return {
    async collect(project: string, patterns: string[]) {
      const text = await fs.readText(join(project, ".worktreeinclude"));
      const file = text === null ? { include: [], exclude: [] } : parsePatterns(text);
      const include = [...file.include, ...patterns];
      if (include.length === 0) return { files: [] };
      const paths = await resolvePatterns(fs, project, include, file.exclude);
      const files: { path: string; bytes: number }[] = [];
      for (const p of paths) {
        const bytes = await fs.fileBytes(p);
        if (bytes !== null) files.push({ path: p, bytes });
      }
      return { files };
    },
  };
}
