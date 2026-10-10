import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import type { CheckSpec } from "../domain/check.ts";
import type { Exec, ExecResult } from "../ports/index.ts";
import { bunExec } from "./exec.ts";
import { createProbe } from "./probes.ts";

const exec = bunExec();
const probe = createProbe({ exec });

/** Records argv and replies with a canned result. */
function fakeExec(reply: Partial<ExecResult>): Exec & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: "", stderr: "", timedOut: false, ...reply };
    },
  };
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

describe("http probe", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/health") return new Response("status: ok");
        if (path === "/slow") return Bun.sleep(500).then(() => new Response("late"));
        return new Response("nope", { status: 503 });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop(true));

  const http = (path: string, extra: Partial<Extract<CheckSpec, { kind: "http" }>> = {}): CheckSpec => ({
    id: "h",
    kind: "http",
    url: base + path,
    expectStatus: 200,
    timeoutMs: 2000,
    ...extra,
  });

  test("expected status is up", async () => {
    const o = await probe(http("/health"));
    expect(o).toMatchObject({ status: "up", detail: "HTTP 200" });
    expect(o.latencyMs).toBeGreaterThanOrEqual(0);
  });
  test("unexpected status is down", async () => {
    expect(await probe(http("/broken"))).toMatchObject({ status: "down", detail: "HTTP 503 (expected 200)" });
  });
  test("expectStatus can name a non-200 status", async () => {
    expect((await probe(http("/broken", { expectStatus: 503 }))).status).toBe("up");
  });
  test("contains checks the body", async () => {
    expect((await probe(http("/health", { contains: "ok" }))).status).toBe("up");
    expect(await probe(http("/health", { contains: "healthy" }))).toMatchObject({ status: "down" });
  });
  test("timeout is down", async () => {
    expect(await probe(http("/slow", { timeoutMs: 50 }))).toMatchObject({ status: "down", detail: "timed out after 50ms" });
  });
  test("connection refused is down", async () => {
    const port = await freePort();
    expect((await probe({ id: "h", kind: "http", url: `http://127.0.0.1:${port}/`, expectStatus: 200, timeoutMs: 1000 })).status).toBe("down");
  });
});

describe("tcp probe", () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    server = createServer((sock) => sock.end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  test("listening port is up", async () => {
    expect(await probe({ id: "t", kind: "tcp", host: "127.0.0.1", port, timeoutMs: 1000 })).toMatchObject({ status: "up" });
  });
  test("closed port is down", async () => {
    const closed = await freePort();
    expect((await probe({ id: "t", kind: "tcp", host: "127.0.0.1", port: closed, timeoutMs: 1000 })).status).toBe("down");
  });
});

describe("process probe", () => {
  test("finds a running process by command-line substring and loses it once it exits", async () => {
    const marker = `${17 + Math.floor(Math.random() * 1000)}.${process.pid}`;
    const child = Bun.spawn(["sleep", marker], { stdout: "ignore", stderr: "ignore" });
    try {
      const o = await probe({ id: "p", kind: "process", match: `sleep ${marker}` });
      expect(o.status).toBe("up");
      expect(o.detail).toContain(String(child.pid));
    } finally {
      child.kill();
      await child.exited;
    }
    expect((await probe({ id: "p", kind: "process", match: `sleep ${marker}` })).status).toBe("down");
  });
});

describe("command probe", () => {
  test("echo is up and its output becomes the detail", async () => {
    expect(await probe({ id: "c", kind: "command", argv: ["echo", "hello"], expectExit: 0, timeoutMs: 2000 })).toMatchObject({
      status: "up",
      detail: "exit 0: hello",
    });
  });
  test("false is down", async () => {
    expect(await probe({ id: "c", kind: "command", argv: ["false"], expectExit: 0, timeoutMs: 2000 })).toMatchObject({ status: "down", detail: "exit 1" });
  });
  test("expectExit lets a non-zero exit count as up", async () => {
    expect((await probe({ id: "c", kind: "command", argv: ["false"], expectExit: 1, timeoutMs: 2000 })).status).toBe("up");
  });
  test("argv is never interpreted by a shell", async () => {
    const o = await probe({ id: "c", kind: "command", argv: ["echo", "$HOME; false"], expectExit: 0, timeoutMs: 2000 });
    expect(o).toMatchObject({ status: "up", detail: "exit 0: $HOME; false" });
  });
  test("a missing program is down", async () => {
    expect((await probe({ id: "c", kind: "command", argv: ["definitely-not-a-real-program-ops"], expectExit: 0, timeoutMs: 2000 })).status).toBe("down");
  });
  test("a command that overruns its timeout is killed and down", async () => {
    const start = performance.now();
    const o = await probe({ id: "c", kind: "command", argv: ["sleep", "5"], expectExit: 0, timeoutMs: 100 });
    expect(o).toMatchObject({ status: "down", detail: "timed out after 100ms" });
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe("launchd probe (fake exec)", () => {
  test("runs launchctl print for the user's gui domain only", async () => {
    const fx = fakeExec({ stdout: "x = {\n\tstate = running\n\tpid = 42\n}" });
    const p = createProbe({ exec: fx, uid: 501, platform: "darwin" });
    expect(await p({ id: "l", kind: "launchd", label: "homebrew.mxcl.caddy" })).toMatchObject({ status: "up", detail: "running (pid 42)" });
    expect(fx.calls).toEqual([["launchctl", "print", "gui/501/homebrew.mxcl.caddy"]]);
  });
  test("not loaded is down", async () => {
    const p = createProbe({ exec: fakeExec({ code: 113, stderr: "Could not find service" }), uid: 501, platform: "darwin" });
    expect((await p({ id: "l", kind: "launchd", label: "x" })).status).toBe("down");
  });
  test("a launchctl timeout is unknown, not down", async () => {
    const p = createProbe({ exec: fakeExec({ code: -1, timedOut: true }), uid: 501, platform: "darwin" });
    expect((await p({ id: "l", kind: "launchd", label: "x" })).status).toBe("unknown");
  });
  test("off macOS it is unknown and runs nothing", async () => {
    const fx = fakeExec({});
    const p = createProbe({ exec: fx, uid: 1000, platform: "linux" });
    expect((await p({ id: "l", kind: "launchd", label: "x" })).status).toBe("unknown");
    expect(fx.calls).toEqual([]);
  });
});

describe("herdr-pane probe (fake exec)", () => {
  test("runs herdr pane get and reports the pane", async () => {
    const fx = fakeExec({ stdout: JSON.stringify({ result: { pane: { agent: "codex", agent_status: "working" } } }) });
    const p = createProbe({ exec: fx });
    expect(await p({ id: "h", kind: "herdr-pane", paneId: "w1:p3" })).toMatchObject({ status: "up", detail: "codex working" });
    expect(fx.calls).toEqual([["herdr", "pane", "get", "w1:p3"]]);
  });
  test("a missing pane is down", async () => {
    const p = createProbe({ exec: fakeExec({ code: 1, stdout: JSON.stringify({ error: { code: "pane_not_found", message: "nope" } }) }) });
    expect((await p({ id: "h", kind: "herdr-pane", paneId: "w1:p9" })).status).toBe("down");
  });
  test("herdr not installed is unknown", async () => {
    const p = createProbe({ exec: fakeExec({ code: -1, spawnError: "ENOENT" }) });
    expect(await p({ id: "h", kind: "herdr-pane", paneId: "w1:p3" })).toMatchObject({ status: "unknown" });
  });
});
