// The harness files this plugin knows, rooted at an explicit home directory (never implied, so tests
// cannot reach the real home by accident).
import { join } from "node:path";
import type { HarnessId, McpServer, Scope, Section, Target } from "../domain/model.ts";
import type { HarnessConfigFile } from "../ports/index.ts";
import { codexFile } from "./codex-toml.ts";
import { instructionsFile } from "./instructions.ts";
import { claudeMapping, gjcMapping, jsonMcpFile, opencodeMapping } from "./json-mcp.ts";

const t = (harness: HarnessId, section: Section, scope: Scope): Target => ({
  id: section === "instructions" ? `${harness}:instructions` : `${harness}:${scope}`,
  harness,
  section,
  scope,
});

export interface TargetPaths {
  home: string;
  /** When set, Claude Code's project-scope `.mcp.json` in this directory is managed too. */
  projectDir?: string;
}

export function harnessFiles({ home, projectDir }: TargetPaths): HarnessConfigFile<McpServer | string>[] {
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
  ];
  if (projectDir) files.splice(1, 0, jsonMcpFile(t("claude-code", "mcpServers", "project"), join(projectDir, ".mcp.json"), "mcpServers", claudeMapping));
  return files;
}
