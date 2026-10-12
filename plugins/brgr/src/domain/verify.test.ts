import { describe, expect, test } from "bun:test";
import {
  commandsForProject,
  configCommandsFor,
  detectCommands,
  firstFailure,
  packageManagerFor,
  tailText,
  TAIL_CAP,
} from "./verify.ts";

describe("packageManagerFor", () => {
  test("infers the manager from the lockfile, defaulting to bun", () => {
    expect(packageManagerFor(["bun.lockb"])).toBe("bun");
    expect(packageManagerFor(["bun.lock"])).toBe("bun");
    expect(packageManagerFor(["pnpm-lock.yaml"])).toBe("pnpm");
    expect(packageManagerFor(["yarn.lock"])).toBe("yarn");
    expect(packageManagerFor(["package-lock.json"])).toBe("bun");
    expect(packageManagerFor([])).toBe("bun");
  });
});

describe("detectCommands", () => {
  test("runs present scripts in typecheck, lint, test order through the lockfile manager", () => {
    expect(detectCommands({ test: "bun test", lint: "x", typecheck: "tsc" }, [])).toEqual([
      "bun run typecheck",
      "bun run lint",
      "bun run test",
    ]);
    expect(detectCommands({ test: "vitest run" }, ["pnpm-lock.yaml"])).toEqual(["pnpm run test"]);
    expect(detectCommands({ lint: "eslint" }, ["yarn.lock"])).toEqual(["yarn run lint"]);
  });

  test("returns null when no known script exists", () => {
    expect(detectCommands({ build: "tsc" }, [])).toBeNull();
    expect(detectCommands(undefined, [])).toBeNull();
    expect(detectCommands({}, ["package-lock.json"])).toBeNull();
  });
});

describe("configCommandsFor", () => {
  const verify = { "/repo/me": ["bun test"], me: ["make check"] };
  test("matches the full project path first, then the repo name", () => {
    expect(configCommandsFor("/repo/me", verify)).toEqual(["bun test"]);
    expect(configCommandsFor("/elsewhere/me", verify)).toEqual(["make check"]);
    expect(configCommandsFor("/elsewhere/other", verify)).toBeNull();
    expect(configCommandsFor("/repo/me", undefined)).toBeNull();
  });

  test("an explicit empty list stays explicit (no checks), it does not fall through", () => {
    expect(configCommandsFor("/repo/empty", { "/repo/empty": [] })).toEqual([]);
  });
});

describe("commandsForProject", () => {
  test("explicit config wins over detected scripts", () => {
    expect(commandsForProject("/repo/me", { test: "x" }, [], { "/repo/me": ["bun test --only"] })).toEqual(["bun test --only"]);
    expect(commandsForProject("/repo/me", { test: "bun test" }, [], undefined)).toEqual(["bun run test"]);
    expect(commandsForProject("/repo/me", { build: "x" }, [], undefined)).toBeNull();
  });
});

describe("tailText and firstFailure", () => {
  test("keeps the last 4000 chars", () => {
    expect(tailText("ab", 2)).toBe("ab");
    expect(tailText("abcdef", 4)).toBe("cdef");
    expect(tailText("x".repeat(TAIL_CAP + 100)).length).toBe(TAIL_CAP);
  });

  test("finds the first failing command", () => {
    expect(firstFailure([{ cmd: "a", exitCode: 0 }, { cmd: "b", exitCode: 1 }])).toBe("b");
    expect(firstFailure([{ cmd: "a", exitCode: 0 }])).toBeNull();
    expect(firstFailure([])).toBeNull();
  });
});
