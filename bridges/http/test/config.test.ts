import { expect, test } from "bun:test";
import { buildBody, buildPlainHeaders, buildUrl, renderManifest, validateConfig, type EndpointSpec } from "../src/config.ts";

const issue: EndpointSpec = {
  url: "https://api.example.com/repos/{owner}/{repo}/issues/{n}",
  query: { state: "{state}", per_page: "{limit}" },
  params: {
    owner: { type: "string", required: true },
    repo: { type: "string", required: true },
    n: { type: "number", required: true },
    state: { type: "string", enum: ["open", "closed"], default: "open" },
    limit: { type: "number" },
  },
  parse: "json",
};

test("validateConfig accepts a well-formed config", () => {
  expect(() => validateConfig({ endpoints: { "issue.get": issue } })).not.toThrow();
  expect(() => validateConfig({ baseUrl: "http://127.0.0.1:1/v1", endpoints: { a: { url: "/x" } } })).not.toThrow();
});

test("validateConfig rejects placeholders outside the path and other bad fields", () => {
  const bad = (endpoints: unknown, extra: object = {}) => () => validateConfig({ endpoints, ...extra });
  const p = { h: { type: "string", required: true } };
  expect(bad({ x: { url: "https://{h}/a", params: p } })).toThrow("scheme, host or port");
  expect(bad({ x: { url: "https://api.example.com:{h}/a", params: p } })).toThrow("scheme, host or port");
  expect(bad({ x: { url: "https://a.example/x?q={h}", params: p } })).toThrow("use query");
  expect(bad({ x: { url: "https://a.example/{nope}" } })).toThrow("undeclared param {nope}");
  expect(bad({ x: { url: "https://a.example/{o}", params: { o: { type: "string" } } } })).toThrow("must be required or have a default");
  expect(bad({ x: { url: "/a" } })).toThrow("no baseUrl");
  expect(bad({ x: { url: "/a" } }, { baseUrl: "https://{h}" })).toThrow("baseUrl cannot contain placeholders");
  expect(bad({ x: { url: "ftp://a.example/" } })).toThrow("http(s) URL");
  expect(bad({ x: { url: "https://a.example/", body: { a: 1 } } })).toThrow("GET cannot have a body");
  expect(bad({ x: { url: "https://a.example/", method: "POST", body: { a: "{b}" } } })).toThrow("body uses undeclared param {b}");
  expect(bad({ x: { url: "https://a.example/", headers: { "x-a": "{b}" } } })).toThrow("headers.x-a uses undeclared param {b}");
  expect(bad({ x: { url: "https://a.example/", headers: { "bad name": "v" } } })).toThrow("invalid header name");
  expect(bad({ x: { url: "https://a.example/", headers: { auth: { file: "/k", format: "Bearer" } } } })).toThrow("{secret}");
  expect(bad({ x: { url: "https://a.example/", parse: "xml" } })).toThrow("parse must be");
  expect(bad({ x: { url: "https://a.example/", maxBytes: 0 } })).toThrow("maxBytes");
  expect(bad({ x: { url: "https://a.example/", method: "TRACE" } })).toThrow("method must be one of");
  expect(bad({})).toThrow("empty");
  expect(() => validateConfig({})).toThrow("config.endpoints");
});

test("buildUrl percent-encodes path values and keeps the origin fixed", () => {
  const url = buildUrl({}, issue, { owner: "a/../b", repo: "r?x=1#f", n: 7, state: "open" });
  expect(url.origin).toBe("https://api.example.com");
  expect(url.pathname).toBe("/repos/a%2F..%2Fb/r%3Fx%3D1%23f/issues/7");
  expect(url.search).toBe("?state=open");
  expect(() => buildUrl({}, issue, { owner: "..", repo: "r", n: 1 })).toThrow("not allowed");
  const withLimit = buildUrl({}, issue, { owner: "o", repo: "r", n: 1, state: "closed", limit: 5 });
  expect(withLimit.searchParams.get("per_page")).toBe("5");
  expect(buildUrl({}, { url: "https://a.example/s", query: { q: "{q}" }, params: { q: { type: "string" } } }, { q: "a&b=c d" }).search).toBe(
    "?q=a%26b%3Dc+d",
  );
  expect(buildUrl({ baseUrl: "http://127.0.0.1:9/v1/" }, { url: "/x/{a}", params: { a: { type: "string", required: true } } }, { a: "y" }).href).toBe(
    "http://127.0.0.1:9/v1/x/y",
  );
});

test("plain headers are filled from params and absent optional ones dropped", () => {
  const values = { id: "abc" };
  expect(buildPlainHeaders({ "x-id": "id={id}", "x-opt": "{missing}", auth: { file: "/k" } }, values)).toEqual({ "x-id": "id=abc" });
  expect(() => buildPlainHeaders({ "x-id": "{id}" }, { id: "a\r\nInjected: 1" })).toThrow("line break");
});

test("body template keeps types for whole placeholders and drops absent optional values", () => {
  const ep: EndpointSpec = {
    url: "https://a.example/",
    method: "POST",
    body: { title: "{title}", n: "{n}", flag: "{flag}", note: "re: {title}", tags: ["{tag}", "x"], opt: "{opt}" },
  };
  const b = buildBody(ep, { title: "T", n: 3, flag: false });
  expect(b?.contentType).toBe("application/json");
  expect(JSON.parse(b!.body)).toEqual({ title: "T", n: 3, flag: false, note: "re: T", tags: ["x"] });
  expect(buildBody({ url: "https://a.example/", method: "POST", body: "hi {who}" }, { who: "me" })).toEqual({
    body: "hi me",
    contentType: "text/plain; charset=utf-8",
  });
  expect(buildBody({ url: "https://a.example/" }, {})).toBe(null);
});

test("renderManifest lists exactly the configured endpoint names and declares network", () => {
  const m = renderManifest("http-gh", { endpoints: { "issue.get": issue, ping: { url: "https://a.example/" } } }, "../../bridges/http/src/main.ts");
  expect(m.provides.methods).toEqual(["issue.get", "ping"]);
  expect(m.permissions).toEqual(["network"]);
  expect(m.run.command).toEqual(["bun", "../../bridges/http/src/main.ts"]);
  expect(() => renderManifest("http-x", { endpoints: { x: { url: "https://{h}/" } } } as any, "m.ts")).toThrow();
});
