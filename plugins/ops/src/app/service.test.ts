import { describe, expect, test } from "bun:test";
import { parseConfig, type CheckRecord, type CheckSpec, type Observation, type Status } from "../domain/check.ts";
import type { CheckStore, Clock, Events, Probe } from "../ports/index.ts";
import { createService } from "./service.ts";

const T0 = Date.UTC(2026, 9, 10, 9, 0, 0);

class FakeClock implements Clock {
  t = T0;
  timers: { every: number; next: number; fn: () => void; live: boolean }[] = [];
  now = () => this.t;
  every = (ms: number, fn: () => void) => {
    const timer = { every: ms, next: this.t + ms, fn, live: true };
    this.timers.push(timer);
    return () => void (timer.live = false);
  };
  /** Moves time forward, firing due timers in order. */
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.live && x.next <= end).sort((a, b) => a.next - b.next)[0];
      if (!due) break;
      this.t = due.next;
      due.next += due.every;
      due.fn();
    }
    this.t = end;
  }
}

class MemoryStore implements CheckStore {
  records = new Map<string, CheckRecord>();
  puts = 0;
  list = async () => [...this.records.values()];
  put = async (r: CheckRecord) => {
    this.puts++;
    this.records.set(r.id, r);
  };
}

class FakeEvents implements Events {
  emitted: { name: string; data: any }[] = [];
  emit = async (name: string, data: unknown) => void this.emitted.push({ name, data });
  names = () => this.emitted.map((e) => e.name);
}

/** A probe whose answer per check id is set by the test. */
function scriptedProbe() {
  const answers = new Map<string, Status>();
  const calls: string[] = [];
  const probe: Probe = async (spec: CheckSpec): Promise<Observation> => {
    calls.push(spec.id);
    const status = answers.get(spec.id) ?? "up";
    return { status, detail: `${spec.id} ${status}`, latencyMs: 5 };
  };
  return { probe, answers, calls };
}

function setup(opts: { confirm?: number; intervalSec?: number; startDelaySec?: number; store?: MemoryStore } = {}) {
  const config = parseConfig({
    intervalSec: opts.intervalSec ?? 30,
    startDelaySec: opts.startDelaySec ?? 0,
    confirm: opts.confirm ?? 2,
    checks: [
      { id: "web", kind: "http", url: "http://127.0.0.1:1/" },
      { id: "bot", kind: "process", match: "bot" },
    ],
  });
  const clock = new FakeClock();
  const store = opts.store ?? new MemoryStore();
  const events = new FakeEvents();
  const p = scriptedProbe();
  const service = createService({ config, probe: p.probe, clock, store, events, historySize: 3, log: () => {} });
  return { service, clock, store, events, ...p };
}

describe("scheduling", () => {
  test("start runs every check at once and then once per interval", async () => {
    const { service, clock, calls } = setup({ intervalSec: 30 });
    service.start();
    await service.idle();
    expect(calls).toEqual(["web", "bot"]);
    clock.advance(29_999);
    await service.idle();
    expect(calls).toHaveLength(2);
    clock.advance(1);
    await service.idle();
    expect(calls).toHaveLength(4);
    for (let i = 0; i < 3; i++) {
      clock.advance(30_000);
      await service.idle();
    }
    expect(calls).toHaveLength(10);
  });

  test("startDelaySec postpones the first run, then the interval continues", async () => {
    const { service, clock, calls } = setup({ startDelaySec: 5 });
    service.start();
    await service.idle();
    expect(calls).toHaveLength(0);
    clock.advance(5_000);
    await service.idle();
    expect(calls).toHaveLength(2);
    clock.advance(30_000);
    await service.idle();
    expect(calls).toHaveLength(4);
    service.stop();
    clock.advance(600_000);
    await service.idle();
    expect(calls).toHaveLength(4);
  });

  test("stop cancels the interval", async () => {
    const { service, clock, calls } = setup();
    service.start();
    await service.idle();
    service.stop();
    clock.advance(600_000);
    await service.idle();
    expect(calls).toHaveLength(2);
  });

  test("start is idempotent", async () => {
    const { service, clock } = setup();
    service.start();
    service.start();
    await service.idle();
    expect(clock.timers).toHaveLength(1);
  });

  test("overlapping runs of the same check share one probe call", async () => {
    const { service, calls } = setup();
    const [a, b] = await Promise.all([service.run({ id: "web" }), service.run({ id: "web" })]);
    expect(calls).toEqual(["web"]);
    expect(a).toEqual(b);
  });

  test("records carry timestamps from the clock", async () => {
    const { service, clock, store } = setup();
    await service.run();
    clock.advance(30_000);
    await service.run({ id: "web" });
    expect(store.records.get("web")).toMatchObject({ status: "up", ok: true, since: new Date(T0).toISOString(), checkedAt: new Date(T0).toISOString() });
    expect(service.list().checks.find((c: any) => c.id === "web")).toMatchObject({
      since: new Date(T0).toISOString(),
      checkedAt: new Date(T0 + 30_000).toISOString(),
    });
  });
});

