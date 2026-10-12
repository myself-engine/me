// Secrets typed into the harness settings form. The kernel journals every call's params, so a value
// that looks secret is written here, 0600 under ~/.config/me/secrets/mcp, and only its `${file:}`
// reference is passed on to harness-config. A value typed again replaces the stored one.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { looksSecret, SECRET_DIR } from "../../harness-config/src/domain/diff.ts";

const REF = /^\$\{(env|file):[^}]+\}$|^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/;
const envName = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** Replaces secret-looking values in an upsert's env/headers with file references; writes the files. */
export function stashSecrets(name: string, server: unknown, home = homedir()): unknown {
  if (!server || typeof server !== "object" || Array.isArray(server)) return server;
  const out: Record<string, unknown> = { ...(server as Record<string, unknown>) };
  for (const field of ["env", "headers"] as const) {
    const map = out[field];
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    out[field] = Object.fromEntries(
      Object.entries(map as Record<string, unknown>).map(([k, v]) => {
        // Blank keeps the stored value (harness-config's rule); references and plain values pass through.
        if (typeof v !== "string" || v === "" || REF.test(v) || !looksSecret(k, v)) return [k, v];
        const rel = `${SECRET_DIR}/${name.replace(/[^\w.-]+/g, "_")}-${envName(k)}`;
        const path = join(home, rel);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, `${v}\n`, { mode: 0o600 });
        chmodSync(path, 0o600);
        return [k, `\${file:~/${rel}}`];
      }),
    );
  }
  return out;
}
