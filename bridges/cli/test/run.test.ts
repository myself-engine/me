import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorCode } from "@me/protocol";
import { runCommand } from "../src/run.ts";

const argvFixture = join(import.meta.dir, "fixtures", "argv.ts");

test("a param full of shell syntax reaches the child as one argument", async () => {
  const nasty = `a b; echo pwned $(whoami) "q" 'x' | cat && \`id\` > /tmp/x`;
  const r = await runCommand(
    "argv",
    { argv: ["bun", argvFixture, "{v}", "--flag={v}"], params: { v: { type: "string" } }, parse: "json" },
    { v: nasty },
  );
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toEqual([nasty, `--flag=${nasty}`]);
});

test("invalid params are rejected before anything runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "me-cli-"));
  const marker = join(dir, "ran");
  const cmd = { argv: ["touch", marker, "{v}"], params: { v: { type: "string" as const, pattern: "^[a-z]+$", required: true } } };
  try {
    for (const params of [{}, { v: "A;B" }, { v: 1 }, { v: "ok", other: "x" }]) {
      const err: any = await runCommand("t", cmd, params).catch((e) => e);
      expect(err.code).toBe(-32602);
    }
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parse modes: text, lines, json", async () => {
  expect((await runCommand("t", { argv: ["printf", "a\\nb\\n"] }, {})).stdout).toBe("a\nb\n");
  expect((await runCommand("t", { argv: ["printf", "a\\n\\nb\\n"], parse: "lines" }, {})).stdout).toEqual(["a", "", "b"]);
  expect((await runCommand("t", { argv: ["printf", "a"], parse: "lines" }, {})).stdout).toEqual(["a"]);
  expect((await runCommand("t", { argv: ["printf", ""], parse: "lines" }, {})).stdout).toEqual([]);
  expect((await runCommand("t", { argv: ["printf", '{"n":1,"xs":[2]}'], parse: "json" }, {})).stdout).toEqual({ n: 1, xs: [2] });
  expect((await runCommand("t", { argv: ["printf", ""], parse: "json" }, {})).stdout).toBe(null);
  const err: any = await runCommand("t", { argv: ["printf", "not json"], parse: "json" }, {}).catch((e) => e);
  expect(err.message).toContain("not valid JSON");
});

test("non-zero exit is a result unless failOnNonZero", async () => {
  const script = "console.log('out'); console.error('boom'); process.exit(3)";
  const r = await runCommand("t", { argv: ["bun", "-e", script] }, {});
  expect(r).toEqual({ exitCode: 3, stdout: "out\n", stderr: "boom\n" });
  // A failing command's plain-text stdout is kept rather than failing the JSON parse.
  expect((await runCommand("t", { argv: ["bun", "-e", script], parse: "json" }, {})).stdout).toBe("out\n");
  const err: any = await runCommand("t", { argv: ["bun", "-e", script], failOnNonZero: true }, {}).catch((e) => e);
  expect(err.message).toContain("exited with code 3");
  expect(err.data.exitCode).toBe(3);
});

test("stderr is truncated to 8 KB", async () => {
  const r = await runCommand("t", { argv: ["bun", "-e", "process.stderr.write('x'.repeat(100000))"] }, {});
  expect(r.stderr.length).toBe(8192);
  expect(r.stderrTruncated).toBe(true);
});

test("stream: true reports each stdout line as it arrives", async () => {
  const lines: string[] = [];
  const r = await runCommand(
    "t",
    { argv: ["bun", "-e", "for (const l of ['one','two','three']) { console.log(l); await Bun.sleep(20) }"], stream: true, parse: "lines" },
    {},
    { onLine: (l) => lines.push(l) },
  );
  expect(lines).toEqual(["one", "two", "three"]);
  expect(r.stdout).toEqual(["one", "two", "three"]);
});

test("timeoutMs kills the child", async () => {
  const started = Date.now();
  const err: any = await runCommand("t", { argv: ["sleep", "30"], timeoutMs: 200 }, {}).catch((e) => e);
  expect(err.code).toBe(ErrorCode.Timeout);
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("timeout escalates to SIGKILL when the child ignores SIGTERM", async () => {
  const started = Date.now();
  const script = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
  const err: any = await runCommand("t", { argv: ["bun", "-e", script], timeoutMs: 300 }, {}, { killGraceMs: 200 }).catch((e) => e);
  expect(err.code).toBe(ErrorCode.Timeout);
  expect(Date.now() - started).toBeLessThan(3_000);
});

test("aborting the signal kills the child", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const started = Date.now();
  const err: any = await runCommand("t", { argv: ["sleep", "30"] }, {}, { signal: ac.signal }).catch((e) => e);
  expect(err.code).toBe(ErrorCode.Cancelled);
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("cwd is substituted from declared params and resolved against the base", async () => {
  const dir = mkdtempSync(join(tmpdir(), "me-cli-"));
  try {
    await Bun.write(join(dir, "sub", "f.txt"), "hi");
    const r = await runCommand(
      "t",
      { argv: ["ls"], cwd: "{d}", params: { d: { type: "string", enum: ["sub"] } }, parse: "lines" },
      { d: "sub" },
      { baseCwd: dir },
    );
    expect(r.stdout).toEqual(["f.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
