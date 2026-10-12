import { expect, test } from "bun:test";
import { hasPermission, isPermission } from "./manifest.ts";

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
