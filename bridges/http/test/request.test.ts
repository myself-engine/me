import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorCode } from "@me/protocol";
import type { HttpConfig } from "../src/config.ts";
import { sendRequest } from "../src/request.ts";
import { startServer } from "./fixtures/server.ts";

const SECRET = "s3cr3t-token-value-0123456789";
let server: ReturnType<typeof startServer>;
let dir: string;
let secretPath: string;
let config: HttpConfig;

beforeAll(() => {
  server = startServer();
  dir = mkdtempSync(join(tmpdir(), "me-http-"));
  secretPath = join(dir, "token");
  writeFileSync(secretPath, SECRET + "\n");
  config = { baseUrl: `http://127.0.0.1:${server.port}`, endpoints: {} };
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

test("path params are encoded, query and body filled, secret header sent but never returned", async () => {
  const r = await sendRequest(
    "t",
    config,
    {
      method: "POST",
      url: "/echo/{id}",
      query: { q: "{q}" },
      params: { id: { type: "string", required: true }, q: { type: "string" }, n: { type: "number" } },
      headers: { authorization: { file: secretPath, format: "Bearer {secret}" }, "x-id": "{id}" },
      body: { n: "{n}", id: "{id}" },
      parse: "json",
    },
    { id: "a/b c", q: "x&y", n: 2 },
  );
  const body = r.body as any;
  expect(r.status).toBe(200);
  expect(body.path).toBe("/echo/a%2Fb%20c");
  expect(body.search).toBe("?q=x%26y");
  expect(body.headers.authorization).toBe(`Bearer ${SECRET}`);
  expect(body.headers["x-id"]).toBe("a/b c");
  expect(body.headers["content-type"]).toBe("application/json");
  expect(JSON.parse(body.body)).toEqual({ n: 2, id: "a/b c" });
  // The fake server echoed the header back; the bridge itself adds nothing that holds it.
  const { body: _echo, ...rest } = r;
  expect(JSON.stringify(rest)).not.toContain(SECRET);
});

test("an unreadable secret file fails without leaking anything but the path", async () => {
  const err: any = await sendRequest("t", config, { url: "/hello", headers: { authorization: { file: join(dir, "nope") } } }, {}).catch((e) => e);
  expect(err.message).toContain("unreadable");
  expect(err.message).toContain(join(dir, "nope"));
  const ep = { url: "/echo", headers: { authorization: { file: secretPath } } };
  const res: any = await sendRequest("t", { ...config, endpoints: {} }, { ...ep, parse: "json", url: "/missing", failOnError: true }, {}).catch((e) => e);
  expect(JSON.stringify({ message: res.message, data: res.data })).not.toContain(SECRET);
});

test("invalid params are rejected before any request", async () => {
  const ep = { url: "/echo/{id}", params: { id: { type: "string" as const, required: true, pattern: "^[a-z]+$" } } };
  for (const params of [{}, { id: "A" }, { id: 1 }, { id: "ok", other: 1 }, { id: ".." }]) {
    const err: any = await sendRequest("t", config, ep, params).catch((e) => e);
    expect(err.code).toBe(-32602);
  }
});

test("parse modes and non-2xx results", async () => {
  expect((await sendRequest("t", config, { url: "/hello" }, {})).body).toBe("hello\n");
  const miss = await sendRequest("t", config, { url: "/missing", parse: "json" }, {});
  expect(miss).toMatchObject({ status: 404, ok: false, body: "no such thing" });
  const err: any = await sendRequest("t", config, { url: "/missing", failOnError: true }, {}).catch((e) => e);
  expect(err.message).toContain("HTTP 404");
  expect(err.data.status).toBe(404);
  const notJson: any = await sendRequest("t", config, { url: "/html", parse: "json" }, {}).catch((e) => e);
  expect(notJson.message).toContain("not valid JSON");
});

test("redirects are returned, not followed", async () => {
  const r = await sendRequest("t", config, { url: "/redirect" }, {});
  expect(r).toMatchObject({ status: 302, ok: false, location: "http://elsewhere.invalid/" });
});

test("responses are capped at maxBytes", async () => {
  const r = await sendRequest("t", config, { url: "/big", maxBytes: 1000 }, {});
  expect((r.body as string).length).toBe(1000);
  expect(r.truncated).toBe(true);
  const capped = await sendRequest("t", { ...config, maxBytes: 10 }, { url: "/hello" }, {});
  expect(capped.body).toBe("hello\n");
  const err: any = await sendRequest("t", config, { url: "/big", maxBytes: 1000, parse: "json" }, {}).catch((e) => e);
  expect(err.message).toContain("exceeds maxBytes");
});

test("timeoutMs aborts the request", async () => {
  const started = Date.now();
  const err: any = await sendRequest("t", config, { url: "/slow", timeoutMs: 200 }, {}).catch((e) => e);
  expect(err.code).toBe(ErrorCode.Timeout);
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("aborting the signal cancels the request", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const err: any = await sendRequest("t", config, { url: "/slow" }, {}, { signal: ac.signal }).catch((e) => e);
  expect(err.code).toBe(ErrorCode.Cancelled);
});
