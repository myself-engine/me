import { describe, expect, test } from "bun:test";
import { interpretCommand, interpretHerdrPane, interpretLaunchctl, interpretProcessList } from "./interpret.ts";

describe("interpretProcessList", () => {
  const ps = ["  101 /usr/sbin/syslogd", "  202 node /srv/bot/discord-bot.js", "  303 ps -axo pid=,command=", " 404 bun discord-bot --dev"].join("\n");

  test("finds matching processes and skips our own pids", () => {
    expect(interpretProcessList(ps, "discord-bot", [303], 3)).toMatchObject({ status: "up", detail: "2 processes (pid 202, 404)" });
    expect(interpretProcessList(ps, "discord-bot", [202, 404], 3).status).toBe("down");
  });

  test("ignores the ps line itself when it is one of our pids", () => {
    expect(interpretProcessList(ps, "command=", [303], 3).status).toBe("down");
  });
});

describe("interpretLaunchctl", () => {
  const running = "gui/501/homebrew.mxcl.caddy = {\n\tactive count = 1\n\tstate = running\n\tpid = 812\n\tlast exit code = 0\n}";
  const stopped = "gui/501/x = {\n\tstate = not running\n\tlast exit code = 78: EX_CONFIG\n}";

  test("running job is up with its pid", () => {
    expect(interpretLaunchctl(0, running, "", 4)).toMatchObject({ status: "up", detail: "running (pid 812)" });
  });
  test("loaded but not running is down with the last exit code", () => {
    expect(interpretLaunchctl(0, stopped, "", 4)).toMatchObject({ status: "down", detail: "not running, last exit 78: EX_CONFIG" });
  });
  test("missing service is down", () => {
    expect(interpretLaunchctl(113, "", "Could not find service \"x\" in domain for user gui: 501", 4).status).toBe("down");
  });
  test("other failures are unknown", () => {
    expect(interpretLaunchctl(1, "", "Bad request.", 4)).toMatchObject({ status: "unknown", detail: "launchctl exited 1: Bad request." });
  });
});

describe("interpretHerdrPane", () => {
  test("existing pane is up and shows agent state and title", () => {
    const out = JSON.stringify({ result: { pane: { pane_id: "w1:p3", agent: "claude", agent_status: "idle", terminal_title_stripped: "bot logs" } } });
    expect(interpretHerdrPane(0, out, "", 9)).toMatchObject({ status: "up", detail: "claude idle · bot logs" });
  });
  test("pane_not_found is down", () => {
    const out = JSON.stringify({ error: { code: "pane_not_found", message: "pane w1:p9 not found" } });
    expect(interpretHerdrPane(1, out, "", 9).status).toBe("down");
  });
  test("server trouble is unknown", () => {
    expect(interpretHerdrPane(1, "", "connection refused", 9)).toMatchObject({ status: "unknown", detail: "herdr exited 1: connection refused" });
  });
});

describe("interpretCommand", () => {
  test("expected exit is up, anything else is down", () => {
    expect(interpretCommand(0, 0, "ok\nmore", "", 1)).toMatchObject({ status: "up", detail: "exit 0: ok" });
    expect(interpretCommand(1, 0, "", "boom", 1)).toMatchObject({ status: "down", detail: "exit 1: boom" });
    expect(interpretCommand(3, 3, "", "", 1).status).toBe("up");
  });
});

test("a failing command shows every output line, a passing one only the first", () => {
  const out = "rapi-agent: 연결 가능\nmadp: 접속 불가\npve: 연결 가능\n";
  expect(interpretCommand(1, 0, out, "", 5).detail).toBe("exit 1: rapi-agent: 연결 가능 · madp: 접속 불가 · pve: 연결 가능");
  expect(interpretCommand(0, 0, out, "", 5).detail).toBe("exit 0: rapi-agent: 연결 가능");
});
