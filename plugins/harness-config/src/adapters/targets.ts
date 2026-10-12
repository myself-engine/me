// The harness files this plugin knows, rooted at an explicit home directory (never implied, so tests
// cannot reach the real home by accident).
import { join } from "node:path";
import type { HarnessId, Hook, McpServer, Scope, Section, Target } from "../domain/model.ts";
import type { HarnessConfigFile, SkillsDir, Unsupported } from "../ports/index.ts";
import { codexFile } from "./codex-toml.ts";
import { instructionsFile } from "./instructions.ts";
import { jsonHooksFile } from "./json-hooks.ts";
import { claudeMapping, gjcMapping, jsonMcpFile, opencodeMapping } from "./json-mcp.ts";

const t = (harness: HarnessId, section: Section, scope: Scope = "user"): Target => ({
  id: section === "mcpServers" ? `${harness}:${scope}` : `${harness}:${section}`,
  harness,
  section,
  scope,
});

export interface TargetPaths {
  home: string;
  /** When set, Claude Code's project-scope `.mcp.json` in this directory is managed too. */
  projectDir?: string;
}

export function harnessFiles({ home, projectDir }: TargetPaths): HarnessConfigFile<McpServer | string | Hook>[] {
  const files: HarnessConfigFile<any>[] = [
    jsonMcpFile(t("claude-code", "mcpServers", "user"), join(home, ".claude.json"), "mcpServers", claudeMapping),
    // Uncertain: Codex honours $CODEX_HOME; we always use ~/.codex.
    codexFile(t("codex", "mcpServers", "user"), join(home, ".codex", "config.toml")),
    jsonMcpFile(t("opencode", "mcpServers", "user"), join(home, ".config", "opencode", "opencode.json"), "mcp", opencodeMapping),
    jsonMcpFile(t("gjc", "mcpServers", "user"), join(home, ".gjc", "agent", "mcp.json"), "mcpServers", gjcMapping),
    instructionsFile(t("claude-code", "instructions", "user"), join(home, ".claude", "CLAUDE.md")),
    instructionsFile(t("codex", "instructions", "user"), join(home, ".codex", "AGENTS.md")),
    instructionsFile(t("opencode", "instructions", "user"), join(home, ".config", "opencode", "AGENTS.md")),
    instructionsFile(t("gjc", "instructions", "user"), join(home, ".gjc", "agent", "AGENTS.md")),
    jsonHooksFile(t("claude-code", "hooks"), join(home, ".claude", "settings.json")),
    jsonHooksFile(t("codex", "hooks"), join(home, ".codex", "hooks.json")),
  ];
  if (projectDir) files.splice(1, 0, jsonMcpFile(t("claude-code", "mcpServers", "project"), join(projectDir, ".mcp.json"), "mcpServers", claudeMapping));
  return files;
}

/**
 * Skills directories. Uncertain: OpenCode documents `skills/` under its config directory and GJC also
 * reads `skills.customDirectories` from config.yml; we use the default directory each one has here.
 */
export function skillDirs({ home }: TargetPaths): SkillsDir[] {
  return [
    { target: t("claude-code", "skills"), path: join(home, ".claude", "skills") },
    { target: t("codex", "skills"), path: join(home, ".codex", "skills") },
    { target: t("opencode", "skills"), path: join(home, ".config", "opencode", "skills") },
    { target: t("gjc", "skills"), path: join(home, ".gjc", "agent", "skills") },
  ];
}

/** Sections a harness has no file format for. Items shared with them are listed as skipped, never guessed at. */
export const UNSUPPORTED: Unsupported[] = [
  { harness: "opencode", section: "hooks", reason: "OpenCode hooks are JS/TS plugins; opencode.json has no command hook entries" },
  { harness: "gjc", section: "hooks", reason: "GJC hooks are TypeScript extensions listed in config.yml; it has no command hook entries" },
];
