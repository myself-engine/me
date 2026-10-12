import { describe, expect, test } from "bun:test";
import {
  commandsForProject,
  configCommandsFor,
  detectArgv,
  detectCommands,
  firstFailure,
  installCommandFor,
  needsInstall,
  packageManagerFor,
  parseTaskStatus,
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
describe("detectArgv", () => {
  test("returns fixed argv per script, no shell words", () => {
    expect(detectArgv({ test: "bun test", lint: "x", typecheck: "tsc" }, [])).toEqual([
      ["bun", "run", "typecheck"],
      ["bun", "run", "lint"],
      ["bun", "run", "test"],
    ]);
    expect(detectArgv({ test: "vitest run" }, ["pnpm-lock.yaml"])).toEqual([["pnpm", "run", "test"]]);
  });

  test("returns null when no known script exists", () => {
    expect(detectArgv({ build: "tsc" }, [])).toBeNull();
    expect(detectArgv(undefined, [])).toBeNull();
  });
});

describe("installCommandFor and needsInstall", () => {
  test("maps each lockfile to its frozen install", () => {
    expect(installCommandFor(["bun.lock"])).toEqual(["bun", "install", "--frozen-lockfile"]);
    expect(installCommandFor(["bun.lockb"])).toEqual(["bun", "install", "--frozen-lockfile"]);
    expect(installCommandFor(["pnpm-lock.yaml"])).toEqual(["pnpm", "install", "--frozen-lockfile"]);
    expect(installCommandFor(["yarn.lock"])).toEqual(["yarn", "install", "--immutable"]);
    expect(installCommandFor(["package-lock.json"])).toEqual(["npm", "ci"]);
    expect(installCommandFor(["package.json"])).toBeNull();
    expect(installCommandFor([])).toBeNull();
  });

  test("needs an install only with package.json, a lockfile, and no node_modules", () => {
    expect(needsInstall(["package.json", "bun.lock"])).toBe(true);
    expect(needsInstall(["package.json", "bun.lock", "node_modules"])).toBe(false);
    expect(needsInstall(["package.json"])).toBe(false);
    expect(needsInstall(["bun.lock"])).toBe(false);
    expect(needsInstall([])).toBe(false);
  });
});

describe("parseTaskStatus", () => {
  test("reads the workspace and base commit from one task object", () => {
    expect(parseTaskStatus(JSON.stringify({ task_id: "r1", workspace: "/tmp/wt", base_commit: "abc" }), "r1")).toEqual({
      workspace: "/tmp/wt",
      base: "abc",
    });
  });

  test("finds the task in a list and tolerates key variants", () => {
    const text = JSON.stringify([
      { taskId: "other", workspace: "/tmp/no" },
      { task_id: "r1", workspace: "/tmp/wt", baseSha: "def" },
    ]);
    expect(parseTaskStatus(text, "r1")).toEqual({ workspace: "/tmp/wt", base: "def" });
  });

  test("unknown shapes mean clone at HEAD", () => {
    expect(parseTaskStatus("{}", "r1")).toEqual({ workspace: null, base: null });
    expect(parseTaskStatus("not json", "r1")).toEqual({ workspace: null, base: null });
    expect(parseTaskStatus("[]", "r1")).toEqual({ workspace: null, base: null });
    expect(parseTaskStatus(JSON.stringify({ task_id: "r1", workspace: "" }), "r1")).toEqual({ workspace: null, base: null });
  });
});
