// SecretResolver for `${env:NAME}` and `${file:path}` (path may start with `~/`; file content is
// trimmed of its trailing newline). Errors name the reference, never a value.
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { REF_RE } from "../domain/diff.ts";
import type { SecretResolver } from "../ports/index.ts";

export function secretResolver(env: Record<string, string | undefined>, home: string): SecretResolver {
  const filePath = (p: string) => (p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : isAbsolute(p) ? p : join(home, p));
  return {
    async resolve(value) {
      const refs = [...value.matchAll(new RegExp(REF_RE.source, "g"))];
      if (refs.length === 0) return value;
      const values: string[] = [];
      for (const [whole, kind, name] of refs) {
        if (kind === "env") {
          const v = env[name!];
          if (v === undefined) throw new Error(`${whole}: environment variable is not set`);
          values.push(v);
        } else {
          try {
            values.push((await readFile(filePath(name!), "utf8")).replace(/\r?\n$/, ""));
          } catch {
            throw new Error(`${whole}: file cannot be read`);
          }
        }
      }
      let i = 0;
      return value.replace(new RegExp(REF_RE.source, "g"), () => values[i++]!);
    },
  };
}
