# me — rules for agents working in this repository

Every agent (Claude Code, Codex, GJC, brgr workers) follows these rules. Read `docs/DECISIONS.md` for what was decided and why, `docs/PROTOCOL.md` for the plugin contract, and `docs/DONE.md` for when work counts as finished.

## Never
- Never stop, restart, or send signals to the user's running me: the kernel on `127.0.0.1:7420` started from `~/dev/me` with data in `~/.me`, and the remote relay `me-ops-rapi` on rapi-agent.
- Never kill processes by pattern (`pkill -f`, `killall`). Stop only processes you started, by the PID you recorded when you started them.
- Never run tests or a dev kernel against `~/.me` or on ports 7420/7421. Use a temporary `ME_HOME` and other ports (see below).
- Never commit, push, merge, tag, or publish unless the task explicitly says so. Leave changes in your worktree.
- Never put secrets in files or logs. Keys are read from files under `~/.config/me/secrets/` by path. Never print their contents.
- Never use Anthropic/Claude models inside GJC (ToS). Claude work goes to the `local.claude-code` harness.
- The head never edits code: GJC runs with `--no-mcp` and no tools; keep it that way.
- Never copy code from gajae-way (AGPL). Its documents and behaviour may be used as reference.

## Running a test kernel
- Start it from your worktree: `ME_HOME=$(mktemp -d) bun bin/me.ts start me.config.json` with a `me.local.json` in the worktree that sets a free web port (e.g. 7520+), `"socket": false`, `"tcp": false`, and removes `plugins/brgr` unless the task needs real delegation.
- Record the PID you start; stop only that PID; delete the temp `ME_HOME` afterwards.
- `bun run e2e` already does all of this for the standard flows; prefer it.

## Layout
- `kernel/`: domain-free core (supervisor, router, journal, entities, permissions, approvals, ops, traces). It must not learn domain words.
- `protocol/`: public types. The source of truth is `spec/protocol.schema.json`. Change both, then run `bun spec/generate.ts`.
- `sdk/`: plugin SDK. `plugins/`: one directory per plugin. Big plugins are hexagonal (`domain/ ports/ adapters/ app/`).
- `bridges/`: generic bridges, configured instead of coded: `mcp` (MCP server over stdio), `cli` (argv templates), `http` (HTTP endpoints, secret headers from files), `acp` (Agent Client Protocol agent over stdio). `tools/`: CLI subcommands (`adapt`, `doctor`, `config`, `remote`, `tailscale`, `release`). `bin/me.ts`: the CLI.
- `plugins/web/ui/`: React UI, one file per screen. Status is a dot plus a text label; color only for state; Korean strings.

## Conventions
- TypeScript strict. Bun only. Pin exact dependency versions.
- Plugins talk only through the kernel. New kernel methods need permissions and schema entries.
- Tests run without network or paid models, except `bun run e2e`, which uses the configured head model.
- Korean for user-facing text and docs in `docs/`; English for code and comments.

## Finishing
Meet `docs/DONE.md`. Report what you verified and what you did not.
