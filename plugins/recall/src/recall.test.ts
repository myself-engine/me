import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecallService, parseTranscriptLine, type RecallFact, type RecallStore } from "./recall.ts";

const dirs: string[] = [];
const makeDir = () => { const dir = mkdtempSync(join(tmpdir(), "me-recall-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function store(seed: RecallFact[] = [], messageRows: { id: string; updatedSeq: number; data: Record<string, unknown> }[] = [], threadRows: { id: string; data: Record<string, unknown> }[] = []) {
  const facts = new Map(seed.map((fact) => [fact.id, fact]));
  return {
    adapter: {
      messages: async () => messageRows, threads: async () => threadRows,
      facts: async (project?: string) => [...facts.values()].filter((fact) => !project || fact.project === project),
      fact: async (id: string) => facts.get(id) ?? null,
      putFact: async (fact: RecallFact) => { facts.set(fact.id, fact); },
    } satisfies RecallStore,
    facts,
  };
}

const writeTranscript = (home: string, source: "claude" | "codex", name: string, lines: string[]) => {
  const dir = source === "claude" ? join(home, ".claude", "projects", "-Users-justn-dev") : join(home, ".codex", "sessions", "2026", "10", "13");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
};

describe("recall transcript indexing", () => {
  test("parses user and assistant text blocks and ignores tool payloads", () => {
    const line = JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Korean 프로젝트 memory" }, { type: "tool_call", name: "secret-tool", arguments: "ignored" }] } });
    expect(parseTranscriptLine("codex", line, "/sessions/s.jsonl")[0]?.body).toBe("Korean 프로젝트 memory");
    expect(parseTranscriptLine("codex", JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "tool", arguments: "skip me" } }), "/sessions/s.jsonl")).toEqual([]);
    expect(parseTranscriptLine("claude", JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "x" }] } }), "/claude/p/s.jsonl")).toEqual([]);
  });

  test("indexes me, Claude and Codex, redacts before storage, and searches English and Korean", async () => {
    const home = makeDir();
    const memory = store([], [{ id: "m-1", updatedSeq: 12, data: { role: "assistant", text: "me keeps Korean conversation context", threadId: "t-1", ts: "2026-10-13T02:00:00Z" } }], [{ id: "t-1", data: { project: "me", title: "local thread" } }]);
    writeTranscript(home, "claude", "claude-session.jsonl", [JSON.stringify({ type: "user", cwd: "/Users/justn/dev/my-app", timestamp: "2026-10-13T01:00:00Z", message: { role: "user", content: "한국어 설정 검색" } }), JSON.stringify({ type: "assistant", cwd: "/Users/justn/dev/my-app", message: { role: "assistant", content: [{ type: "text", text: "Remember: sk-abc123456789012345 is private" }] } })]);
    writeTranscript(home, "codex", "codex-session.jsonl", [JSON.stringify({ type: "session_meta", payload: { cwd: "/Users/justn/dev/me" } }), JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Find a durable project ledger" }] } }), JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Find a durable project ledger" } })]);
    const svc = createRecallService({ dbPath: join(home, "plugin", "index.sqlite"), home, store: memory.adapter });
    const kr = await svc.search({ q: "한국어 설정" });
    const en = await svc.search({ q: "durable ledger" });
    const own = await svc.search({ q: "conversation context" });
    const redacted = await svc.search({ q: "private" });
    expect(kr.some((row: any) => row.source === "claude")).toBe(true);
    expect(kr[0]?.project).toBe("/Users/justn/dev/my-app");
    expect(en.some((row: any) => row.source === "codex" && row.project === "/Users/justn/dev/me")).toBe(true);
    expect(own.some((row: any) => row.source === "me" && row.title === "local thread")).toBe(true);
    expect(redacted[0]?.excerpt).toContain("[REDACTED]");
    expect(redacted[0]?.excerpt).not.toContain("sk-abc");
    const status = await svc.status();
    expect(status.counts.claude).toBe(2);
    expect(status.counts.codex).toBe(1);
    expect(status.counts.me).toBe(1);
    expect(status.lastIndexedAt).toBeTruthy();
    svc.close();
  });

  test("uses mtime and size for incremental file refresh and reports unknown formats", async () => {
    const home = makeDir();
    const memory = store();
    const file = writeTranscript(home, "claude", "session.jsonl", [JSON.stringify({ type: "user", message: { role: "user", content: "before phrase" } }), "not-json"]);
    const svc = createRecallService({ dbPath: join(home, "index.sqlite"), home, store: memory.adapter });
    await svc.search({ q: "before" });
    await svc.search({ q: "before" });
    expect((await svc.status()).skipped).toBeGreaterThan(0);
    const changed = JSON.stringify({ type: "user", message: { role: "user", content: "after phrase is longer" } });
    writeFileSync(file, `${changed}\n`);
    const future = new Date(Date.now() + 3000);
    utimesSync(file, future, future);
    expect(await svc.search({ q: "before" })).toHaveLength(0);
    expect((await svc.search({ q: "after" })).length).toBe(1);
    svc.close();
  });

  test("keeps the last good entity index when a read-state refresh fails", async () => {
    const home = makeDir();
    const memory = store([], [{ id: "keep", updatedSeq: 1, data: { role: "user", text: "preserve previous state", threadId: "t" } }]);
    const svc = createRecallService({ dbPath: join(home, "index.sqlite"), home, store: memory.adapter });
    expect(await svc.search({ q: "previous" })).toHaveLength(1);
    memory.adapter.messages = async () => { throw new Error("read-state unavailable"); };
    expect(await svc.search({ q: "previous" })).toHaveLength(1);
    svc.close();
  });

  test("applies the index byte budget across transcript files and me messages", async () => {
    const home = makeDir();
    const memory = store([], [{ id: "large", updatedSeq: 1, data: { role: "user", text: "m".repeat(150) } }]);
    writeTranscript(home, "claude", "session.jsonl", [JSON.stringify({ type: "user", message: { role: "user", content: "f".repeat(100) } })]);
    const svc = createRecallService({ dbPath: join(home, "index.sqlite"), home, store: memory.adapter, config: { maxIndexBytes: 200 } });
    const status = await svc.status();
    expect(status.counts.total).toBe(1);
    expect(status.skipped).toBeGreaterThan(0);
    svc.close();
  });
});

