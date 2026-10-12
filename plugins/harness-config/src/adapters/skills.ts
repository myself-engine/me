// SkillStore over node:fs. Skills directories, checked read-only on this machine (2026-10-12):
//   Claude Code ~/.claude/skills, Codex ~/.codex/skills, OpenCode ~/.config/opencode/skills (itself a
//   symlink into a dotfile stack), GJC ~/.gjc/agent/skills. Most entries are symlinks into ~/.agents/skills.
// A skill entry is replaced through a temp sibling and rename, so a link swap is atomic; a real
// directory has to be removed first (rename cannot replace a non-empty directory). Removal never
// follows a link into its target. Backups go beside the skills directory, not inside it, because a
// harness would load a backed-up skill as one more skill.
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { SkillState } from "../domain/diff.ts";
import type { SkillStore } from "../ports/index.ts";

const code = (err: unknown) => (err as NodeJS.ErrnoException)?.code;
const missing = <T>(err: unknown, value: T): T => {
  if (code(err) === "ENOENT" || code(err) === "ENOTDIR") return value;
  throw err;
};

/** Hashes relative paths, kinds, exec bits, file bytes and link texts, in sorted order. */
async function hashDir(root: string): Promise<{ files: number; hash: string }> {
  const h = createHash("sha256");
  let files = 0;
  async function walk(rel: string) {
    for (const name of (await readdir(join(root, rel))).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const st = await lstat(join(root, r));
      if (st.isDirectory()) {
        h.update(`d ${r}\0`);
        await walk(r);
      } else if (st.isSymbolicLink()) {
        files++;
        h.update(`l ${r}\0${await readlink(join(root, r))}\0`);
      } else {
        files++;
        h.update(`f ${r} ${st.mode & 0o111 ? "x" : "-"}\0`);
        h.update(await readFile(join(root, r)));
        h.update("\0");
      }
    }
  }
  await walk("");
  return { files, hash: h.digest("hex") };
}

const tmpName = (dir: string, name: string) => join(dir, `.${name}.me-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
const copyOpts = { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false } as const;

export function nodeSkillStore(): SkillStore {
  const store: SkillStore = {
    async names(dir) {
      try {
        return (await readdir(dir)).filter((n) => !n.startsWith(".")).sort();
      } catch (err) {
        return missing(err, []);
      }
    },
    async inspect(path) {
      const st = await lstat(path).catch((err) => missing(err, null));
      if (!st) return null;
      if (st.isSymbolicLink()) {
        const raw = resolve(dirname(path), await readlink(path));
        return { kind: "link", target: (await store.realpath(path)) ?? raw } satisfies SkillState;
      }
      if (st.isDirectory()) return { kind: "dir", ...(await hashDir(path)) } satisfies SkillState;
      return { kind: "file" } satisfies SkillState;
    },
    async realpath(path) {
      return realpath(path).catch((err) => missing(err, null));
    },
    async backup(dir, name, suffix) {
      const from = join(dir, name);
      if (!(await lstat(from).catch((err) => missing(err, null)))) return null;
      const dest = join(`${(await store.realpath(dir)) ?? dir}.${suffix}`, name);
      await mkdir(dirname(dest), { recursive: true });
      await cp(from, dest, copyOpts);
      return dest;
    },
    async install(dir, name, source, mode) {
      await mkdir(dir, { recursive: true });
      const dest = join(dir, name);
      const tmp = tmpName(dir, name);
      try {
        if (mode === "link") await symlink(source, tmp);
        else await cp(await realpath(source), tmp, copyOpts);
        const cur = await lstat(dest).catch((err) => missing(err, null));
        if (cur?.isDirectory()) await rm(dest, { recursive: true });
        await rename(tmp, dest);
      } catch (err) {
        await rm(tmp, { recursive: true, force: true });
        throw err;
      }
    },
    async remove(dir, name) {
      await rm(join(dir, name), { recursive: true, force: true });
    },
  };
  return store;
}
