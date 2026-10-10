import { describe, expect, test } from "bun:test";
import { RefusedError } from "../ports/index.ts";
import { scanToml, spliceCodex, splitKey } from "./codex-toml.ts";

const opts = { force: false, path: "config.toml" };

describe("scanner", () => {
  test("keys, quoted segments", () => {
    expect(splitKey('mcp_servers."a.b".env')).toEqual(["mcp_servers", "a.b", "env"]);
    expect(splitKey("a . 'lit' . c")).toEqual(["a", "lit", "c"]);
  });

  test("brackets inside multi-line arrays and strings are not headers", () => {
    const text = ['x = [', '  ["not", "a header"]', "]", 's = """', "[nope]", '"""', "[real] # c", "k = 1"].join("\n");
    const scan = scanToml(text);
    expect(scan.headers).toEqual([{ line: 6, path: ["real"] }]);
    expect([...scan.comments]).toEqual([6]);
  });
});

describe("spliceCodex", () => {
  const base = `# top\n[a]\nk = 1\n\n[mcp_servers.x]\ncommand = "x"\n\n# about b\n[b]\nz = 2\n`;

  test("adds after the last mcp_servers table and keeps every other byte", () => {
    const out = spliceCodex(base, { upsert: { y: { type: "stdio", command: "y" } }, remove: [] }, opts);
    expect(out).toBe(`# top\n[a]\nk = 1\n\n[mcp_servers.x]\ncommand = "x"\n\n[mcp_servers.y]\ncommand = "y"\n\n# about b\n[b]\nz = 2\n`);
  });

  test("appends at the end when there are no mcp_servers tables", () => {
    const out = spliceCodex(`# only\n[a]\nk = 1\n`, { upsert: { y: { type: "http", url: "https://y" } }, remove: [] }, opts);
    expect(out).toBe(`# only\n[a]\nk = 1\n\n[mcp_servers.y]\nurl = "https://y"\n`);
  });

  test("removes a table with its sub-tables", () => {
    const text = `[mcp_servers.x]\ncommand = "x"\n\n[mcp_servers.x.env]\nA = "1"\n\n[c]\nq = 1\n`;
    expect(spliceCodex(text, { upsert: {}, remove: ["x"] }, opts)).toBe(`[c]\nq = 1\n`);
  });

  test("inline-table layouts are refused without force, rewritten with it", () => {
    const text = `# lost with force\nmcp_servers = { x = { command = "x" } }\n`;
    expect(() => spliceCodex(text, { upsert: { x: { type: "stdio", command: "y" } }, remove: [] }, opts)).toThrow(RefusedError);
    const out = spliceCodex(text, { upsert: { x: { type: "stdio", command: "y" } }, remove: [] }, { ...opts, force: true });
    expect((Bun.TOML.parse(out) as any).mcp_servers.x.command).toBe("y");
    expect(out).not.toContain("# lost with force");
  });

  test("nothing to change returns the text untouched", () => {
    expect(spliceCodex(base, { upsert: {}, remove: [] }, opts)).toBe(base);
  });
});