describe("recall project facts", () => {
  test("remembers explicitly, tombstones forgotten facts, and stays within the context budget", async () => {
    const home = makeDir();
    const memory = store();
    const svc = createRecallService({ dbPath: join(home, "index.sqlite"), home, store: memory.adapter, now: () => new Date("2026-10-13T00:00:00Z") });
    const first = await svc.remember({ project: "me", text: "검색은 SQLite FTS5로 만들어요" });
    expect((await svc.facts({ project: "me" })).map((fact) => fact.id)).toEqual([first.id]);
    expect((await svc.context({ project: "me", text: "SQLite 검색" })).text).toContain("SQLite FTS5");
    const pinned = await svc.remember({ project: "me", text: "항상 고정해야 하는 핵심 사실", source: "task", pinned: true });
    expect(pinned.source).toBe("task");
    for (let i = 0; i < 20; i++) await svc.remember({ project: "me", text: `${i}: ${"detail ".repeat(90)}` });
    const context = await svc.context({ project: "me", text: "detail" });
    expect(context.text.length).toBeLessThanOrEqual(800);
    expect(context.text.startsWith("- 항상 고정해야 하는 핵심 사실")).toBe(true);
    expect(await svc.forget({ id: first.id })).toEqual({ removed: true });
    expect((await svc.facts({ project: "me" })).some((fact) => fact.id === first.id)).toBe(false);
    svc.close();
  });
});
