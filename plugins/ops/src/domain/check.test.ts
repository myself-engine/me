import { describe, expect, test } from "bun:test";
import { observe, parseConfig, type CheckState, type Observation, type Status } from "./check.ts";

const spec = { id: "web", kind: "http" as const };
const o = (status: Status, detail: string = status): Observation => ({ status, detail, latencyMs: 12.4 });
const t = (n: number) => new Date(Date.UTC(2026, 9, 10, 0, 0, n)).toISOString();
const empty: CheckState = { record: null, pending: null };

/** Feeds observations in order and returns every confirmed change. */
function feed(statuses: Status[], confirm: number) {
  let state = empty;
  const changes: { from: Status | null; to: Status; at: string }[] = [];
  statuses.forEach((s, i) => {
    const r = observe(state, spec, o(s), t(i), confirm);
    state = r.state;
    if (r.changed) changes.push({ ...r.changed, at: t(i) });
  });
  return { state, changes };
}

describe("observe", () => {
  test("first observation is adopted immediately and counts as a change from nothing", () => {
    const r = observe(empty, spec, o("up", "HTTP 200"), t(0));
    expect(r.changed).toEqual({ from: null, to: "up" });
    expect(r.state.record).toEqual({ id: "web", kind: "http", ok: true, status: "up", detail: "HTTP 200", latencyMs: 12, checkedAt: t(0), since: t(0) });
  });

  test("steady status refreshes checkedAt and detail but keeps since and emits nothing", () => {
    const { state, changes } = feed(["up", "up", "up"], 2);
    expect(changes).toHaveLength(1);
    expect(state.record!.since).toBe(t(0));
    expect(state.record!.checkedAt).toBe(t(2));
  });

  test("up→down changes exactly once, after confirmation", () => {
    const { state, changes } = feed(["up", "down", "down", "down", "down"], 2);
    expect(changes.map((c) => [c.from, c.to])).toEqual([
      [null, "up"],
      ["up", "down"],
    ]);
    expect(changes[1]!.at).toBe(t(2));
    expect(state.record!.status).toBe("down");
    expect(state.record!.ok).toBe(false);
    expect(state.record!.since).toBe(t(2));
  });

  test("with confirm=1 a single down observation flips at once", () => {
    const { changes } = feed(["up", "down"], 1);
    expect(changes.at(-1)).toMatchObject({ from: "up", to: "down", at: t(1) });
  });

  test("flapping that never repeats is absorbed", () => {
    const { state, changes } = feed(["up", "down", "up", "down", "up", "down", "up"], 2);
    expect(changes).toHaveLength(1);
    expect(state.record!.status).toBe("up");
    expect(state.record!.since).toBe(t(0));
  });

  test("an unconfirmed observation shows in detail while the status holds", () => {
    const state = observe(empty, spec, o("up"), t(0)).state;
    const r = observe(state, spec, o("down", "ECONNREFUSED"), t(1), 3);
    expect(r.changed).toBeNull();
    expect(r.state.record!.status).toBe("up");
    expect(r.state.record!.detail).toBe("down 1/3: ECONNREFUSED");
    expect(r.state.pending).toEqual({ status: "down", count: 1 });
  });

  test("a different candidate restarts the count", () => {
    const { state, changes } = feed(["up", "down", "unknown", "down", "unknown", "unknown"], 2);
    expect(changes.map((c) => c.to)).toEqual(["up", "unknown"]);
    expect(state.record!.since).toBe(t(5));
  });

  test("recovery down→up also needs confirmation and resets since", () => {
    const { state, changes } = feed(["down", "up", "up"], 2);
    expect(changes.map((c) => [c.from, c.to])).toEqual([
      [null, "down"],
      ["down", "up"],
    ]);
    expect(state.record!.since).toBe(t(2));
  });
});

describe("parseConfig", () => {
  test("applies defaults and keeps valid checks", () => {
    const c = parseConfig({
      checks: [
        { id: "web", kind: "http", url: "http://127.0.0.1:3000/health" },
        { id: "db", kind: "tcp", host: "127.0.0.1", port: 5432, timeoutMs: 800 },
        { id: "bot", kind: "process", match: "discord-bot" },
        { id: "caddy", kind: "launchd", label: "homebrew.mxcl.caddy" },
        { id: "pane", kind: "herdr-pane", paneId: "w1:p3" },
        { id: "git", kind: "command", argv: ["git", "--version"] },
      ],
    });
    expect(c.errors).toEqual([]);
    expect(c.intervalSec).toBe(60);
    expect(c.confirm).toBe(2);
    expect(c.checks[0]).toEqual({ id: "web", kind: "http", url: "http://127.0.0.1:3000/health", expectStatus: 200, timeoutMs: 5000 });
    expect(c.checks[1]).toMatchObject({ timeoutMs: 800 });
    expect(c.checks[5]).toEqual({ id: "git", kind: "command", argv: ["git", "--version"], expectExit: 0, timeoutMs: 5000 });
  });

  test("rejects bad checks without dropping the good ones", () => {
    const c = parseConfig({
      intervalSec: 15,
      checks: [
        { id: "ok", kind: "process", match: "x" },
        { id: "ok", kind: "process", match: "y" },
        { id: "sh", kind: "command", argv: "rm -rf /" },
        { id: "ftp", kind: "http", url: "ftp://x" },
        { id: "port", kind: "tcp", host: "h", port: 70000 },
        { id: "lbl", kind: "launchd", label: "gui/501/x" },
        { kind: "process", match: "z" },
        { id: "what", kind: "restart" },
      ],
    });
    expect(c.intervalSec).toBe(15);
    expect(c.checks.map((x) => x.id)).toEqual(["ok"]);
    expect(c.errors.map((e) => e.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(c.errors[0]!.error).toContain("duplicate");
  });

  test("tolerates missing config", () => {
    expect(parseConfig(undefined)).toEqual({ checks: [], intervalSec: 60, startDelaySec: 0, confirm: 2, errors: [] });
  });
});
