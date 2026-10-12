import { describe, expect, test } from "bun:test";
import type { Target } from "../domain/model.ts";
import { RefusedError } from "../ports/index.ts";
import { jsonHooksFile } from "./json-hooks.ts";

const target: Target = { id: "claude-code:hooks", harness: "claude-code", section: "hooks", scope: "user" };
const file = jsonHooksFile(target, "settings.json");
const cmd = (command: string) => ({ type: "command", command });

describe("jsonHooksFile", () => {
  test("reads only marked entries; an unmarked identical command stays the user's", () => {
    const text = JSON.stringify({
      hooks: { Stop: [{ hooks: [cmd("bell"), cmd("bell # me:harness-config bell")] }], PreToolUse: [{ matcher: "Bash", hooks: [{ ...cmd("g # me:harness-config guard"), timeout: 3 }] }] },
    });
    expect(file.read(text)).toEqual({
      bell: { event: "Stop", command: "bell" },
      guard: { event: "PreToolUse", matcher: "Bash", command: "g", timeout: 3 },
    });
    const out = JSON.parse(file.render(text, { upsert: {}, remove: ["bell"] }, { force: false }));
    expect(out.hooks.Stop).toEqual([{ hooks: [cmd("bell")] }]);
  });

  test("moving a hook to another event or matcher takes it out of the old group and prunes only what it emptied", () => {
    const text = JSON.stringify({
      hooks: {
        Stop: [{ hooks: [cmd("x # me:harness-config x")] }, { hooks: [] }],
        PreToolUse: [{ matcher: "Bash", hooks: [cmd("mine"), cmd("y # me:harness-config y")] }],
      },
    });
    const out = JSON.parse(
      file.render(text, { upsert: { x: { event: "SessionStart", command: "x" }, y: { event: "PreToolUse", matcher: "Edit", command: "y" } }, remove: [] }, { force: false }),
    );
    expect(out.hooks).toEqual({
      Stop: [{ hooks: [] }],
      PreToolUse: [{ matcher: "Bash", hooks: [cmd("mine")] }, { matcher: "Edit", hooks: [cmd("y # me:harness-config y")] }],
      SessionStart: [{ hooks: [cmd("x # me:harness-config x")] }],
    });
  });

  test("creates the file when missing and keeps indentation and a trailing newline", () => {
    const created = file.render(null, { upsert: { s: { event: "Stop", command: "s" } }, remove: [] }, { force: false });
    expect(JSON.parse(created)).toEqual({ hooks: { Stop: [{ hooks: [cmd("s # me:harness-config s")] }] } });
    const tabbed = file.render('{\n\t"a": 1\n}\n', { upsert: { s: { event: "Stop", command: "s" } }, remove: [] }, { force: false });
    expect(tabbed.startsWith('{\n\t"a": 1,\n\t"hooks"')).toBe(true);
    expect(tabbed.endsWith("}\n")).toBe(true);
  });

  test("refuses shapes it cannot merge safely", () => {
    expect(() => file.read('{"hooks": []}')).toThrow(RefusedError);
    expect(() => file.read('{"hooks": {"Stop": {}}}')).toThrow(RefusedError);
    expect(() => file.render("// jsonc\n{}", { upsert: {}, remove: [] }, { force: false })).toThrow(RefusedError);
  });
});
