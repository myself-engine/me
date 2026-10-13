import { describe, expect, test } from "bun:test";
import { brgrPanesOf, mapState, repeatedFailure, snapshotsOf } from "./watch.ts";

const fixture = await Bun.file(new URL("./fixtures/agent-list.json", import.meta.url)).text();

describe("Herdr and brgr snapshots", () => {
  test("parses the anonymized Herdr JSON RPC fixture without using layout order", () => {
    expect(snapshotsOf(fixture)).toEqual([
      {
        pane: "w1:p1",
        kind: "claude",
        cwd: "/workspace/example",
        project: "/workspace/example",
        state: "working",
        revision: 1,
        since: null,
      },
    ]);
  });

  test("maps recognized agent states and leaves unknown states explicit", () => {
    expect(["working", "waiting-input", "idle", "done", "blocked", "unrecognized"].map(mapState)).toEqual([
      "working", "waiting-input", "idle", "done", "waiting-input", "unknown",
    ]);
  });

  test("maps only active brgr tasks by their session pane", () => {
    const output = JSON.stringify({ result: { tasks: [
      { taskId: "task-1", state: "running", session: { pane: "w1:p1" } },
      { taskId: "task-2", state: "sealed", session: { pane: "w1:p2" } },
    ] } });
    expect(brgrPanesOf(output)).toEqual(new Map([["w1:p1", "task-1"]]));
  });
});

describe("stall signatures", () => {
  test("requires the same failure text three times", () => {
    expect(repeatedFailure(["Error: connection failed", "Error: connection failed"])).toBeNull();
    expect(repeatedFailure(["Error: connection failed", "Error: connection failed", "Error: connection failed"])).toBe("Error: connection failed");
  });
});
