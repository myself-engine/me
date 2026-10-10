import { expect, test } from "bun:test";
import { renderManifest, substituteArgv, validateConfig, validateParams, type CommandSpec } from "../src/config.ts";

const pr: CommandSpec = {
  argv: ["gh", "pr", "list", "--repo", "{repo}", "--limit={limit}", "--state", "{state}"],
  params: {
    repo: { type: "string", required: true, pattern: "^[\\w.-]+/[\\w.-]+$" },
    limit: { type: "number" },
    state: { type: "string", enum: ["open", "closed"], default: "open" },
    draft: { type: "boolean" },
  },
};

test("validateConfig accepts a well-formed config", () => {
  expect(() => validateConfig({ commands: { "pr.list": pr } })).not.toThrow();
});

test("validateConfig rejects undeclared placeholders, argv[0] placeholders and bad fields", () => {
  const bad = (commands: unknown) => () => validateConfig({ commands });
  expect(bad({ x: { argv: ["echo", "{nope}"] } })).toThrow("undeclared param {nope}");
  expect(bad({ x: { argv: ["{bin}"], params: { bin: { type: "string" } } } })).toThrow("argv[0] cannot contain placeholders");
  expect(bad({ x: { argv: ["echo"], cwd: "/tmp/{dir}" } })).toThrow("cwd uses undeclared param {dir}");
  expect(bad({ x: { argv: [] } })).toThrow("argv must be a non-empty array");
  expect(bad({ x: { argv: ["echo"], parse: "xml" } })).toThrow("parse must be");
  expect(bad({ x: { argv: ["echo"], timeoutMs: -1 } })).toThrow("timeoutMs");
  expect(bad({ x: { argv: ["echo"], params: { a: { type: "object" } } } })).toThrow("params.a.type");
  expect(bad({ x: { argv: ["echo"], params: { a: { type: "string", pattern: "(" } } } })).toThrow("not a valid regular expression");
  expect(bad({})).toThrow("empty");
  expect(() => validateConfig({})).toThrow("config.commands");
});

test("validateParams checks types, required, pattern, enum and unknown params", () => {
  expect(validateParams(pr, { repo: "o/r", limit: 5 })).toEqual({ repo: "o/r", limit: 5, state: "open" });
  expect(() => validateParams(pr, {})).toThrow("missing required param: repo");
  expect(() => validateParams(pr, { repo: "o/r", extra: 1 })).toThrow("unknown param: extra");
  expect(() => validateParams(pr, { repo: "o/r; rm -rf /" })).toThrow("does not match");
  expect(() => validateParams(pr, { repo: "o/r", limit: "5" })).toThrow("limit must be a number");
  expect(() => validateParams(pr, { repo: "o/r", limit: Infinity })).toThrow("limit must be a number");
  expect(() => validateParams(pr, { repo: "o/r", draft: "yes" })).toThrow("draft must be a boolean");
  expect(() => validateParams(pr, { repo: "o/r", state: "merged" })).toThrow("must be one of");
  expect(() => validateParams(pr, [])).toThrow("params must be an object");
  expect(validateParams({ argv: ["echo"] }, undefined)).toEqual({});
});

test("substitution keeps every value inside its own argv element", () => {
  const nasty = `a b; $(whoami) "q" 'x' | && \`id\` \n next`;
  const argv = substituteArgv(["echo", "{v}", "--v={v}", "pre{v}post"], { v: nasty });
  expect(argv).toEqual(["echo", nasty, `--v=${nasty}`, `pre${nasty}post`]);
});

test("substitution drops elements that reference an absent optional param and stringifies values", () => {
  expect(substituteArgv(pr.argv, { repo: "o/r", state: "open" })).toEqual(["gh", "pr", "list", "--repo", "o/r", "--state", "open"]);
  expect(substituteArgv(["x", "{n}", "{b}"], { n: 3, b: false })).toEqual(["x", "3", "false"]);
  // A value that itself looks like a placeholder is not expanded again.
  expect(substituteArgv(["x", "{a}", "{b}"], { a: "{b}", b: "B" })).toEqual(["x", "{b}", "B"]);
});

test("renderManifest lists exactly the configured command names", () => {
  const m = renderManifest("cli-gh", { commands: { "pr.list": pr, "pr.view": { argv: ["gh", "pr", "view"] } } }, "../../bridges/cli/src/main.ts");
  expect(m.provides.methods).toEqual(["pr.list", "pr.view"]);
  expect(m.permissions).toEqual(["shell"]);
  expect(m.run.command).toEqual(["bun", "../../bridges/cli/src/main.ts"]);
  expect(() => renderManifest("cli-x", { commands: { x: { argv: ["{a}"] } } } as any, "m.ts")).toThrow();
});
