import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeFixture, SECRETS, type Fixture } from "../../plugins/harness-config/src/app/fixtures.ts";
import { configApply, configImport, configPlan } from "./config.ts";

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture();
  writeFileSync(join(fx.root, "me.config.json"), JSON.stringify({ dataDir: "~/.never-used", plugins: [] }));
});
afterEach(() => fx.cleanup());

describe("me config", () => {
  test("plan, apply needs yes, apply with yes writes and backs up", async () => {
    const plan = await configPlan(fx.root, { env: fx.env });
    expect(plan.ok).toBe(true);
    expect(plan.changes).toBeGreaterThan(0);

    const before = readFileSync(join(fx.home, ".claude.json"), "utf8");
    const refused = await configApply(fx.root, { env: fx.env, yes: false });
    expect(refused.applied).toBe(false);
    expect(readFileSync(join(fx.home, ".claude.json"), "utf8")).toBe(before);

    const done = await configApply(fx.root, { env: fx.env, yes: true });
    expect(done.applied).toBe(true);
    if (done.applied) expect(done.approvalId).toMatch(/^cli:/);
    expect(readdirSync(fx.home).some((f) => f.startsWith(".claude.json.me-backup-"))).toBe(true);
    expect((await configPlan(fx.root, { env: fx.env })).changes).toBe(0);
  });

  test("sourcePath from pluginConfig", async () => {
    writeFileSync(
      join(fx.root, "me.config.json"),
      JSON.stringify({ plugins: [], pluginConfig: { "harness-config": { sourcePath: join(fx.root, "nowhere.json") } } }),
    );
    await expect(configPlan(fx.root, { env: fx.env })).rejects.toThrow(/no source at .*nowhere\.json/);
  });

  test("dry import writes nothing and holds no secrets", async () => {
    const res = await configImport(fx.root, { env: fx.env });
    expect(res.written).toBeNull();
    const s = JSON.stringify(res);
    for (const secret of Object.values(SECRETS)) expect(s).not.toContain(secret);
    expect(readdirSync(join(fx.meHome, "harness-config"))).not.toContain("source.draft.json");
  });
});
