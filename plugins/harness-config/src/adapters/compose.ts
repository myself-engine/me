// Wires real adapters into the service. Shared by main.ts and tools/config so both resolve paths alike.
import { isAbsolute, join, resolve } from "node:path";
import { createService } from "../app/service.ts";
import type { Events } from "../ports/index.ts";
import { nodeFileSystem } from "./fs.ts";
import { secretResolver } from "./secrets.ts";
import { nodeSkillStore } from "./skills.ts";
import { harnessFiles, skillDirs, UNSUPPORTED } from "./targets.ts";

export interface ComposeOptions {
  /** Home directory the harness files live under. Required: nothing falls back to the real home here. */
  home: string;
  /** me's data directory ($ME_HOME); source.json defaults to <meHome>/harness-config/source.json. */
  meHome: string;
  /** Overrides the source path; relative paths resolve against meHome, `~/` against home. */
  sourcePath?: string;
  /** Enables Claude Code's project `.mcp.json` target. */
  projectDir?: string;
  /** For `${env:NAME}` references. */
  env: Record<string, string | undefined>;
  events?: Events;
}

const expand = (p: string, home: string, base: string) =>
  p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : isAbsolute(p) ? p : resolve(base, p);

export function composeService(o: ComposeOptions) {
  const sourcePath = o.sourcePath ? expand(o.sourcePath, o.home, o.meHome) : join(o.meHome, "harness-config", "source.json");
  const paths = { home: o.home, projectDir: o.projectDir ? expand(o.projectDir, o.home, o.meHome) : undefined };
  return createService({
    fs: nodeFileSystem(),
    skills: nodeSkillStore(),
    clock: { now: () => new Date() },
    secrets: secretResolver(o.env, o.home),
    events: o.events,
    files: harnessFiles(paths),
    skillDirs: skillDirs(paths),
    unsupported: UNSUPPORTED,
    sourcePath,
    home: o.home,
  });
}
