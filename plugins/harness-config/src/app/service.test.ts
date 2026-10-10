import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { composeService } from "../adapters/compose.ts";
import { makeFixture, SECRETS, type Fixture } from "./fixtures.ts";
import type { Plan } from "./service.ts";

let fx: Fixture;
beforeEach(() => (fx = makeFixture()));
afterEach(() => fx.cleanup());

const svc = (events?: { emit(n: string, d: unknown): Promise<void> }) =>
  composeService({ home: fx.home, meHome: fx.meHome, env: fx.env, events });
const target = (plan: Plan, id: string) => plan.targets.find((t) => t.target === id)!;
const names = (xs: { name: string }[]) => xs.map((x) => x.name).sort();
const read = (rel: string) => readFileSync(join(fx.home, rel), "utf8");
const json = (rel: string) => JSON.parse(read(rel));
const secretFree = (v: unknown) => {
  const s = JSON.stringify(v);
  for (const secret of Object.values(SECRETS)) expect(s).not.toContain(secret);
};

describe("plan", () => {
  test("share policy routes entries to the right harnesses; undeclared names are untouched", async () => {
    const plan = await svc().plan();
    expect(plan.ok).toBe(true);
    const claude = target(plan, "claude-code:user").diff;
    expect(names(claude.added)).toEqual(["notion"]);
    expect(names(claude.changed)).toEqual(["pencil"]);
    expect(claude.removed).toEqual([]);

    const codex = target(plan, "codex:user").diff;
    expect(names(codex.added)).toEqual(["notion"]);
    expect(names(codex.changed)).toEqual(["pencil"]);

    // pencil is declared but shared only with claude-code and codex, so it leaves opencode and gjc.
    const opencode = target(plan, "opencode:user").diff;
    expect(names(opencode.added)).toEqual(["notion"]);
    expect(names(opencode.removed)).toEqual(["pencil"]);
    const gjc = target(plan, "gjc:user").diff;
    expect(names(gjc.removed)).toEqual(["pencil"]);
    expect(names(gjc.changed)).toEqual(["notion"]); // gains its Authorization header

    // Unmanaged names never appear anywhere in the plan.
    const all = JSON.stringify(plan.targets.map((t) => t.diff));
    for (const n of ["private-claude", "private-codex", "figma", "local-only"]) expect(all).not.toContain(n);

    expect(names(target(plan, "claude-code:instructions").diff.added)).toEqual(["style"]);
    expect(names(target(plan, "codex:instructions").diff.added)).toEqual(["style"]);
    expect(target(plan, "opencode:instructions").diff.added).toEqual([]);
  });

  test("plan output never contains secret values", async () => {
    const plan = await svc().plan();
    secretFree(plan);
    const pencil = target(plan, "claude-code:user").diff.changed[0]!;
    expect(pencil.fields).toContainEqual({ field: "env.API_KEY", before: "<set>", after: "${file:~/.config/me/pencil.key}" });
  });

  test("an unresolvable reference is a target error, not a crash", async () => {
    const plan = await composeService({ home: fx.home, meHome: fx.meHome, env: { HOME: fx.home } }).plan();
    expect(plan.ok).toBe(false);
    expect(target(plan, "codex:user").error).toContain("${env:NOTION_TOKEN}");
    secretFree(plan);
  });
});

