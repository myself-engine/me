import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
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
    expect(plan.targets.map((t) => t.target)).toEqual(["gjc:user", "gjc:instructions", "gjc:skills"]);
    expect(plan.unsupported).toEqual([{ target: "gjc:hooks", harness: "gjc", reason: expect.stringContaining("GJC"), skipped: ["fmt-after-edit"] }]);
    const before = read(".claude.json");
    await s.apply({ planId: plan.planId, approvalId: "a", harnesses: ["gjc"] });
    expect(read(".claude.json")).toBe(before);
    expect(json(".gjc/agent/mcp.json").mcpServers.pencil).toBeUndefined();
    await expect(s.plan({ harnesses: ["vim"] })).rejects.toThrow(/unknown harness/);
  });
});

describe("skills", () => {
  test("plan links, copies, replaces and leaves unmanaged entries alone", async () => {
    const plan = await svc().plan();
    expect(plan.ok).toBe(true);
    const claude = target(plan, "claude-code:skills");
    expect(claude.path).toBe(join(fx.home, ".claude/skills"));
    expect(claude.diff.added).toEqual([{ name: "review", after: { mode: "link", target: fx.skillSrc.review } }]);
    // Codex: review is a hand-made copy (becomes a link), fmt is copied in.
    const codex = target(plan, "codex:skills").diff;
    expect(names(codex.added)).toEqual(["fmt"]);
    expect(codex.added.find((a) => a.name === "fmt")!.after).toMatchObject({ mode: "copy", content: expect.stringMatching(/^2 files #/) });
    expect(codex.changed).toEqual([
      { name: "review", fields: [{ field: "mode", before: "copy", after: "link" }, expect.objectContaining({ field: "content" }), { field: "target", before: undefined, after: fx.skillSrc.review }] },
    ]);
    // OpenCode's skills directory is a symlink and already links review: nothing to do.
    expect(target(plan, "opencode:skills").diff.unchanged).toEqual(["review"]);
    expect(target(plan, "gjc:skills")).toMatchObject({ exists: false, diff: { added: [{ name: "review" }] } });
    const all = JSON.stringify(plan.targets.map((t) => t.diff));
    for (const n of ["mine", "shared"]) expect(all).not.toContain(`"${n}"`);
  });

  test("apply backs up beside the skills directory, writes only owned entries, then has nothing to do", async () => {
    const s = svc();
    const plan = await s.plan();
    const res = await s.apply({ planId: plan.planId, approvalId: "a" });
    const codexSkills = join(fx.home, ".codex/skills");

    expect(readlinkSync(join(fx.home, ".claude/skills/review"))).toBe(fx.skillSrc.review);
    expect(readlinkSync(join(codexSkills, "review"))).toBe(fx.skillSrc.review);
    expect(lstatSync(join(codexSkills, "fmt")).isDirectory()).toBe(true);
    expect(readFileSync(join(codexSkills, "fmt/scripts/run.sh"), "utf8")).toBe("#!/bin/sh\nexit 0\n");
    expect(statSync(join(codexSkills, "fmt/scripts/run.sh")).mode & 0o111).not.toBe(0);
    expect(readlinkSync(join(fx.home, ".gjc/agent/skills/review"))).toBe(fx.skillSrc.review);
    // Unmanaged entries and the OpenCode directory link survive.
    expect(readFileSync(join(fx.home, ".claude/skills/mine/SKILL.md"), "utf8")).toContain("unmanaged");
    expect(lstatSync(join(fx.home, ".claude/skills/shared")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(fx.home, ".config/opencode/skills")).isSymbolicLink()).toBe(true);
    // No temp entries are left inside a skills directory.
    for (const d of [join(fx.home, ".claude/skills"), codexSkills, fx.opencodeSkillsReal])
      expect(readdirSync(d).filter((n) => n.includes("me-tmp"))).toEqual([]);

    // Codex's old copy is backed up beside the skills directory, not inside it.
    const backup = res.applied.find((a) => a.target === "codex:skills")!.backup!;
    expect(dirname(backup)).toBe(join(fx.home, ".codex"));
    expect(backup).toMatch(/skills\.me-backup-/);
    expect(readFileSync(join(backup, "review/SKILL.md"), "utf8")).toContain("old copy");
    expect(readdirSync(codexSkills).some((n) => n.includes("backup"))).toBe(false);
    // Nothing existed for claude's review, so no backup directory.
    expect(res.applied.find((a) => a.target === "claude-code:skills")!.backup).toBeNull();
    expect(res.applied.some((a) => a.target === "opencode:skills")).toBe(false);

    expect((await s.plan()).changes).toBe(0);
  });

  test("an edited copy is changed; a skill no longer shared is removed with a backup", async () => {
    const s = svc();
    await s.apply({ planId: (await s.plan()).planId, approvalId: "a" });
    fx.write("me-home/harness-config/skills/fmt/SKILL.md", "---\nname: fmt\n---\nnew text\n");
    let plan = await s.plan({ harnesses: ["codex"] });
    expect(names(target(plan, "codex:skills").diff.changed)).toEqual(["fmt"]);
    await s.apply({ planId: plan.planId, approvalId: "a", harnesses: ["codex"] });
    expect(readFileSync(join(fx.home, ".codex/skills/fmt/SKILL.md"), "utf8")).toContain("new text");

    const src = JSON.parse(readFileSync(join(fx.meHome, "harness-config/source.json"), "utf8"));
    src.skills.review.share = ["opencode"];
    fx.write("me-home/harness-config/source.json", JSON.stringify(src));
    plan = await s.plan({ harnesses: ["claude-code"] });
    expect(target(plan, "claude-code:skills").diff.removed).toEqual([{ name: "review" }]);
    const res = await s.apply({ planId: plan.planId, approvalId: "a", harnesses: ["claude-code"] });
    expect(existsSync(join(fx.home, ".claude/skills/review"))).toBe(false);
    // The backup of a link is a link, and the source directory it pointed at is untouched.
    const backup = res.applied.find((a) => a.target === "claude-code:skills")!.backup!;
    expect(readlinkSync(join(backup, "review"))).toBe(fx.skillSrc.review);
    expect(existsSync(join(fx.skillSrc.review, "SKILL.md"))).toBe(true);
  });

  test("a missing SKILL.md or a source inside the skills directory is a target error", async () => {
    fx.write("home/.claude/skills/inside/SKILL.md", "x\n");
    fx.write("me-home/harness-config/skills/empty/README.md", "x\n");
    fx.write(
      "me-home/harness-config/source.json",
      JSON.stringify({
        skills: { inside: { dir: "~/.claude/skills/inside", share: ["claude-code"] }, empty: { dir: "skills/empty", share: ["codex"] } },
      }),
    );
    const s = svc();
    const plan = await s.plan();
    expect(plan.ok).toBe(false);
    expect(target(plan, "claude-code:skills").error).toMatch(/inside .*lies inside/);
    expect(target(plan, "codex:skills").error).toMatch(/no SKILL\.md/);
    await expect(s.apply({ planId: plan.planId, approvalId: "a" })).rejects.toThrow(/refusing to apply/);
    expect(readFileSync(join(fx.home, ".claude/skills/inside/SKILL.md"), "utf8")).toBe("x\n");
  });

  test("apply refuses when a skill entry changed after plan", async () => {
    const s = svc();
    const plan = await s.plan({ harnesses: ["codex"] });
    fx.write("home/.codex/skills/review/SKILL.md", "edited after plan\n");
    await expect(s.apply({ planId: plan.planId, approvalId: "a", harnesses: ["codex"] })).rejects.toThrow(/stale|changed during apply/);
    expect(readFileSync(join(fx.home, ".codex/skills/review/SKILL.md"), "utf8")).toBe("edited after plan\n");
  });
});

describe("hooks", () => {
  test("plan adds, removes and marks unsupported harnesses explicitly", async () => {
    const plan = await svc().plan();
    expect(plan.ok).toBe(true);
    const claude = target(plan, "claude-code:hooks");
    expect(claude.path).toBe(join(fx.home, ".claude/settings.json"));
    expect(claude.diff.added).toEqual([
      { name: "fmt-after-edit", after: { event: "PostToolUse", matcher: "Edit|Write", command: "bunx prettier --write .", timeout: 30 } },
      { name: "bell", after: { event: "Stop", command: "printf '\\a'" } },
    ]);
    const codex = target(plan, "codex:hooks").diff;
    expect(names(codex.added)).toEqual(["fmt-after-edit"]);
    expect(codex.removed).toEqual([{ name: "bell" }]);
    expect(plan.targets.some((t) => t.target === "opencode:hooks" || t.target === "gjc:hooks")).toBe(false);
    expect(plan.unsupported.map((u) => [u.target, u.skipped])).toEqual([
      ["opencode:hooks", ["fmt-after-edit"]],
      ["gjc:hooks", ["fmt-after-edit"]],
    ]);
  });

  test("apply writes marked entries, keeps the user's hooks and keys, and backs up first", async () => {
    const before = { claude: read(".claude/settings.json"), codex: read(".codex/hooks.json") };
    const s = svc();
    const res = await s.apply({ planId: (await s.plan()).planId, approvalId: "a" });
    expect(readFileSync(res.applied.find((a) => a.target === "claude-code:hooks")!.backup!, "utf8")).toBe(before.claude);
    expect(readFileSync(res.applied.find((a) => a.target === "codex:hooks")!.backup!, "utf8")).toBe(before.codex);

    const claude = json(".claude/settings.json");
    expect(claude.model).toBe("opus");
    expect(claude.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    expect(claude.hooks).toEqual({
      Stop: [
        { hooks: [{ type: "command", command: "notify.sh" }] },
        { hooks: [{ type: "command", command: "printf '\\a' # me:harness-config bell" }] },
      ],
      PostToolUse: [
        { matcher: "Edit", hooks: [{ type: "command", command: "user-fmt.sh", timeout: 5 }] },
        { matcher: "Edit|Write", hooks: [{ type: "command", command: "bunx prettier --write . # me:harness-config fmt-after-edit", timeout: 30 }] },
      ],
    });
    // Codex: the old managed Stop hook and its now-empty event are gone; the user's hook stays.
    expect(json(".codex/hooks.json").hooks).toEqual({
      SessionStart: [{ hooks: [{ type: "command", command: "codex-start.sh" }] }],
      PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "bunx prettier --write . # me:harness-config fmt-after-edit", timeout: 30 }] }],
    });
    // OpenCode and GJC files are not touched for hooks.
    expect(res.applied.some((a) => a.target.endsWith(":hooks") && !a.target.startsWith("claude-code") && !a.target.startsWith("codex"))).toBe(false);
    expect((await s.plan()).changes).toBe(0);
  });

  test("a changed command is replaced in place and harness-only keys survive", async () => {
    fx.write(
      "home/.codex/hooks.json",
      JSON.stringify({
        hooks: { PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "old-fmt # me:harness-config fmt-after-edit", statusMessage: "fmt" }] }] },
      }),
    );
    const s = svc();
    const plan = await s.plan({ harnesses: ["codex"] });
    expect(target(plan, "codex:hooks").diff.changed).toEqual([
      {
        name: "fmt-after-edit",
        fields: [
          { field: "command", before: "old-fmt", after: "bunx prettier --write ." },
          { field: "timeout", before: undefined, after: 30 },
        ],
      },
    ]);
    await s.apply({ planId: plan.planId, approvalId: "a", harnesses: ["codex"] });
    expect(json(".codex/hooks.json").hooks.PostToolUse).toEqual([
      { matcher: "Edit|Write", hooks: [{ type: "command", command: "bunx prettier --write . # me:harness-config fmt-after-edit", statusMessage: "fmt", timeout: 30 }] },
    ]);
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

    // Secrets become file references (stored only with write: true); the result lists paths, never values.
    expect(res.draft.mcpServers["private-claude"]).toEqual({
      type: "http",
      url: "https://private.example/mcp",
      headers: { Authorization: "${file:~/.config/me/secrets/mcp/private-claude-AUTHORIZATION}" },
      share: ["claude-code"],
    });
    expect(res.draft.mcpServers.figma).toMatchObject({ env: { FIGMA_API_KEY: "${file:~/.config/me/secrets/mcp/figma-FIGMA_API_KEY}" }, share: ["opencode"] });
    expect(res.secrets).toContain("~/.config/me/secrets/mcp/figma-FIGMA_API_KEY");
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
    // Each secret lands in its own 0600 file under home, so the draft renders back to the same values.
    for (const ref of res.secrets) {
      const file = join(fx.home, ref.slice(2));
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(Object.values(SECRETS)).toContain(readFileSync(file, "utf8").trim());
    }
    expect(res.secrets.length).toBeGreaterThan(0);
  });
});

describe("list", () => {
  test("shows source routing and managed vs unmanaged names per file", async () => {
    const l = await svc().list();
    expect(l.source.mcpServers.pencil!.targets).toEqual(["claude-code:user", "codex:user"]);
    expect(l.source.mcpServers.notion!.targets).toEqual(["claude-code:user", "codex:user", "opencode:user", "gjc:user"]);
    expect(l.files.find((f) => f.target === "claude-code:user")).toMatchObject({ managed: ["pencil"], unmanaged: ["private-claude"] });
    expect(l.source.skills.review!.targets).toEqual(["claude-code:skills", "codex:skills", "opencode:skills", "gjc:skills"]);
    expect(l.source.hooks["fmt-after-edit"]!.targets).toEqual(["claude-code:hooks", "codex:hooks"]);
    expect(l.files.find((f) => f.target === "claude-code:skills")).toMatchObject({ managed: [], unmanaged: ["mine", "shared"] });
    expect(l.files.find((f) => f.target === "codex:hooks")).toMatchObject({ managed: ["bell"], unmanaged: [] });
    expect(l.unsupported.map((u) => u.target)).toEqual(["opencode:hooks", "gjc:hooks"]);
    secretFree(l);
  });
});
