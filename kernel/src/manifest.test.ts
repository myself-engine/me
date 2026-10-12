import { expect, test } from "bun:test";
import { hasPermission, isPermission, validateManifest } from "./manifest.ts";

test("call permissions: exact, prefix-*, or everything", () => {
  expect(isPermission("call:ops-*")).toBe(true);
  expect(isPermission("call:ops*")).toBe(false);
  expect(isPermission("call:*x")).toBe(false);
  expect(hasPermission(["call:ops-*"], "call:ops-rapi")).toBe(true);
  expect(hasPermission(["call:ops-*"], "call:ops")).toBe(false);
  expect(hasPermission(["call:ops-*"], "call:opsx")).toBe(false);
  expect(hasPermission(["call:ops-*"], "call:brgr")).toBe(false);
  expect(hasPermission(["call:*"], "call:brgr")).toBe(true);
  expect(hasPermission(["call:ops-*"], "read-state")).toBe(false);
});
test("run.envPass accepts names and PREFIX_* globs, refuses wildcards", () => {
  const base = { id: "x", version: "0", protocol: { min: 1, max: 1 }, run: { command: ["true"] }, permissions: [] };
  expect(validateManifest({ ...base, run: { command: ["true"], envPass: ["GH_TOKEN", "MYAPP_*"] } }, "/d").run.envPass).toEqual([
    "GH_TOKEN",
    "MYAPP_*",
  ]);
  expect(validateManifest({ ...base }, "/d").run.envPass).toBeUndefined();
  for (const envPass of [["*"], ["A*B"], "GH_TOKEN"]) {
    expect(() => validateManifest({ ...base, run: { command: ["true"], envPass } }, "/d")).toThrow("run.envPass");
  }
});
