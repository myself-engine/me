// Instruction files (AGENTS.md / CLAUDE.md). The source owns only marker-delimited blocks:
//   <!-- me:harness-config:begin <name> -->
//   ...fragment...
//   <!-- me:harness-config:end <name> -->
// Everything outside the markers is the user's and is never touched.
// Paths (checked on this machine, 2026-10-10): ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md and
// ~/.config/opencode/AGENTS.md exist (as symlinks into a dotfile stack, which FileSystem writes through).
// Uncertain: GJC had no AGENTS.md here; ~/.gjc/agent/AGENTS.md is assumed by analogy with its mcp.json.
import type { Target } from "../domain/model.ts";
import { RefusedError, type HarnessConfigFile } from "../ports/index.ts";

const begin = (name: string) => `<!-- me:harness-config:begin ${name} -->`;
const end = (name: string) => `<!-- me:harness-config:end ${name} -->`;
const BLOCK_RE = /<!-- me:harness-config:begin (\S+) -->\n?([\s\S]*?)\n?<!-- me:harness-config:end \1 -->/g;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function instructionsFile(target: Target, path: string): HarnessConfigFile<string> {
  return {
    target,
    path,
    read(text) {
      const out: Record<string, string> = {};
      for (const m of (text ?? "").matchAll(BLOCK_RE)) out[m[1]!] = m[2]!;
      return out;
    },
    render(text, change) {
      let out = text ?? "";
      for (const [name, content] of Object.entries(change.upsert)) {
        if (content.includes("<!-- me:harness-config:")) throw new RefusedError(`instruction ${name} contains a harness-config marker`);
        const block = `${begin(name)}\n${content}\n${end(name)}`;
        const re = new RegExp(`${escape(begin(name))}[\\s\\S]*?${escape(end(name))}`);
        if (re.test(out)) out = out.replace(re, () => block);
        else out = `${out.replace(/\n*$/, "")}${out.trim() ? "\n\n" : ""}${block}\n`;
      }
      for (const name of change.remove) {
        out = out.replace(new RegExp(`\\n*${escape(begin(name))}[\\s\\S]*?${escape(end(name))}\\n?`), "\n");
      }
      return out.replace(/^\n+/, "");
    },
  };
}
