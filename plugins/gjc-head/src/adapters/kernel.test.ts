import { describe, expect, test } from "bun:test";
import type { Plugin } from "@me/sdk";
import { kernelRecallContext } from "./kernel.ts";

describe("kernel recall adapter", () => {
  test("requests project context through the kernel and caps returned notes", async () => {
    const calls: unknown[][] = [];
    const plugin = {
      invoke: async (...args: unknown[]) => (calls.push(args), { text: "x".repeat(900) }),
    } as unknown as Plugin;
    const result = await kernelRecallContext(plugin).context({ project: "/project", text: "fix search" });
    expect(calls).toEqual([["recall", "recall.context", { project: "/project", text: "fix search" }]]);
    expect(result.text).toHaveLength(800);
  });

  test("ignores an absent or failed recall plugin", async () => {
    const plugin = { invoke: async () => { throw new Error("TargetUnavailable"); } } as unknown as Plugin;
    expect(await kernelRecallContext(plugin).context({ project: "/project", text: "request" })).toEqual({ text: "" });
  });
});
