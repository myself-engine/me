// SQLite-backed journal and entity store (DESIGN §4, PROTOCOL §7, §10).
import { Database } from "bun:sqlite";
import type { EntityDoc, JournalEntry, JournalQueryParams, JsonValue } from "@myself/protocol";

export type JournalType = JournalEntry["type"];

export interface AppendInput {
  source: string;
  type: JournalType;
  traceId: string | null;
  causationId: number | null;
  body: unknown;
}

export class Store {
  readonly db: Database;
  private appendStmt;
  private upsertStmt;
  private getStmt;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS journal (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        source TEXT NOT NULL,
        trace_id TEXT,
        causation_id INTEGER,
        type TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS journal_trace ON journal(trace_id);
      CREATE INDEX IF NOT EXISTS journal_source ON journal(source);
      CREATE TABLE IF NOT EXISTS entity_kinds (
        kind TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        schema TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entities (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_seq INTEGER NOT NULL,
        PRIMARY KEY (kind, id)
      );
    `);
    this.appendStmt = this.db.prepare(
      "INSERT INTO journal (ts, source, trace_id, causation_id, type, body) VALUES (?, ?, ?, ?, ?, ?) RETURNING seq, ts",
    );
    this.upsertStmt = this.db.prepare(
      "INSERT INTO entities (kind, id, data, updated_seq) VALUES (?, ?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data, updated_seq = excluded.updated_seq",
    );
    this.getStmt = this.db.prepare("SELECT kind, id, data, updated_seq FROM entities WHERE kind = ? AND id = ?");
  }

  append(input: AppendInput): { seq: number; ts: string } {
    const ts = new Date().toISOString();
    const row = this.appendStmt.get(
      ts,
      input.source,
      input.traceId,
      input.causationId,
      input.type,
      JSON.stringify(input.body ?? null),
    ) as { seq: number; ts: string };
    return row;
  }

  query(q: JournalQueryParams): JournalEntry[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.traceId) {
      where.push("trace_id = ?");
      args.push(q.traceId);
    }
    if (q.sinceSeq !== undefined) {
      where.push("seq > ?");
      args.push(q.sinceSeq);
    }
    if (q.source) {
      where.push("source = ?");
      args.push(q.source);
    }
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
    const sql = `SELECT * FROM journal ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY seq ASC LIMIT ${limit}`;
    return (this.db.prepare(sql).all(...args) as any[]).map((r) => ({
      seq: r.seq,
      ts: r.ts,
      source: r.source,
      traceId: r.trace_id,
      causationId: r.causation_id,
      type: r.type,
      body: JSON.parse(r.body),
    }));
  }

  registerKind(kind: string, owner: string, schema: JsonValue) {
    this.db
      .prepare("INSERT INTO entity_kinds (kind, owner, schema) VALUES (?, ?, ?) ON CONFLICT(kind) DO UPDATE SET owner = excluded.owner, schema = excluded.schema")
      .run(kind, owner, JSON.stringify(schema));
  }

  kind(kind: string): { owner: string; schema: JsonValue } | null {
    const r = this.db.prepare("SELECT owner, schema FROM entity_kinds WHERE kind = ?").get(kind) as any;
    return r ? { owner: r.owner, schema: JSON.parse(r.schema) } : null;
  }

  upsert(kind: string, id: string, data: unknown, seq: number) {
    this.upsertStmt.run(kind, id, JSON.stringify(data), seq);
  }

  get(kind: string, id: string): EntityDoc | null {
    const r = this.getStmt.get(kind, id) as any;
    return r ? { kind: r.kind, id: r.id, data: JSON.parse(r.data), updatedSeq: r.updated_seq } : null;
  }

  list(kind: string, where: Record<string, JsonValue> | undefined, limit = 100, after?: string): EntityDoc[] {
    const conds = ["kind = ?"];
    const args: (string | number | null)[] = [kind];
    if (after) {
      conds.push("id > ?");
      args.push(after);
    }
    for (const [field, value] of Object.entries(where ?? {})) {
      if (!/^[A-Za-z0-9_]+$/.test(field)) throw new Error(`invalid where field: ${field}`);
      conds.push(`json_extract(data, '$.${field}') IS ?`);
      args.push(typeof value === "boolean" ? (value ? 1 : 0) : (value as string | number | null));
    }
    const lim = Math.min(Math.max(limit, 1), 1000);
    const rows = this.db
      .prepare(`SELECT kind, id, data, updated_seq FROM entities WHERE ${conds.join(" AND ")} ORDER BY id LIMIT ${lim}`)
      .all(...args) as any[];
    return rows.map((r) => ({ kind: r.kind, id: r.id, data: JSON.parse(r.data), updatedSeq: r.updated_seq }));
  }

  close() {
    this.db.close();
  }
}
