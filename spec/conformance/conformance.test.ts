// Runs the conformance suite against reference plugins in TypeScript and Python, a real plugin, and a broken one.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { formatResult, runConformance } from "./run.ts";

const root = join(import.meta.dir, "..", "..");
const fixtures = join(import.meta.dir, "fixtures");
const python = Bun.which("python3");

async function expectPass(dir: string) {
  const r = await runConformance(dir);
  if (!r.ok) console.error(formatResult(r));
  expect(r.checks.filter((c) => !c.ok)).toEqual([]);
  expect(r.ok).toBe(true);
}

describe("conformance", () => {
  test("ts-echo (SDK, kernel/test/fixtures/echo.ts)", () => expectPass(join(fixtures, "ts-echo")), 60_000);

  test("plugins/slang", () => expectPass(join(root, "plugins", "slang")), 60_000);

  if (!python) console.warn("[conformance] python3 not found on PATH; skipping the python-echo conformance test");
  test.skipIf(!python)(
    `python-echo (plain Python, no SDK)${python ? "" : " — SKIPPED: python3 not found on PATH"}`,
    () => expectPass(join(fixtures, "python-echo")),
    60_000,
  );

  test(
    "a non-conforming plugin fails the checks it breaks",
    async () => {
      const r = await runConformance(join(fixtures, "bad"), { callTimeoutMs: 1_000, shutdownTimeoutMs: 1_000 });
      const failed = new Set(r.checks.filter((c) => !c.ok).map((c) => c.name));
      expect(r.ok).toBe(false);
      for (const name of [
        "call hang",
        "unknown method → error",
        "stream twice",
        "shutdown",
        "exits after shutdown",
        "stdout carries only protocol frames",
      ])
        expect(failed).toContain(name);
      expect(failed.has("initialize")).toBe(false);
      expect(failed.has("call twice")).toBe(false);
    },
    60_000,
  );
});
