// Codex worktree trust seeding: keeps ~/.codex/config.toml trusting exactly
// brgr's worktree root (plus known worktrees), pruning entries for worktrees
// that no longer exist. Best effort: failures never fail a delegation.
// Claude's ~/.claude.json is deliberately untouched (see domain/trust.ts).
import { homedir } from "node:os";
import { join } from "node:path";
import type { Trust } from "../ports/index.ts";
import { ensureCodexTrust, managedTrustPaths, underWorktreeRoot, worktreeRoot } from "../domain/trust.ts";

export interface TrustFs {
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), ".codex");

/** Paths under the worktree root that no longer exist are dropped from the managed block. */
async function pruneStale(fs: TrustFs, root: string, managed: string[]): Promise<string[]> {
  const keep: string[] = [];
  for (const p of managed) {
    if (p === root || !underWorktreeRoot(p, root)) {
      keep.push(p);
      continue;
    }
    if (p !== root && (await fs.exists(p))) keep.push(p);
  }
  return keep;
}

export function fileTrust(fs: TrustFs): Trust {
  return {
    async ensure(paths: string[]) {
      const root = worktreeRoot();
      const wanted = [root, ...paths.filter((p) => underWorktreeRoot(p, root))];
      const file = join(codexHome(), "config.toml");
      const current = (await fs.readText(file)) ?? "";
      // Cheap prune: only entries the managed block already names are checked.
      const kept = await pruneStale(fs, root, managedTrustPaths(current));
      const next = ensureCodexTrust(current, [...new Set([...kept, ...wanted])]);
      if (next !== current) await fs.writeText(file, next);
    },
  };
}