describe("apply", () => {
  test("refuses without approvalId, without planId, and with a stale planId", async () => {
    const s = svc();
    const plan = await s.plan();
    await expect(s.apply({ planId: plan.planId } as any)).rejects.toThrow(/approvalId is required/);
    await expect(s.apply({ planId: plan.planId, approvalId: "  " })).rejects.toThrow(/approvalId is required/);
    await expect(s.apply({ approvalId: "a1" } as any)).rejects.toThrow(/planId is required/);
    fx.write("home/.gjc/agent/mcp.json", JSON.stringify({ mcpServers: {} }));
    await expect(s.apply({ planId: plan.planId, approvalId: "a1" })).rejects.toThrow(/stale/);
    expect(read(".claude.json")).not.toContain(SECRETS.notionToken);
  });

  test("writes merged files, backs each one up first, and preserves unrelated keys", async () => {
    const before = { claude: read(".claude.json"), codex: read(".codex/config.toml") };
    const events: [string, unknown][] = [];
    const s = svc({ emit: async (n, d) => void events.push([n, d]) });
    const plan = await s.plan();
    const res = await s.apply({ planId: plan.planId, approvalId: "approval-1" });

    // Backups next to each (real) file, holding the exact previous bytes.
    const claudeBackup = res.applied.find((a) => a.target === "claude-code:user")!.backup!;
    expect(dirname(claudeBackup)).toBe(fx.home);
    expect(readFileSync(claudeBackup, "utf8")).toBe(before.claude);
    const codexBackup = res.applied.find((a) => a.target === "codex:user")!.backup!;
    expect(dirname(codexBackup)).toBe(dirname(fx.codexReal));
    expect(readFileSync(codexBackup, "utf8")).toBe(before.codex);
    expect(statSync(claudeBackup).mode & 0o777).toBe(0o600);
    // CLAUDE.md existed; codex AGENTS.md did not, so it gets no backup.
    expect(res.applied.find((a) => a.target === "codex:instructions")!.backup).toBeNull();

    // Claude: unrelated top-level keys, local-scope servers and unmanaged servers survive.
    const claude = json(".claude.json");
    expect(claude.numStartups).toBe(42);
    expect(claude.oauthAccount).toEqual({ emailAddress: "someone@example.com" });
    expect(claude.projects["/tmp/project"].mcpServers["local-only"]).toBeDefined();
    expect(claude.mcpServers["private-claude"].headers.Authorization).toBe(SECRETS.existingAuth);
    expect(claude.mcpServers.pencil).toEqual({ type: "stdio", command: "pencil", args: ["--stdio"], env: { API_KEY: SECRETS.pencilKey } });
    expect(claude.mcpServers.notion).toEqual({ type: "http", url: "https://mcp.notion.com/mcp", headers: { Authorization: `Bearer ${SECRETS.notionToken}` } });
    expect(Object.keys(claude)).toEqual(Object.keys(JSON.parse(before.claude)));
    expect(statSync(join(fx.home, ".claude.json")).mode & 0o777).toBe(0o600);

    // Codex: still a symlink; comments, unrelated tables and harness-only keys survive.
    expect(lstatSync(join(fx.home, ".codex/config.toml")).isSymbolicLink()).toBe(true);
    const toml = readFileSync(fx.codexReal, "utf8");
    for (const line of [
      "# Codex config, hand-maintained",
      'model = "gpt-5"  # trailing comment',
      "# keep this note about mcp servers",
      '  "a",  # inline note in an array, in a table we do not own',
      "# trailing table belongs to the user",
      '[shell_environment_policy.set]\nFOO = "bar"',
      '[projects."/tmp/project"]\ntrust_level = "trusted"',
    ])
      expect(toml).toContain(line);
    const parsed = Bun.TOML.parse(toml) as any;
    expect(parsed.mcp_servers.pencil).toEqual({ command: "pencil", args: ["--stdio"], enabled: true, startup_timeout_sec: 30, env: { API_KEY: SECRETS.pencilKey } });
    expect(parsed.mcp_servers.notion).toEqual({ url: "https://mcp.notion.com/mcp", http_headers: { Authorization: `Bearer ${SECRETS.notionToken}` } });
    expect(parsed.mcp_servers["private-codex"]).toEqual({ command: "only-codex", args: ["a"] });
    expect(statSync(fx.codexReal).mode & 0o777).toBe(0o644);

    // OpenCode: pencil removed (not shared), figma (unmanaged) kept with its extras.
    const oc = json(".config/opencode/opencode.json");
    expect(oc.mcp.pencil).toBeUndefined();
    expect(oc.mcp.figma).toEqual({ type: "local", command: ["figma-mcp"], environment: { FIGMA_API_KEY: SECRETS.opencodeFigma }, enabled: false, timeout: 5000 });
    expect(oc.mcp.notion).toEqual({ type: "remote", url: "https://mcp.notion.com/mcp", headers: { Authorization: `Bearer ${SECRETS.notionToken}` } });
    expect(oc.permission).toEqual({ edit: "ask" });

    // GJC: owned fields replaced, harness-only fields (sharing, timeout, oauth) kept.
    const gjc = json(".gjc/agent/mcp.json");
    expect(gjc.mcpServers.notion).toEqual({
      sharing: "per-session",
      timeout: 9,
      type: "http",
      url: "https://mcp.notion.com/mcp",
      oauth: { clientId: "id" },
      headers: { Authorization: `Bearer ${SECRETS.notionToken}` },
    });
    expect(gjc.mcpServers.pencil).toBeUndefined();

    // Instructions: user text kept, managed block added.
    expect(read(".claude/CLAUDE.md")).toBe(
      "# My global rules\n\nBe nice.\n\n<!-- me:harness-config:begin style -->\nPrefer small commits.\nWrite tests first.\n<!-- me:harness-config:end style -->\n",
    );

    expect(events).toHaveLength(1);
    expect(events[0]![0]).toBe("applied");
    secretFree(events);

    // Idempotent: a second plan has nothing to do.
    expect((await s.plan()).changes).toBe(0);
  });

  test("apply refuses when a comment sits inside an owned Codex table, unless forced", async () => {
    fx.write("stack/codex/config.toml", readFileSync(fx.codexReal, "utf8").replace("enabled = true", "enabled = true # keep me"), 0o644);
    const s = svc();
    const plan = await s.plan();
    expect(target(plan, "codex:user").error).toMatch(/comments inside \[mcp_servers\.pencil\]/);
    await expect(s.apply({ planId: plan.planId, approvalId: "a" })).rejects.toThrow(/refusing to apply/);
    expect(readdirSync(dirname(fx.codexReal)).filter((f) => f.includes("me-backup"))).toEqual([]);

    const forced = await s.plan({ force: true });
    expect(forced.ok).toBe(true);
    await s.apply({ planId: forced.planId, approvalId: "a", force: true });
    expect(readFileSync(fx.codexReal, "utf8")).not.toContain("# keep me");
    expect(readFileSync(fx.codexReal, "utf8")).toContain("# Codex config, hand-maintained");
  });

  test("harness filter limits plan and apply", async () => {
    const s = svc();
    const plan = await s.plan({ harnesses: ["gjc"] });
    expect(plan.targets.map((t) => t.target)).toEqual(["gjc:user", "gjc:instructions"]);
    const before = read(".claude.json");
    await s.apply({ planId: plan.planId, approvalId: "a", harnesses: ["gjc"] });
    expect(read(".claude.json")).toBe(before);
    expect(json(".gjc/agent/mcp.json").mcpServers.pencil).toBeUndefined();
    await expect(s.plan({ harnesses: ["vim"] })).rejects.toThrow(/unknown harness/);
  });
});