describe("store writes", () => {
  function single(heartbeatSec?: number, store?: MemoryStore) {
    const config = parseConfig({ intervalSec: 60, confirm: 2, ...(heartbeatSec ? { heartbeatSec } : {}), checks: [{ id: "web", kind: "http", url: "http://127.0.0.1:1/" }] });
    const clock = new FakeClock();
    const s = store ?? new MemoryStore();
    const p = scriptedProbe();
    const service = createService({ config, probe: p.probe, clock, store: s, events: new FakeEvents(), log: () => {} });
    return { service, clock, store: s, ...p };
  }
  const tick = async (h: { clock: FakeClock; service: { idle(): Promise<void> } }, n: number) => {
    for (let i = 0; i < n; i++) {
      h.clock.advance(60_000);
      await h.service.idle();
    }
  };

  test("a steady check is stored once, then once per heartbeat (default 10 minutes)", async () => {
    const h = single();
    h.service.start();
    await h.service.idle();
    expect(h.store.puts).toBe(1);
    await tick(h, 9);
    expect(h.store.puts).toBe(1);
    await tick(h, 1);
    expect(h.store.puts).toBe(2);
    expect(h.store.records.get("web")!.checkedAt).toBe(new Date(T0 + 600_000).toISOString());
    await tick(h, 50);
    expect(h.store.puts).toBe(7);
  });

  test("a status change and an unconfirmed candidate are stored at once", async () => {
    const h = single();
    h.service.start();
    await h.service.idle();
    h.answers.set("web", "down");
    await tick(h, 1);
    expect(h.store.puts).toBe(2);
    expect(h.store.records.get("web")).toMatchObject({ status: "up", detail: "down 1/2: web down" });
    await tick(h, 1);
    expect(h.store.puts).toBe(3);
    expect(h.store.records.get("web")).toMatchObject({ status: "down", since: new Date(T0 + 120_000).toISOString() });
    await tick(h, 3);
    expect(h.store.puts).toBe(3);
  });

  test("heartbeatSec is configurable and a restart continues from the stored record's checkedAt", async () => {
    const store = new MemoryStore();
    const a = single(120, store);
    a.service.start();
    await a.service.idle();
    await tick(a, 2);
    expect(store.puts).toBe(2);
    a.service.stop();

    const b = single(120, store);
    b.clock.t = a.clock.t + 60_000;
    await b.service.load();
    await b.service.run();
    expect(store.puts).toBe(2);
    b.clock.advance(60_000);
    await b.service.run();
    expect(store.puts).toBe(3);
  });
});

describe("events", () => {
  test("up→down emits changed and down once; steady state emits nothing", async () => {
    const { service, clock, events, answers } = setup({ confirm: 2 });
    service.start();
    await service.idle();
    expect(events.names()).toEqual(["check.changed", "check.changed"]);
    events.emitted = [];

    answers.set("web", "down");
    for (let i = 0; i < 5; i++) {
      clock.advance(30_000);
      await service.idle();
    }
    expect(events.names()).toEqual(["check.changed", "check.down"]);
    expect(events.emitted[0]!.data).toMatchObject({ id: "web", kind: "http", from: "up", to: "down", since: new Date(T0 + 60_000).toISOString() });
  });

  test("flapping does not emit", async () => {
    const { service, clock, events, answers } = setup({ confirm: 2 });
    service.start();
    await service.idle();
    events.emitted = [];
    for (let i = 0; i < 6; i++) {
      answers.set("web", i % 2 === 0 ? "down" : "up");
      clock.advance(30_000);
      await service.idle();
    }
    expect(events.emitted).toEqual([]);
  });

  test("recovery emits changed but not down", async () => {
    const { service, events, answers } = setup({ confirm: 1 });
    answers.set("web", "down");
    await service.run({ id: "web" });
    expect(events.names()).toEqual(["check.changed", "check.down"]);
    events.emitted = [];
    answers.set("web", "up");
    await service.run({ id: "web" });
    expect(events.names()).toEqual(["check.changed"]);
    expect(events.emitted[0]!.data).toMatchObject({ from: "down", to: "up" });
  });

  test("a restart seeded from the store keeps since and does not re-announce", async () => {
    const first = setup();
    await first.service.run();
    const since = first.store.records.get("web")!.since;

    const second = setup({ store: first.store });
    await second.service.load();
    second.clock.advance(3_600_000);
    await second.service.run();
    expect(second.events.emitted).toEqual([]);
    expect(second.store.records.get("web")!.since).toBe(since);
  });
});

describe("methods", () => {
  test("list shows configured checks before their first run and config errors", async () => {
    const config = parseConfig({ checks: [{ id: "web", kind: "tcp", host: "h", port: 1 }, { id: "bad", kind: "nope" }] });
    const service = createService({ config, probe: scriptedProbe().probe, clock: new FakeClock(), store: new MemoryStore(), events: new FakeEvents() });
    const l = service.list();
    expect(l.checks).toEqual([{ id: "web", kind: "tcp", status: "unknown", pending: true }]);
    expect(l.errors).toHaveLength(1);
    await service.run();
    expect(service.list().checks[0]).toMatchObject({ id: "web", status: "up" });
  });

  test("run rejects unknown ids", async () => {
    const { service } = setup();
    await expect(service.run({ id: "nope" })).rejects.toThrow("unknown check: nope");
  });

  test("history is newest first, bounded by the ring size, and records raw observations", async () => {
    const { service, clock, answers } = setup({ confirm: 3 });
    for (const s of ["up", "up", "down", "down"] as const) {
      answers.set("web", s);
      await service.run({ id: "web" });
      clock.advance(1000);
    }
    const h = service.history({ id: "web", limit: 10 });
    expect(h.entries.map((e) => e.status)).toEqual(["down", "down", "up"]);
    expect(h.entries[0]!.checkedAt).toBe(new Date(T0 + 3000).toISOString());
    expect(service.history({ id: "web", limit: 1 }).entries).toHaveLength(1);
    expect(() => service.history({ id: "nope" })).toThrow("unknown check");
  });
});
