import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brgrCli } from "./brgr-cli.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

test("uses the brgr message and input CLI contracts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "me-brgr-cli-"));
  dirs.push(dir);
  const argsFile = join(dir, "args");
  const bin = join(dir, "brgr-fake");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nprintf '{}\\n'\n`);
  chmodSync(bin, 0o700);
  const cli = brgrCli(() => "owner-test", bin);

  await cli.messages("task-1", "owner");
  expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual(["message", "list", "--for", "owner", "task-1", "--json", "--owner-session", "owner-test"]);
  await cli.sendMessage("task-1", { to: "worker", kind: "reply", body: "진행해 주세요", replyTo: "q1" });
  expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual(["message", "send", "--to", "worker", "--kind", "reply", "--body", "진행해 주세요", "--reply-to", "q1", "task-1", "--json", "--owner-session", "owner-test"]);
  await cli.input("task-1", { text: "2" });
  expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual(["input", "task-1", "--text", "2", "--json", "--owner-session", "owner-test"]);
});
