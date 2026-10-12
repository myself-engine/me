import { describe, expect, test } from "bun:test";
import { diffHooks, diffInstructions, diffServers, diffSkills, importServers, placeholderize, redactUrl } from "./diff.ts";
import { routes, validateSource, type McpServer, type Target } from "./model.ts";

const T = (harness: Target["harness"], scope: Target["scope"] = "user", section: Target["section"] = "mcpServers"): Target => ({
  id: `${harness}:${scope}`,
  harness,
  scope,
  section,
});
const stdio = (command: string, extra: Partial<McpServer> = {}): McpServer => ({ type: "stdio", command, ...extra });

describe("share policy", () => {
  test("all, lists, and Claude Code scopes", () => {
    expect(routes({ share: "all" }, T("gjc"))).toBe(true);
    expect(routes({ share: ["codex"] }, T("gjc"))).toBe(false);
    expect(routes({ share: "all", scope: "project" }, T("claude-code", "user"))).toBe(false);
    expect(routes({ share: "all", scope: "project" }, T("claude-code", "project"))).toBe(true);
    expect(routes({ share: "all", scope: "project" }, T("codex"))).toBe(true);
    expect(routes({ share: "all" }, T("claude-code", "project"))).toBe(false);
  });

  test("validateSource rejects bad shares and ignores import metadata", () => {
    expect(() => validateSource({ mcpServers: { x: { command: "a", share: ["vim"] } } })).toThrow(/share/);
    expect(() => validateSource({ mcpServers: { x: { command: "a", share: [] } } })).toThrow(/share/);
    expect(() => validateSource({ mcpServers: { x: { share: "all" } } })).toThrow(/command or url/);
    expect(() => validateSource({ mcpServers: { x: { command: "a", env: { K: 1 }, share: "all" } } })).toThrow(/env/);
    expect(validateSource({ _import: {}, mcpServers: { x: { command: "a", share: "all" } } }).mcpServers.x!.share).toBe("all");
  });

  test("validateSource checks skills and hooks", () => {
    const ok = validateSource({
      skills: { s: { dir: "skills/s", share: "all" } },
      hooks: { h: { event: "PreToolUse", matcher: "Bash", command: " guard.sh ", timeout: 5, share: ["codex"] } },
    });
    expect(ok.skills.s).toEqual({ dir: "skills/s", share: "all" });
    expect(ok.hooks.h).toEqual({ event: "PreToolUse", matcher: "Bash", command: "guard.sh", timeout: 5, share: ["codex"] });
    expect(() => validateSource({ skills: { s: { share: "all" } } })).toThrow(/dir is required/);
    expect(() => validateSource({ skills: { "..": { dir: "x", share: "all" } } })).toThrow(/name/);
    expect(() => validateSource({ skills: { "a/b": { dir: "x", share: "all" } } })).toThrow(/name/);
    expect(() => validateSource({ skills: { s: { dir: "x", mode: "move", share: "all" } } })).toThrow(/mode/);
    const hook = (h: Record<string, unknown>) => validateSource({ hooks: { h: { event: "Stop", command: "c", share: "all", ...h } } });
    expect(() => hook({ event: "stop" })).toThrow(/event/);
    expect(() => hook({ command: "a\nb" })).toThrow(/single line/);
    expect(() => hook({ command: "a \\" })).toThrow(/backslash/);
    expect(() => hook({ command: "a # me:harness-config x" })).toThrow(/me:harness-config/);
    expect(() => hook({ timeout: 0 })).toThrow(/timeout/);
    expect(() => hook({ matcher: 1 })).toThrow(/matcher/);
  });
});

