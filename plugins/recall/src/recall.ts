import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { redactString } from "@me/redact";

export type RecallSource = "me" | "claude" | "codex";
export interface RecallMessage { source: RecallSource; role: "user" | "assistant"; project: string; title: string; body: string; at: string; ref: string; file: string; version: string; size: number }
export interface RecallFact { id: string; project: string; text: string; source: "user" | "task"; createdAt: string; pinned: boolean; deleted?: boolean }
export interface RecallStore {
  messages(): Promise<{ id: string; updatedSeq: number; data: Record<string, unknown> }[]>;
  threads(): Promise<{ id: string; data: Record<string, unknown> }[]>;
  facts(project?: string): Promise<RecallFact[]>;
  fact(id: string): Promise<RecallFact | null>;
  putFact(fact: RecallFact): Promise<void>;
}
export interface RecallConfig { maxIndexBytes?: number; maxMessageChars?: number; maxResults?: number; indexIntervalMinutes?: number; batchSize?: number }
export interface RecallOptions { dbPath: string; store: RecallStore; config?: RecallConfig; home?: string; now?: () => Date }

const textFromContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part: any) => part && ["text", "input_text", "output_text"].includes(part.type) && typeof part.text === "string" ? [part.text] : []).join("\n");
};

/** Accept only known transcript message shapes and text blocks; tool calls and payloads are ignored. */
export function parseTranscriptLine(source: "claude" | "codex", line: string, file: string): RecallMessage[] {
  let row: any;
  try { row = JSON.parse(line); } catch { return []; }
  const payload = source === "codex" ? row.payload : row;
  if (!payload || typeof payload !== "object") return [];
  const message = source === "claude" ? payload : ["message", "user_message"].includes(payload.type) ? payload : null;
  const role = message?.message?.role ?? message?.role ?? (source === "codex" && payload.type === "user_message" ? "user" : null);
  if (role !== "user" && role !== "assistant") return [];
  const content = message?.message?.content ?? message?.content ?? message?.message;
  const body = textFromContent(content);
  if (!body.trim()) return [];
  const cwd = String(row.cwd ?? row.session?.cwd ?? "");
  const folder = basename(dirname(file));
  const project = cwd || (folder.startsWith("-") ? folder.replaceAll("-", "/") : folder);
  const title = basename(file, ".jsonl");
  const at = String(message?.timestamp ?? row.timestamp ?? row.ts ?? "");
  const index = Number(row.lineNumber ?? 0);
  return [{ source, role, project, title, body, at, ref: `${file}${index ? `#${index}` : ""}`, file, version: "", size: 0 }];
}

function walkJsonl(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

async function* readLines(file: string): AsyncGenerator<string> {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try { for await (const line of lines) yield line; }
  finally { lines.close(); input.destroy(); }
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fileMessages(source: "claude" | "codex", file: string, maxChars: number): Promise<{ messages: RecallMessage[]; skipped: number }> {
  const rows: RecallMessage[] = [];
  const seenBodies = new Set<string>();
  let skipped = 0;
  let lineNo = 0;
  let cwd: string | undefined;
  if (source === "codex") {
    let count = 0;
    for await (const line of readLines(file)) {
      try { const row = JSON.parse(line); if (row.type === "session_meta" && typeof row.payload?.cwd === "string") { cwd = row.payload.cwd; break; } } catch { /* malformed data is counted in the parsing pass */ }
      if (++count % 100 === 0) await yieldToEventLoop();
    }
  }
  for await (const line of readLines(file)) {
    lineNo++;
    let input = line;
    if (cwd) {
      try { const row = JSON.parse(line); if (row.type !== "session_meta") input = JSON.stringify({ ...row, cwd }); } catch { /* parser counts malformed data as unknown */ }
    }
    const parsed = parseTranscriptLine(source, input, file);
    if (parsed.length === 0) {
      try {
        const row = JSON.parse(line);
        const known = source === "claude"
          ? ["user", "assistant", "system", "summary", "file-history-snapshot", "queue-operation"].includes(row.type)
          : ["session_meta", "response_item", "event_msg", "turn_context", "compaction", "token_count"].includes(row.type);
        if (!known) skipped++;
      } catch { skipped++; }
    }
    if (parsed.length === 0) continue;
    for (const item of parsed) {
      const duplicateKey = `${item.role}\0${item.body}`;
      if (seenBodies.has(duplicateKey)) continue;
      seenBodies.add(duplicateKey);
      item.ref = `${file}#${lineNo}`;
      item.body = redactString(item.body).slice(0, maxChars);
      item.size = Buffer.byteLength(item.body);
      rows.push(item);
    }
    if (lineNo % 100 === 0) await yieldToEventLoop();
  }
  return { messages: rows, skipped };
}

const idFor = (item: RecallMessage) => createHash("sha256").update(`${item.source}\0${item.ref}`).digest("hex");
const safeDate = (value: unknown) => {
  const d = new Date(String(value ?? ""));
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
};

export function createRecallService(options: RecallOptions) {
  const home = options.home ?? homedir();
  const maxBytes = Math.max(1, Number(options.config?.maxIndexBytes ?? 200 * 1024 * 1024));
  const maxChars = Math.max(1, Number(options.config?.maxMessageChars ?? 20_000));
  const maxResults = Math.max(1, Math.min(100, Number(options.config?.maxResults ?? 50)));
  const intervalMs = Math.max(1, Number(options.config?.indexIntervalMinutes ?? 10)) * 60_000;
  const batchSize = Math.max(1, Math.floor(Number(options.config?.batchSize ?? 10)));
  mkdirSync(dirname(options.dbPath), { recursive: true });
  const db = new Database(options.dbPath, { create: true });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, source TEXT NOT NULL, project TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL, ref TEXT NOT NULL, file TEXT NOT NULL, version TEXT NOT NULL, size INTEGER NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(source UNINDEXED, project UNINDEXED, title, body, tokenize='unicode61');
    CREATE TABLE IF NOT EXISTS indexed_files (file TEXT PRIMARY KEY, mtime REAL NOT NULL, bytes INTEGER NOT NULL, skipped INTEGER NOT NULL DEFAULT 0, file_size INTEGER NOT NULL DEFAULT 0, candidate_bytes INTEGER NOT NULL DEFAULT 0, stored INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const columns = db.query("PRAGMA table_info(indexed_files)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "file_size")) db.exec("ALTER TABLE indexed_files ADD COLUMN file_size INTEGER NOT NULL DEFAULT 0");
  if (!columns.some((column) => column.name === "candidate_bytes")) db.exec("ALTER TABLE indexed_files ADD COLUMN candidate_bytes INTEGER NOT NULL DEFAULT 0");
  if (!columns.some((column) => column.name === "stored")) db.exec("ALTER TABLE indexed_files ADD COLUMN stored INTEGER NOT NULL DEFAULT 1");
  let skipped = Number((db.query("SELECT value FROM settings WHERE key='skipped'").get() as { value: string } | null)?.value ?? 0);
  let lastIndexedAt: string | null = (db.query("SELECT value FROM settings WHERE key='lastIndexedAt'").get() as { value: string } | null)?.value ?? null;
  let lastRunAt: string | null = (db.query("SELECT value FROM settings WHERE key='lastRunAt'").get() as { value: string } | null)?.value ?? null;
  let running = false;
  let filesDone = 0;
  let filesTotal = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let activeRun: Promise<void> | null = null;

  const removeFile = (file: string) => {
    const rows = db.query("SELECT rowid FROM messages WHERE file=?").all(file) as { rowid: number }[];
    const delFts = db.query("DELETE FROM messages_fts WHERE rowid=?");
    const delRow = db.query("DELETE FROM messages WHERE file=?");
    for (const row of rows) delFts.run(row.rowid);
    delRow.run(file);
    db.query("DELETE FROM indexed_files WHERE file=?").run(file);
  };
  const addMessage = (item: RecallMessage, messageId = idFor(item)) => {
    const old = db.query("SELECT rowid FROM messages WHERE id=?").get(messageId) as { rowid: number } | null;
    if (old) { db.query("DELETE FROM messages_fts WHERE rowid=?").run(old.rowid); db.query("DELETE FROM messages WHERE id=?").run(messageId); }
    const inserted = db.query("INSERT INTO messages (id,source,project,title,body,at,ref,file,version,size) VALUES (?,?,?,?,?,?,?,?,?,?)").run(messageId, item.source, item.project, item.title.slice(0, 200), item.body, safeDate(item.at), item.ref, item.file, item.version, item.size);
    db.query("INSERT INTO messages_fts(rowid,source,project,title,body) VALUES(?,?,?,?,?)").run(Number(inserted.lastInsertRowid), item.source, item.project, item.title, item.body);
  };

  async function refresh() {
    const budgetVersion = (db.query("SELECT value FROM settings WHERE key='budgetVersion'").get() as { value: string } | null)?.value;
    if (budgetVersion !== "3") {
      const oldFiles = db.query("SELECT file FROM indexed_files WHERE file NOT LIKE 'entity:%'").all() as { file: string }[];
      for (const { file } of oldFiles) removeFile(file);
      db.query("INSERT OR REPLACE INTO settings(key,value) VALUES('budgetVersion','3')").run();
    }
    let skippedNow = 0;
    let changed = false;
    const limit = maxBytes;
    let indexed = 0;
    let entityBytes = Number((db.query("SELECT COALESCE(SUM(size),0) AS bytes FROM messages WHERE source='me'").get() as { bytes: number }).bytes);
    const threads = await options.store.threads().catch(() => []);
    const threadMap = new Map(threads.map((t) => [t.id, t.data]));
    let messages: Awaited<ReturnType<RecallStore["messages"]>> = [];
    let messagesLoaded = false;
    try { messages = await options.store.messages(); messagesLoaded = true; } catch { skippedNow++; }
    const seen = new Set<string>();
    let entityDone = 0;
    for (const doc of messages) {
      if (++entityDone % batchSize === 0) await yieldToEventLoop();
      const data = doc.data;
      if ((data.role !== "user" && data.role !== "assistant") || typeof data.text !== "string" || !data.text.trim()) continue;
      const file = `entity:${doc.id}`;
      seen.add(file);
      const version = String(doc.updatedSeq);
      const prior = db.query("SELECT version,size FROM messages WHERE id=?").get(file) as { version: string; size: number } | null;
      if (prior?.version === version) continue;
      const thread = typeof data.threadId === "string" ? threadMap.get(data.threadId) : undefined;
      const body = redactString(data.text).slice(0, maxChars);
      const previousSize = prior?.size ?? 0;
      const size = Buffer.byteLength(body);
      if (indexed + entityBytes - previousSize + size > limit) { skippedNow++; continue; }
      const role = data.role as "user" | "assistant";
      const item: RecallMessage = { source: "me", role, project: String(thread?.project ?? ""), title: String(thread?.title ?? data.threadId ?? "대화"), body, at: String(data.ts ?? ""), ref: String(data.threadId ?? doc.id), file, version, size };
      addMessage(item, file);
      entityBytes = entityBytes - previousSize + size;
      changed = true;
    }
    if (messagesLoaded) {
      const entityRows = db.query("SELECT file FROM messages WHERE source='me'").all() as { file: string }[];
      for (const row of entityRows) if (!seen.has(row.file)) {
        const old = db.query("SELECT rowid,size FROM messages WHERE file=?").get(row.file) as { rowid: number; size: number } | null;
        if (old) { db.query("DELETE FROM messages_fts WHERE rowid=?").run(old.rowid); db.query("DELETE FROM messages WHERE file=?").run(row.file); entityBytes = Math.max(0, entityBytes - old.size); }
        changed = true;
      }
    }
    const roots: ["claude" | "codex", string][] = [["claude", join(home, ".claude", "projects")], ["codex", join(home, ".codex", "sessions")]];
    const files = roots.flatMap(([source, root]) => walkJsonl(root).flatMap((file) => {
      try { const stat = statSync(file); return [{ source, file, stat }]; } catch { return []; }
    })).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    filesDone = 0;
    filesTotal = files.length;
    const live = new Set(files.map((f) => f.file));
    const existing = db.query("SELECT file FROM indexed_files WHERE file NOT LIKE 'entity:%'").all() as { file: string }[];
    for (const entry of existing) if (!live.has(entry.file)) {
      const prior = db.query("SELECT bytes FROM indexed_files WHERE file=?").get(entry.file) as { bytes: number } | null;
      indexed = Math.max(0, indexed - (prior?.bytes ?? 0));
      removeFile(entry.file);
      changed = true;
    }
    for (const { source, file, stat } of files) {
      const absolute = resolve(file);
      const secretRoot = resolve(home, ".config", "me", "secrets");
      if (absolute === secretRoot || absolute.startsWith(`${secretRoot}/`)) { removeFile(file); skippedNow++; filesDone++; continue; }
      const prior = db.query("SELECT mtime,bytes,file_size,candidate_bytes,stored,skipped FROM indexed_files WHERE file=?").get(file) as { mtime: number; bytes: number; file_size: number; candidate_bytes: number; stored: number; skipped: number } | null;
      if (prior?.mtime === stat.mtimeMs && prior.file_size === stat.size) {
        if (prior.stored && indexed + prior.bytes + entityBytes <= limit) indexed += prior.bytes;
        else if (prior.stored) {
          const rows = db.query("SELECT rowid FROM messages WHERE file=?").all(file) as { rowid: number }[];
          for (const row of rows) db.query("DELETE FROM messages_fts WHERE rowid=?").run(row.rowid);
          db.query("DELETE FROM messages WHERE file=?").run(file);
          db.query("UPDATE indexed_files SET bytes=0,stored=0 WHERE file=?").run(file);
          indexed = Math.max(0, indexed - prior.bytes);
          skippedNow++;
          changed = true;
        } else if (prior.candidate_bytes === 0) {
          db.query("UPDATE indexed_files SET stored=1 WHERE file=?").run(file);
        } else if (indexed + prior.candidate_bytes + entityBytes <= limit) {
          const { messages: parsed, skipped: fileSkipped } = await fileMessages(source, file, maxChars);
          const textBytes = parsed.reduce((sum, item) => sum + item.size, 0);
          if (indexed + textBytes + entityBytes <= limit) {
            for (const item of parsed) { item.version = `${stat.mtimeMs}:${stat.size}`; addMessage(item); }
            db.query("UPDATE indexed_files SET bytes=?,candidate_bytes=?,skipped=?,stored=1 WHERE file=?").run(textBytes, textBytes, fileSkipped, file);
            indexed += textBytes;
          } else skippedNow++;
        } else skippedNow++;
      } else {
        const { messages: parsed, skipped: fileSkipped } = await fileMessages(source, file, maxChars);
        const textBytes = parsed.reduce((sum, item) => sum + item.size, 0);
        removeFile(file);
        if (indexed + textBytes + entityBytes <= limit) {
          for (const item of parsed) {
            item.version = `${stat.mtimeMs}:${stat.size}`;
            addMessage(item);
          }
          db.query("INSERT OR REPLACE INTO indexed_files(file,mtime,bytes,skipped,file_size,candidate_bytes,stored) VALUES(?,?,?,?,?,?,1)").run(file, stat.mtimeMs, textBytes, fileSkipped, stat.size, textBytes);
          indexed += textBytes;
        } else {
          db.query("INSERT OR REPLACE INTO indexed_files(file,mtime,bytes,skipped,file_size,candidate_bytes,stored) VALUES(?,?,0,?,?,?,0)").run(file, stat.mtimeMs, fileSkipped, stat.size, textBytes);
          skippedNow++;
        }
        changed = true;
      }
      filesDone++;
      if (filesDone % batchSize === 0) await yieldToEventLoop();
    }

    skipped = skippedNow + Number((db.query("SELECT COALESCE(SUM(skipped),0) AS n FROM indexed_files").get() as { n: number }).n);
    if (changed || lastIndexedAt === null) lastIndexedAt = (options.now?.() ?? new Date()).toISOString();
    lastRunAt = (options.now?.() ?? new Date()).toISOString();
    db.query("INSERT OR REPLACE INTO settings(key,value) VALUES('skipped',?)").run(String(skipped));
    db.query("INSERT OR REPLACE INTO settings(key,value) VALUES('lastIndexedAt',?)").run(lastIndexedAt);
    db.query("INSERT OR REPLACE INTO settings(key,value) VALUES('lastRunAt',?)").run(lastRunAt);
  }

  function index() {
    if (activeRun) return activeRun;
    running = true;
    activeRun = refresh().catch(() => { skipped++; }).finally(() => { running = false; activeRun = null; });
    return activeRun;
  }

  const requireText = (value: unknown, field: string) => {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
    return value.trim();
  };
  return {
    async search(p: { q?: unknown; source?: unknown; project?: unknown; limit?: unknown }) {
      const q = requireText(p.q, "q");
      const terms = q.match(/[\p{L}\p{N}_-]+/gu) ?? [];
      if (!terms.length) return [];
      const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
      const limit = Math.max(1, Math.min(maxResults, Number(p.limit ?? 20)));
      const rows = db.query(`SELECT m.source,m.project,m.title,m.at,m.ref,snippet(messages_fts,3,'〔','〕','…',18) AS excerpt FROM messages_fts JOIN messages m ON m.rowid=messages_fts.rowid WHERE messages_fts MATCH ? AND (?='' OR m.source=?) AND (?='' OR m.project=?) ORDER BY bm25(messages_fts) LIMIT ?`).all(match, typeof p.source === "string" ? p.source : "", typeof p.source === "string" ? p.source : "", typeof p.project === "string" ? p.project : "", typeof p.project === "string" ? p.project : "", limit) as any[];
      return rows;
    },
    async status() {
      const rows = db.query("SELECT source,COUNT(*) AS count FROM messages GROUP BY source").all() as { source: string; count: number }[];
      const counts: Record<string, number> = { me: 0, claude: 0, codex: 0, total: 0 };
      for (const row of rows) { counts[row.source] = row.count; counts.total += row.count; }
      const bytes = Number((db.query("SELECT COALESCE(SUM(bytes),0) AS bytes FROM indexed_files").get() as { bytes: number }).bytes)
        + Number((db.query("SELECT COALESCE(SUM(size),0) AS bytes FROM messages WHERE source='me'").get() as { bytes: number }).bytes);
      return { counts, lastIndexedAt, lastRun: lastRunAt, skipped, filesDone, filesTotal, bytes, running };
    },
    async remember(p: { project?: unknown; text?: unknown; source?: unknown; pinned?: unknown }) {
      const project = requireText(p.project, "project");
      const text = redactString(requireText(p.text, "text")).slice(0, maxChars);
      const source = p.source === "task" ? "task" : "user";
      const fact: RecallFact = { id: crypto.randomUUID(), project, text, source, createdAt: (options.now?.() ?? new Date()).toISOString(), pinned: p.pinned === true };
      await options.store.putFact(fact);
      return fact;
    },
    async forget(p: { id?: unknown }) {
      const id = requireText(p.id, "id");
      const fact = await options.store.fact(id);
      if (!fact || fact.deleted) return { removed: false };
      await options.store.putFact({ ...fact, deleted: true });
      return { removed: true };
    },
    async facts(p: { project?: unknown }) {
      const project = typeof p.project === "string" ? p.project : undefined;
      return (await options.store.facts(project)).filter((fact) => !fact.deleted).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt));
    },
    async context(p: { project?: unknown; text?: unknown }) {
      const project = requireText(p.project, "project");
      const text = typeof p.text === "string" ? p.text : "";
      const terms = new Set((text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).filter((term) => term.length > 1));
      const facts = (await options.store.facts(project)).filter((fact) => !fact.deleted);
      facts.sort((a, b) => {
        const score = (fact: RecallFact) => [...terms].reduce((n, term) => n + (fact.text.toLocaleLowerCase().includes(term) ? 1 : 0), 0) + (fact.pinned ? 2 : 0);
        return score(b) - score(a) || b.createdAt.localeCompare(a.createdAt);
      });
      let out = "";
      for (const fact of facts) {
        const line = `- ${redactString(fact.text)}`;
        const next = out ? `${out}\n${line}` : line;
        if (next.length > 800) continue;
        out = next;
      }
      return { project, text: out };
    },
    start() {
      if (!timer) {
        void index();
        timer = setInterval(() => { void index(); }, intervalMs);
        timer.unref?.();
      }
    },
    index,
    close() { if (timer) clearInterval(timer); db.close(); },
  };
}
