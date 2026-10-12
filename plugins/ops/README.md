# ops

Health checks for things you run: web apps, servers, Discord bots, local services.
Checks only observe and report. A check may also offer actions (restart a service, run a command); an action runs only after you approve it through the kernel approval gate.

Enable it by adding `"plugins/ops"` to `plugins` in your config, then configure `pluginConfig.ops`:

```json
{
  "intervalSec": 60,
  "confirm": 2,
  "checks": [
    { "id": "site", "kind": "http", "url": "https://example.com/health", "expectStatus": 200, "contains": "ok", "timeoutMs": 5000 },
    { "id": "db", "kind": "tcp", "host": "127.0.0.1", "port": 5432 },
    { "id": "bot", "kind": "process", "match": "discord-bot.js" },
    { "id": "caddy", "kind": "launchd", "label": "homebrew.mxcl.caddy" },
    { "id": "logs", "kind": "herdr-pane", "paneId": "w1:p3" },
    { "id": "disk", "kind": "command", "argv": ["test", "-d", "/Volumes/Backup"], "expectExit": 0 }
  ]
}
```

- `confirm` (default 2): a status change must be seen this many runs in a row before it counts, so one blip does not flap. The first run of a check is taken as-is.
- `heartbeatSec` (default 600): a record is written to the store only when its status, `since` or `detail` changes, or when the last write is this old. Runs in between update `checks.list` and `checks.history` but not the stored record, so a stored `checkedAt` can lag by up to `heartbeatSec` plus one interval.
- Invalid checks are skipped and reported in `checks.list` under `errors`.

## Actions

Any check may declare `actions`. Each has an `id`, a Korean `label` for the button, and one of three kinds:

```json
{ "id": "bot", "kind": "process", "match": "discord-bot.js", "actions": [
  { "id": "restart", "label": "다시 시작", "kind": "systemd-user-restart", "unit": "discord-bot.service" },
  { "id": "kick", "label": "launchd 재시작", "kind": "launchd-restart", "job": "com.example.bot", "risk": "high" },
  { "id": "clean", "label": "잠금 파일 지우기", "kind": "command", "argv": ["rm", "-f", "/tmp/bot.lock"], "timeoutMs": 10000 }
] }
```

- The argv is fixed when the config is read: `systemctl --user restart <unit>`, `launchctl kickstart -k gui/<uid>/<job>`, or the `argv` you wrote. Callers send only the check id and action id; nothing they send becomes part of the argv, and an approval `amend` is ignored.
- `risk` is `medium` (default) or `high`; `low` is raised to `medium`. `timeoutMs` defaults to 30 s, capped at 10 min.
- A bad action (unknown kind, unit or job that looks like an option or path, duplicate id) rejects the whole check.

`actions.run` `{ checkId, actionId }` returns `{ state: "waiting", summary }` at once, then:
1. asks for approval with a summary naming the machine (`<hostname> (<plugin id>)`) and the exact argv; the request expires after 10 minutes,
2. on approve, runs the argv without a shell under the timeout and keeps the last 2,000 characters of output,
3. waits 3 s, runs the check again, and records the result.

Each step is written to the check's `lastAction` (`waiting`, `running`, `done`, `failed`, `rejected`, with `exitCode`, `output`, `note`, `recheck`). The re-check is a single observation, so the check's status still needs `confirm` runs to flip. Only one action per check runs at a time. Runs still `waiting` or `running` when ops restarts are closed as `failed`.

`approval-policy` never auto-approves `high`, and auto-approves `medium` only for a rule that sets `maxRisk: "medium"` and matches this requester; use `"risk": "high"` for anything that must always reach you. The argv, the summary and the captured output are stored on the record and in the journal, so keep secrets out of action argv.

A remote instance (`me connect plugins/ops --id ops-<name>`) uses the same code. It can ask for approval only if the Mac kernel's `remotePermissions` includes `approve.request`; otherwise every action is recorded as `failed` before anything runs.

## What it provides

- Entity kind `ops.check`: `{ id, kind, ok, status: "up"|"down"|"unknown", detail, latencyMs, checkedAt, since, actions?, lastAction? }`. `since` is when the current status started. `actions` lists `{ id, label, argv, risk }`.
- Events: `ops.check.changed` `{ id, kind, from, to, detail, since }` on every confirmed status change (`from` is null on a check's first run); `ops.check.down` as well when `to` is `down`; `ops.action.finished` `{ id, actionId, machine, state, exitCode, recheck }` when an action ends (including reject and failure).
- Methods: `checks.list`, `checks.run` `{ id? }`, `checks.history` `{ id, limit? }` (newest first, from an in-memory ring buffer of the last 200 runs per check, which resets when the plugin restarts), `actions.run` `{ checkId, actionId }`.

`unknown` means the probe could not tell, for example `launchctl` off macOS, `herdr` not installed, or a `ps` timeout. It does not mean the target is down.

## Permissions

- `read-state`, `emit`: store `ops.check` records and announce changes.
- `network`: http and tcp probes (GET, then connect and close).
- `shell`: process (`ps -axo pid=,command=`), launchd (`launchctl print gui/<uid>/<label>`), herdr-pane (`herdr pane get <id>`) and command probes start programs. Every one runs by argv without a shell. The first three only query state. A command check runs exactly the argv you configured, so it is only as read-only as that argv. Actions run their configured argv the same way, and only after approval.
- `approve.request`: every action asks the kernel approval gate before it runs.

## Layout

`domain/` holds status transitions, flap handling, config parsing, output interpretation, and action parsing and results, all pure. `ports/` defines Probe, Exec, Clock, CheckStore, Events and Approvals. `adapters/` has the probes, Bun exec, and the kernel store, events and approvals. `app/` holds scheduling, history, actions and methods. `main.ts` does the wiring.