describe("diffServers", () => {
  const d = (s: McpServer) => ({ display: s, resolved: s });

  test("added / changed / removed / unchanged, removal only for declared names", () => {
    const { diff, change } = diffServers(
      { a: d(stdio("a")), b: d(stdio("b2")), c: d(stdio("c")) },
      { b: stdio("b"), c: stdio("c"), gone: stdio("g"), mine: stdio("m") },
      new Set(["a", "b", "c", "gone"]),
    );
    expect(diff.added.map((x) => x.name)).toEqual(["a"]);
    expect(diff.changed).toEqual([{ name: "b", fields: [{ field: "command", before: "b", after: "b2" }] }]);
    expect(diff.unchanged).toEqual(["c"]);
    expect(diff.removed).toEqual([{ name: "gone" }]);
    expect(Object.keys(change.upsert)).toEqual(["a", "b"]);
    expect(change.remove).toEqual(["gone"]);
  });

  test("secret fields are compared on resolved values but shown redacted", () => {
    const { diff } = diffServers(
      { s: { display: stdio("s", { env: { K: "${env:K}", L: "literal" } }), resolved: stdio("s", { env: { K: "new", L: "literal" } }) } },
      { s: stdio("s", { env: { K: "old", L: "literal" } }) },
      new Set(["s"]),
    );
    expect(diff.changed[0]!.fields).toEqual([{ field: "env.K", before: "<set>", after: "${env:K}" }]);
  });

  test("urls lose query strings and credentials in plan output", () => {
    expect(redactUrl("https://u:p@host.example/mcp?token=abc")).toBe("https://host.example/mcp?<redacted>");
  });

  test("hooks and skills diff by name; undeclared names are never removed", () => {
    const h = diffHooks(
      { a: { event: "Stop", command: "a" }, b: { event: "Stop", command: "b2" } },
      { b: { event: "Stop", command: "b" }, gone: { event: "Stop", command: "g" }, stray: { event: "Stop", command: "s" } },
      new Set(["a", "b", "gone"]),
    );
    expect(h.diff.added.map((x) => x.name)).toEqual(["a"]);
    expect(h.diff.changed).toEqual([{ name: "b", fields: [{ field: "command", before: "b", after: "b2" }] }]);
    expect(h.diff.removed).toEqual([{ name: "gone" }]);

    const link = { mode: "link" as const, source: "/src/s", state: { kind: "link" as const, target: "/real/s" } };
    const k = diffSkills({ s: link, t: link }, { s: { kind: "link", target: "/real/s" }, t: { kind: "link", target: "/other" }, u: { kind: "file" } }, new Set(["s", "t"]));
    expect(k.diff.unchanged).toEqual(["s"]);
    expect(k.diff.changed).toEqual([{ name: "t", fields: [{ field: "target", before: "/other", after: "/src/s" }] }]);
    expect(k.diff.removed).toEqual([]);
  });

  test("instructions diff by content", () => {
    const { diff } = diffInstructions({ a: "x\n", b: "new" }, { a: "x", b: "old", c: "gone" }, new Set(["a", "b", "c"]));
    expect(diff.unchanged).toEqual(["a"]);
    expect(diff.changed.map((c) => c.name)).toEqual(["b"]);
    expect(diff.removed).toEqual([{ name: "c" }]);
  });
});

describe("import", () => {
  test("placeholderize never keeps a literal secret", () => {
    const p = placeholderize("my server", {
      type: "http",
      url: "https://x",
      headers: { Authorization: "Bearer abc", "X-Ref": "${env:KEEP}" },
      env: { A: "secret", B: "{env:OC}", C: "${CLAUDE_VAR}", D: "${file:~/k}" },
    });
    expect(p.headers).toEqual({ Authorization: "${env:MY_SERVER_AUTHORIZATION}", "X-Ref": "${env:KEEP}" });
    expect(p.env).toEqual({ A: "${env:A}", B: "${env:OC}", C: "${env:CLAUDE_VAR}", D: "${file:~/k}" });
  });

  test("identical entries merge into one share list; differing ones become conflicts", () => {
    const r = importServers([
      { harness: "claude-code", scope: "user", servers: { same: stdio("x"), diff: stdio("a") } },
      { harness: "codex", scope: "user", servers: { same: stdio("x"), diff: stdio("b") } },
      { harness: "opencode", scope: "user", servers: { same: stdio("x") } },
      { harness: "gjc", scope: "user", servers: { same: stdio("x") } },
      { harness: "claude-code", scope: "project", servers: { proj: stdio("p") } },
    ]);
    expect(r.mcpServers.same).toEqual({ type: "stdio", command: "x", share: "all" });
    expect(r.mcpServers.proj).toEqual({ type: "stdio", command: "p", share: ["claude-code"], scope: "project" });
    expect(r.mcpServers.diff).toBeUndefined();
    expect(r.conflicts.diff).toEqual({ targets: ["claude-code:user", "codex:user"], fields: ["command"] });
  });
});
