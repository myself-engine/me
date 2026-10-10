// FileSystem over node:fs. Writes go through symlinks (the user's dotfile stack keeps its links),
// are atomic (temp file + rename in the target's directory) and keep the target's permission bits.
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { FileSystem } from "../ports/index.ts";

const code = (err: unknown) => (err as NodeJS.ErrnoException)?.code;

/** Final path behind any symlinks; for a dangling link, the path it points to. */
async function realTarget(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (err) {
    if (code(err) !== "ENOENT") throw err;
    const l = await lstat(path).catch(() => null);
    if (l?.isSymbolicLink()) return resolve(dirname(path), await readlink(path));
    return path;
  }
}

export function nodeFileSystem(): FileSystem {
  return {
    async read(path) {
      try {
        return await readFile(path, "utf8");
      } catch (err) {
        if (code(err) === "ENOENT") return null;
        throw err;
      }
    },
    async write(path, text) {
      const real = await realTarget(path);
      const mode = await stat(real).then((s) => s.mode & 0o777, () => 0o600);
      await mkdir(dirname(real), { recursive: true });
      const tmp = `${real}.me-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
      try {
        await writeFile(tmp, text, { mode });
        await chmod(tmp, mode);
        await rename(tmp, real);
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
    },
    async backup(path, suffix) {
      const real = await realTarget(path);
      const s = await stat(real).catch(() => null);
      if (!s) return null;
      const dest = `${real}.${suffix}`;
      await copyFile(real, dest, constants.COPYFILE_EXCL);
      await chmod(dest, s.mode & 0o777);
      return dest;
    },
  };
}
