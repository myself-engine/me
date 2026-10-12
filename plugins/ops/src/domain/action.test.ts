import { describe, expect, test } from "bun:test";
import { approvalSummary, captureOutput, closeStale, finishRun, parseAction, type ActionRun } from "./action.ts";
import { parseConfig } from "./check.ts";

const check = (actions: unknown) => ({ id: "bot", kind: "process", match: "bot", actions });

describe("parseAction", () => {
  test("each kind turns into a fixed argv", () => {
    expect(parseAction({ id: "r", label: "다시 시작", kind: "systemd-user-restart", unit: "rapi.service" }, 1000).argv).toEqual(["systemctl", "--user", "restart", "rapi.service"]);
    expect(parseAction({ id: "r", label: "다시 시작", kind: "launchd-restart", job: "homebrew.mxcl.caddy" }, 501).argv).toEqual(["launchctl", "kickstart", "-k", "gui/501/homebrew.mxcl.caddy"]);
    expect(parseAction({ id: "r", label: "정리", kind: "command", argv: ["rm", "-f", "/tmp/x.lock"] }, null).argv).toEqual(["rm", "-f", "/tmp/x.lock"]);
  });

  test("risk is at least medium; timeout has a default and a ceiling", () => {
    const base = { id: "r", label: "다시 시작", kind: "command", argv: ["true"] };
    expect(parseAction(base, null)).toMatchObject({ risk: "medium", timeoutMs: 30_000 });
    expect(parseAction({ ...base, risk: "low" }, null).risk).toBe("medium");
    expect(parseAction({ ...base, risk: "high", timeoutMs: 9_999_999 }, null)).toMatchObject({ risk: "high", timeoutMs: 600_000 });
    expect(() => parseAction({ ...base, risk: "extreme" }, null)).toThrow("risk must be medium or high");
  });

  test("names that look like options, paths or several words are refused", () => {
    for (const unit of ["--all", "a b", "../x", "", "a/b"]) {
      expect(() => parseAction({ id: "r", label: "x", kind: "systemd-user-restart", unit }, 1)).toThrow("systemd unit name");
    }
    expect(() => parseAction({ id: "r", label: "x", kind: "launchd-restart", job: "-k" }, 1)).toThrow("launchd job label");
    expect(() => parseAction({ id: "r", label: "x", kind: "launchd-restart", job: "ok" }, null)).toThrow("need a user id");
  });

  test("label, id, kind and argv are required", () => {
    expect(() => parseAction({ id: "r", kind: "command", argv: ["true"] }, null)).toThrow("needs a label");
    expect(() => parseAction({ id: "-r", label: "x", kind: "command", argv: ["true"] }, null)).toThrow("action id");
    expect(() => parseAction({ id: "r", label: "x", kind: "shell", cmd: "true" }, null)).toThrow("unknown kind shell");
    expect(() => parseAction({ id: "r", label: "x", kind: "command", argv: "true" }, null)).toThrow("needs argv");
    expect(() => parseAction({ id: "r", label: "x", kind: "command", argv: [""] }, null)).toThrow("needs argv");
  });
});

describe("actions in config", () => {
  test("a check keeps its probe fields and gains actions", () => {
    const c = parseConfig({ checks: [check([{ id: "r", label: "다시 시작", kind: "command", argv: ["true"] }])] });
    expect(c.errors).toEqual([]);
    expect(c.checks[0]).toMatchObject({ id: "bot", kind: "process", match: "bot", actions: [{ id: "r", argv: ["true"] }] });
  });

  test("checks without actions are unchanged", () => {
    expect(parseConfig({ checks: [check(undefined)] }).checks[0]).toEqual({ id: "bot", kind: "process", match: "bot" });
  });

  test("a bad or duplicate action rejects its check", () => {
    const ok = { id: "r", label: "다시 시작", kind: "command", argv: ["true"] };
    const c = parseConfig({ checks: [check([ok, ok]), { ...check("nope"), id: "b2" }, { ...check([{ ...ok, kind: "x" }]), id: "b3" }] });
    expect(c.checks).toEqual([]);
    expect(c.errors.map((e) => e.error)).toEqual(["duplicate action id: r", "actions must be an array", "action r: unknown kind x"]);
  });
});

describe("summaries and results", () => {
  const action = parseAction({ id: "r", label: "다시 시작", kind: "command", argv: ["svc", "restart", "my app"] }, null);

  test("the approval summary names the machine and the exact argv", () => {
    expect(approvalSummary("bot", action, "rapi-agent (ops-rapi)")).toBe(`rapi-agent (ops-rapi)에서 실행: "svc" "restart" "my app" — 점검 bot의 '다시 시작'`);
  });

  test("output keeps the tail and is capped", () => {
    expect(captureOutput("out\n", "err\n")).toBe("out\nerr");
    const long = captureOutput("x".repeat(5000) + "END", "", 100);
    expect(long).toHaveLength(100);
    expect(long.startsWith("…")).toBe(true);
    expect(long.endsWith("END")).toBe(true);
  });

  const run: ActionRun = { actionId: "r", label: "다시 시작", argv: action.argv, machine: "m", state: "running", requestedAt: "t0" };

  test("finishRun maps exit, timeout and spawn failure", () => {
    expect(finishRun(run, { code: 0, stdout: "", stderr: "", timedOut: false }, "t1", 30_000)).toEqual({ ...run, state: "done", finishedAt: "t1", exitCode: 0 });
    expect(finishRun(run, { code: 3, stdout: "", stderr: "boom", timedOut: false }, "t1", 30_000)).toMatchObject({ state: "failed", exitCode: 3, output: "boom" });
    expect(finishRun(run, { code: -1, stdout: "", stderr: "", timedOut: false, spawnError: "ENOENT" }, "t1", 30_000)).toMatchObject({ state: "failed", note: "실행하지 못했어요: ENOENT" });
  });

  test("closeStale fails only unfinished runs", () => {
    expect(closeStale(run, "t2")).toMatchObject({ state: "failed", finishedAt: "t2" });
    expect(closeStale({ ...run, state: "done" }, "t2")!.state).toBe("done");
    expect(closeStale(undefined, "t2")).toBeNull();
  });
});