describe("claude-code project scope", () => {
  test("scope: project routes to <projectDir>/.mcp.json and nowhere in ~/.claude.json", async () => {
    const proj = join(fx.root, "project");
    fx.write("project/.mcp.json", JSON.stringify({ mcpServers: { keep: { command: "k" } } }, null, 2) + "\n", 0o644);
    fx.write(
      "me-home/harness-config/source.json",
      JSON.stringify({ mcpServers: { db: { command: "db-mcp", scope: "project", share: ["claude-code", "codex"] } } }),
    );
    const s = composeService({ home: fx.home, meHome: fx.meHome, env: fx.env, projectDir: proj });
    const plan = await s.plan({ harnesses: ["claude-code"] });
    expect(names(target(plan, "claude-code:project").diff.added)).toEqual(["db"]);
    expect(target(plan, "claude-code:user").diff.added).toEqual([]);
    await s.apply({ planId: plan.planId, approvalId: "a", harnesses: ["claude-code"] });
    const mcp = JSON.parse(readFileSync(join(proj, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers).toEqual({ keep: { command: "k" }, db: { type: "stdio", command: "db-mcp", args: [], env: {} } });
    expect(readdirSync(proj).some((f) => f.startsWith(".mcp.json.me-backup-"))).toBe(true);
  });
});

describe("import", () => {
  test("drafts a source from harness files without copying secrets, and marks conflicts", async () => {
    const res = await svc().import({});
    expect(res.written).toBeNull();
    secretFree(res);
    expect(res.counts["claude-code:user"]).toEqual({ entries: 2 });
    expect(res.counts["codex:user"]).toEqual({ entries: 2 });
    expect(res.counts["opencode:user"]).toEqual({ entries: 2 });
    expect(res.counts["gjc:user"]).toEqual({ entries: 2 });

    // pencil differs between claude, codex, opencode and gjc: a conflict, left out of the draft.
    expect(res.conflicts.pencil!.targets.sort()).toEqual(["claude-code:user", "codex:user", "gjc:user", "opencode:user"]);
    expect(res.conflicts.pencil!.fields).toContain("command");
    expect(res.draft.mcpServers.pencil).toBeUndefined();

    // Secrets become references.
    expect(res.draft.mcpServers["private-claude"]).toEqual({
      type: "http",
      url: "https://private.example/mcp",
      headers: { Authorization: "${env:PRIVATE_CLAUDE_AUTHORIZATION}" },
      share: ["claude-code"],
    });
    expect(res.draft.mcpServers.figma).toMatchObject({ env: { FIGMA_API_KEY: "${env:FIGMA_API_KEY}" }, share: ["opencode"] });
    expect(res.draft.mcpServers.notion).toMatchObject({ url: "https://mcp.notion.com/mcp", share: ["gjc"] });
  });

  test("import with write: true writes source.draft.json next to source.json and never overwrites source.json", async () => {
    const sourcePath = join(fx.meHome, "harness-config", "source.json");
    const before = readFileSync(sourcePath, "utf8");
    const res = await svc().import({ write: true });
    expect(res.written).toBe(join(fx.meHome, "harness-config", "source.draft.json"));
    expect(readFileSync(sourcePath, "utf8")).toBe(before);
    const draft = readFileSync(res.written!, "utf8");
    for (const secret of Object.values(SECRETS)) expect(draft).not.toContain(secret);
    expect(JSON.parse(draft)._import.conflicts.pencil).toBeDefined();
  });
});

describe("list", () => {
  test("shows source routing and managed vs unmanaged names per file", async () => {
    const l = await svc().list();
    expect(l.source.mcpServers.pencil!.targets).toEqual(["claude-code:user", "codex:user"]);
    expect(l.source.mcpServers.notion!.targets).toEqual(["claude-code:user", "codex:user", "opencode:user", "gjc:user"]);
    expect(l.files.find((f) => f.target === "claude-code:user")).toMatchObject({ managed: ["pencil"], unmanaged: ["private-claude"] });
    secretFree(l);
  });
});
