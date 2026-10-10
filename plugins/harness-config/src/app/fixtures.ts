// Test fixtures: a temporary HOME with a config file for every harness. Never touches the real home.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const SECRETS = {
  notionToken: "ntn_SECRET_notion_123",
  pencilKey: "pencil-SECRET-key-456",
  existingClaudeEnv: "claude-SECRET-existing-789",
  existingAuth: "Bearer SECRET-existing-auth",
  opencodeFigma: "figma-SECRET-opencode",
};

export const CODEX_TOML = `# Codex config, hand-maintained
model = "gpt-5"  # trailing comment
approval_policy = "on-request"

[projects."/tmp/project"]
trust_level = "trusted"

# keep this note about mcp servers
[mcp_servers.pencil]
command = "old-pencil"
args = [
  "--stdio",
  "--fast",
]
enabled = true
startup_timeout_sec = 30

[mcp_servers.pencil.env]
OLD = "x"

[mcp_servers.private-codex]
command = "only-codex"
args = [
  "a",  # inline note in an array, in a table we do not own
]

# trailing table belongs to the user
[shell_environment_policy.set]
FOO = "bar"
`;

export interface Fixture {
  root: string;
  home: string;
  meHome: string;
  /** Real location of ~/.codex/config.toml (it is a symlink, as on the real machine). */
  codexReal: string;
  env: Record<string, string>;
  write(rel: string, text: string, mode?: number): string;
  cleanup(): void;
}

export function makeFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "me-harness-config-")));
  const home = join(root, "home");
  const meHome = join(root, "me-home");
  const write = (rel: string, text: string, mode = 0o600) => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
    chmodSync(p, mode);
    return p;
  };

  write(
    "home/.claude.json",
    JSON.stringify(
      {
        numStartups: 42,
        theme: "dark",
        projects: { "/tmp/project": { allowedTools: [], mcpServers: { "local-only": { type: "http", url: "https://local.example/mcp" } } } },
        mcpServers: {
          pencil: { type: "stdio", command: "old-pencil", args: [], env: { API_KEY: SECRETS.existingClaudeEnv } },
          "private-claude": { type: "http", url: "https://private.example/mcp", headers: { Authorization: SECRETS.existingAuth } },
        },
        oauthAccount: { emailAddress: "someone@example.com" },
      },
      null,
      2,
    ) + "\n",
  );
  const codexReal = write("stack/codex/config.toml", CODEX_TOML, 0o644);
  mkdirSync(join(home, ".codex"), { recursive: true });
  symlinkSync(codexReal, join(home, ".codex", "config.toml"));
  write(
    "home/.config/opencode/opencode.json",
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model: "openai/gpt-5",
        mcp: {
          pencil: { type: "local", command: ["pencil", "--stdio"], enabled: true },
          figma: { type: "local", command: ["figma-mcp"], environment: { FIGMA_API_KEY: SECRETS.opencodeFigma }, enabled: false, timeout: 5000 },
        },
        permission: { edit: "ask" },
      },
      null,
      2,
    ) + "\n",
  );
  write(
    "home/.gjc/agent/mcp.json",
    JSON.stringify(
      {
        $schema: "gjc",
        mcpServers: {
          pencil: { timeout: 1000, sharing: "per-session", type: "stdio", command: "pencil", args: ["--stdio"] },
          notion: { sharing: "per-session", timeout: 9, type: "http", url: "https://mcp.notion.com/mcp", oauth: { clientId: "id" } },
        },
      },
      null,
      2,
    ) + "\n",
  );
  write("home/.claude/CLAUDE.md", "# My global rules\n\nBe nice.\n", 0o644);
  write("home/.config/me/pencil.key", `${SECRETS.pencilKey}\n`);

  write(
    "me-home/harness-config/source.json",
    JSON.stringify(
      {
        mcpServers: {
          notion: { url: "https://mcp.notion.com/mcp", headers: { Authorization: "Bearer ${env:NOTION_TOKEN}" }, share: "all" },
          pencil: { command: "pencil", args: ["--stdio"], env: { API_KEY: "${file:~/.config/me/pencil.key}" }, share: ["claude-code", "codex"] },
        },
        instructions: { style: { file: "fragments/style.md", share: ["claude-code", "codex"] } },
      },
      null,
      2,
    ),
  );
  write("me-home/harness-config/fragments/style.md", "Prefer small commits.\nWrite tests first.\n");

  return {
    root,
    home,
    meHome,
    codexReal,
    env: { HOME: home, ME_HOME: meHome, NOTION_TOKEN: SECRETS.notionToken },
    write,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
