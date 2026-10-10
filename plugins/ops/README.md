# ops

Read-only health checks for things you run: web apps, servers, Discord bots, local services.
It observes and reports; it never restarts or stops anything.

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
- Invalid checks are skipped and reported in `checks.list` under `errors`.

## What it provides

- Entity kind `ops.check`: `{ id, kind, ok, status: "up"|"down"|"unknown", detail, latencyMs, checkedAt, since }`. `since` is when the current status started.
- Events: `ops.check.changed` `{ id, kind, from, to, detail, since }` on every confirmed status change (`from` is null on a check's first run); `ops.check.down` as well when `to` is `down`.
- Methods: `checks.list`, `checks.run` `{ id? }`, `checks.history` `{ id, limit? }` (newest first, from an in-memory ring buffer of the last 200 runs per check, which resets when the plugin restarts).

`unknown` means the probe could not tell, for example `launchctl` off macOS, `herdr` not installed, or a `ps` timeout. It does not mean the target is down.

## Permissions

- `read-state`, `emit`: store `ops.check` records and announce changes.
- `network`: http and tcp probes (GET, then connect and close).
- `shell`: process (`ps -axo pid=,command=`), launchd (`launchctl print gui/<uid>/<label>`), herdr-pane (`herdr pane get <id>`) and command probes start programs. Every one runs by argv without a shell. The first three only query state. A command check runs exactly the argv you configured, so it is only as read-only as that argv.

## Layout

`domain/` holds status transitions, flap handling, config parsing, and output interpretation, all pure. `ports/` defines Probe, Exec, Clock, CheckStore and Events. `adapters/` has the probes, Bun exec, and the kernel store and events. `app/` holds scheduling, history and methods. `main.ts` does the wiring.
