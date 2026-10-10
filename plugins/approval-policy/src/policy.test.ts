import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPipePair } from "@me/protocol";
import { definePlugin } from "@me/sdk";
import { Kernel, validateManifest } from "@me/kernel";
import { evaluate, type PendingApproval, type Rule } from "./policy.ts";

const base: PendingApproval = { approvalId: "a1", requester: "gjc-head", summary: "local.claude-code에 위임: run the test suite", risk: "low", payload: { role: "test" } };
const rules: Rule[] = [{ name: "tests", requester: "gjc-head", payload: { role: "test" } }];

test("matching low-risk test work is auto-approved", () => {
  expect(evaluate(base, rules)).toEqual({ auto: true, rule: "tests" });
});

test("high risk is never auto-approved, even with a catch-all rule", () => {
  expect(evaluate({ ...base, risk: "high" }, [{ name: "all", maxRisk: "medium" }])).toMatchObject({ auto: false });
});

test("deploy and DB roles or wording always need the user", () => {
  expect(evaluate({ ...base, payload: { role: "deploy" } }, [{ name: "all" }])).toMatchObject({ auto: false });
  expect(evaluate({ ...base, payload: { role: "db-write" } }, [{ name: "all" }])).toMatchObject({ auto: false });
  expect(evaluate({ ...base, summary: "production 배포 진행" }, [{ name: "all" }])).toMatchObject({ auto: false });
  expect(evaluate({ ...base, summary: "run DB migration" }, [{ name: "all" }])).toMatchObject({ auto: false });
});

test("medium risk needs a rule that allows medium", () => {
  expect(evaluate({ ...base, risk: "medium" }, rules)).toMatchObject({ auto: false });
  expect(evaluate({ ...base, risk: "medium" }, [{ ...rules[0]!, maxRisk: "medium" }])).toEqual({ auto: true, rule: "tests" });
});

test("no rules means nothing is automatic", () => {
  expect(evaluate(base, [])).toEqual({ auto: false, reason: "no rule matched" });
});

// Through a real kernel: the plugin decides only matching approvals, and the note names the rule.
let dir: string;
let kernel: Kernel;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "me-policy-"));
  kernel = new Kernel({ dataDir: dir, log: () => {}, pluginConfig: { "approval-policy": { rules: rules as any } } });
});
afterEach(async () => {
  await kernel.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("the plugin auto-approves a matching request and leaves others pending", async () => {
  await kernel.spawn(validateManifest(await Bun.file(join(import.meta.dir, "..", "plugin.json")).json(), join(import.meta.dir, "..")));
  const head = definePlugin({});
  const [k, p] = createPipePair();
  void head.run(p);
  await kernel.attach(validateManifest({ id: "gjc-head", version: "0", protocol: { min: 1, max: 1 }, run: { command: ["true"] }, permissions: ["approve.request"] }, dir), k);

  const auto = await head.approval.request({ summary: base.summary, risk: "low", payload: { role: "test" } });
  expect(auto).toMatchObject({ decision: "approve", note: "자동 승인: tests" });

  const manual = head.approval.request({ summary: "local.claude-code에 위임: deploy to production", risk: "low", payload: { role: "test" } });
  const winner = await Promise.race([manual.then(() => "decided"), Bun.sleep(500).then(() => "still pending")]);
  expect(winner).toBe("still pending");
  expect(kernel.pendingApprovals()).toHaveLength(1);
});
