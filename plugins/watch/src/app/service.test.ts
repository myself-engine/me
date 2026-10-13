import { describe, expect, test } from "bun:test";
import type { WatchAgent } from "../domain/watch.ts";
import type { AgentStore, Clock, HerdrAgent, WatchEvents, WatchStatus } from "../ports/index.ts";
import { createWatchService } from "./service.ts";

class FakeClock implements Clock {
  time = Date.UTC(2026, 9, 13, 0, 0, 0);
  now = () => this.time;
  every = (_ms: number, _fn: () => void) => () => {};
}

class MemoryStore implements AgentStore {
  agents = new Map<string, WatchAgent>();
  status: WatchStatus | null = null;
  list = async () => [...this.agents.values()];
  put = async (agent: WatchAgent) => void this.agents.set(agent.pane, agent);
  remove = async (pane: string) => void this.agents.delete(pane);
  getStatus = async () => this.status;
  putStatus = async (status: WatchStatus) => void (this.status = status);
}

class MemoryEvents implements WatchEvents {
  emitted: { name: string; data: any }[] = [];
  emit = async (name: string, data: unknown) => void this.emitted.push({ name, data });
}

function setup(opts: { herdrEnv?: boolean; text?: string } = {}) {
  const clock = new FakeClock();
  const store = new MemoryStore();
  const events = new MemoryEvents();
  const fixture = JSON.parse(awaitFixture);
  let outputLines = opts.text ?? "working";
  const herdr: HerdrAgent = {
    exec: async (args) => {
      if (args[0] === "agent" && args[1] === "list") return { code: 0, stdout: JSON.stringify(fixture), stderr: "" };
      if (args[0] === "agent" && args[1] === "read") return { code: 0, stdout: outputLines, stderr: "" };
      return { code: 1, stdout: "", stderr: "unknown command" };
    },
  };
  const brgr: HerdrAgent = {
    exec: async () => ({ code: 0, stdout: JSON.stringify({ result: { tasks: [{ taskId: "task-1", state: "running", session: { pane: "w1:p1" } }] } }), stderr: "" }),
  };
  const service = createWatchService({ herdr, brgr, store, events, clock, herdrEnv: opts.herdrEnv ?? true, config: { stallMinutes: 1 }, log: () => {} });
  return { service, clock, store, events, setOutput: (text: string) => { outputLines = text; } };
}

const awaitFixture = await Bun.file(new URL("../domain/fixtures/agent-list.json", import.meta.url)).text();

describe("watch service", () => {
  test("stores one agent pane and emits a stall only after no revision change for the configured time", async () => {
    const { service, clock, store, events } = setup();
    await service.poll();
    expect(store.agents.get("w1:p1")?.brgrTaskId).toBe("task-1");
    expect(events.emitted).toHaveLength(0);
    clock.time += 60_001;
    await service.poll();
    expect(store.agents.get("w1:p1")?.stalled).toBe(true);
    expect(events.emitted.map((event) => event.name)).toEqual(["stalled"]);
    await service.poll();
    expect(events.emitted).toHaveLength(1);
  });

  test("flags repeated failures and redacts excerpts before storage and events", async () => {
    const { service, store, events, setOutput } = setup();
    setOutput("Error: connection failed token=sk-abcdefgh123456\nError: connection failed token=sk-abcdefgh123456\nError: connection failed token=sk-abcdefgh123456");
    await service.poll();
    const agent = store.agents.get("w1:p1")!;
    expect(agent.stallReason).toBe("repeated-failure");
    expect(agent.stallExcerpt).not.toContain("sk-abcdefgh");
    expect(JSON.stringify(events.emitted)).not.toContain("sk-abcdefgh");
  });

  test("reports one problem status and does not run Herdr outside a Herdr environment", async () => {
    const { service, store } = setup({ herdrEnv: false });
    await service.poll();
    expect(store.status?.state).toBe("problem");
    expect(store.status?.problem).toContain("Herdr 환경");
    expect(store.agents.size).toBe(0);
  });
});
