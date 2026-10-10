// Journal write benchmark (#3, #4): runs a synthetic hour against a temporary ME_HOME and prints row counts and bytes.
// Usage: bun scripts/journal-bench.ts [--json]
// - ops: the real ops service and http probe against a local server, one check, 60 runs one simulated minute apart
//   (as configured in me.config.json), with a 3-minute outage at minute 30.
// - stream: 10 streamed replies, each 5 phases, 10 thought_delta and 94 text_delta updates ~10ms apart.
// - retention: 50,000 entries dated 20 days ago, then one prune with the defaults.
// It never touches ~/.me or ports 7420/7421. It also runs on code without #3/#4 (that gives the "before" numbers).
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPipePair } from "@me/protocol";
import { definePlugin } from "@me/sdk";
import { Kernel } from "../kernel/src/kernel.ts";
import { validateManifest } from "../kernel/src/manifest.ts";
import { kernelCheckStore, kernelEvents, KIND_SCHEMA, kindFor } from "../plugins/ops/src/adapters/kernel.ts";
import { createProbe } from "../plugins/ops/src/adapters/probes.ts";
import { bunExec } from "../plugins/ops/src/adapters/exec.ts";
import { createService } from "../plugins/ops/src/app/service.ts";
import { parseConfig } from "../plugins/ops/src/domain/check.ts";

const root = join(import.meta.dir, "..");
const home = mkdtempSync(join(tmpdir(), "me-bench-"));
const kernel = new Kernel({ dataDir: home, log: () => {} });

const manifest = (m: Record<string, unknown>) =>
  validateManifest({ version: "bench", protocol: { min: 1, max: 1 }, run: { command: ["true"] }, permissions: [], ...m } as any, root);
async function attach(m: Record<string, unknown>, def: Parameters<typeof definePlugin>[0] = {}) {
  const plugin = definePlugin(def);
  const [k, p] = createPipePair();
  void plugin.run(p);
  await kernel.attach(manifest(m), k);
  return plugin;
}

const db = kernel.store.db;
const stats = () => {
  const rows = db
    .prepare(
      `SELECT CASE
         WHEN type = 'event' AND json_extract(body, '$.data.kind') = 'ops.check' THEN 'event: ops.check upsert'
         WHEN type = 'event' THEN 'event: other'
         WHEN type = 'op.update' THEN 'op.update: ' || COALESCE(json_extract(body, '$.update.kind'), '?')
         ELSE type END AS k, COUNT(*) AS n, SUM(LENGTH(body)) AS bytes
       FROM journal GROUP BY k ORDER BY k`,
    )
    .all() as { k: string; n: number; bytes: number }[];
  const total = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(body)), 0) AS bytes FROM journal").get() as { n: number; bytes: number };
  return { rows, total };
};
const size = (p: string) => {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
};
const files = () => ({ sqlite: size(join(home, "me.sqlite")), wal: size(join(home, "me.sqlite-wal")) });

// --- ops: one simulated hour ---------------------------------------------------------------------------------
let outage = false;
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok", { status: outage ? 503 : 200 }) });
const ops = await attach({ id: "ops", permissions: ["read-state", "emit"], provides: { kinds: ["check"], events: ["check.changed", "check.down"] } });
await ops.entity.registerKind(kindFor(ops.id), KIND_SCHEMA);
let now = Date.now();
const clock = { now: () => now, every: () => () => {} };
const service = createService({
  config: parseConfig({ intervalSec: 60, checks: [{ id: "me-web", kind: "http", url: `http://127.0.0.1:${server.port}/`, expectStatus: 200 }] }),
  probe: createProbe({ exec: bunExec() }),
  clock,
  store: kernelCheckStore(ops),
  events: kernelEvents(ops),
  log: () => {},
});
await service.load();
const opsStart = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM journal").get() as any).s as number;
for (let minute = 0; minute < 60; minute++) {
  outage = minute >= 30 && minute < 33;
  await service.run();
  now += 60_000;
}
server.stop(true);
const opsRows = (db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(body)), 0) AS bytes FROM journal WHERE seq > ?").get(opsStart) as any) as {
  n: number;
  bytes: number;
};

// --- stream: 10 replies --------------------------------------------------------------------------------------
await attach(
  { id: "talker", provides: { methods: ["talk"] } },
  {
    methods: {
      talk: async (_p, ctx) => {
        ctx.phase("understanding");
        ctx.phase("judging");
        for (let i = 0; i < 10; i++) {
          ctx.update({ kind: "thought_delta", delta: "생각 중… " });
          await Bun.sleep(10);
        }
        ctx.phase("answering");
        for (let i = 0; i < 94; i++) {
          ctx.update({ kind: "text_delta", delta: i % 3 === 0 ? "TCP는 " : i % 3 === 1 ? "연결을 " : "맺는다. " });
          await Bun.sleep(10);
        }
        ctx.phase("finishing");
        ctx.phase("done");
        return { ok: true };
      },
    },
  },
);
const caller = await attach({ id: "caller", permissions: ["call:talker", "journal.read"] });
let live = 0;
const streamStart = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM journal").get() as any).s as number;
const traces: string[] = [];
for (let i = 0; i < 10; i++) {
  const traceId = crypto.randomUUID();
  traces.push(traceId);
  await caller.withTrace(traceId, () => caller.invoke("talker", "talk", {}, { stream: true, onUpdate: () => void live++ }));
}
const streamRows = db
  .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(body)), 0) AS bytes FROM journal WHERE seq > ? AND type = 'op.update'")
  .get(streamStart) as { n: number; bytes: number };
const trace = await caller.getTrace(traces[0]!);
const phases = trace.nodes[0]?.phases.map((p) => p.phase).join("→") ?? "(none)";

const afterRun = { ...stats(), files: files() };

// --- retention -----------------------------------------------------------------------------------------------
const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
const ins = db.prepare("INSERT INTO journal (ts, source, type, body) VALUES (?, 'bench', 'lifecycle', ?)");
db.transaction(() => {
  for (let i = 0; i < 50_000; i++) ins.run(old, JSON.stringify({ filler: "x".repeat(200), i }));
})();
const beforePrune = { rows: stats().total.n, files: files() };
const canPrune = typeof (kernel as any).pruneJournal === "function";
const pruned = canPrune ? (kernel as any).pruneJournal() : 0;
const afterPrune = { rows: stats().total.n, files: files() };

const result = {
  ops: { runs: 60, journalRows: opsRows.n, journalBytes: opsRows.bytes },
  stream: { liveUpdates: live, opUpdateRows: streamRows.n, opUpdateBytes: streamRows.bytes, firstTracePhases: phases },
  journal: afterRun,
  retention: { supported: canPrune, beforePrune, pruned, afterPrune },
};

await kernel.stop();
rmSync(home, { recursive: true, force: true });

if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
else {
  const kb = (n: number) => `${(n / 1024).toFixed(1)}KB`;
  console.log(`ops (60 runs = 1 simulated hour at 60s): ${result.ops.journalRows} journal rows, ${kb(result.ops.journalBytes)}`);
  console.log(
    `stream (10 replies): ${result.stream.liveUpdates} live updates delivered → ${result.stream.opUpdateRows} op.update rows, ${kb(result.stream.opUpdateBytes)}; trace phases ${result.stream.firstTracePhases}`,
  );
  console.log("journal after both:");
  for (const r of result.journal.rows) console.log(`  ${r.k.padEnd(28)} ${String(r.n).padStart(6)} rows ${kb(r.bytes).padStart(10)}`);
  console.log(`  ${"total".padEnd(28)} ${String(result.journal.total.n).padStart(6)} rows ${kb(result.journal.total.bytes).padStart(10)}`);
  console.log(`  files: sqlite ${kb(afterRun.files.sqlite)}, wal ${kb(afterRun.files.wal)}`);
  console.log(
    `retention (+50,000 rows dated 20 days ago): ${beforePrune.rows} rows, sqlite ${kb(beforePrune.files.sqlite)} + wal ${kb(beforePrune.files.wal)} → ` +
      (canPrune
        ? `pruned ${pruned} → ${afterPrune.rows} rows, sqlite ${kb(afterPrune.files.sqlite)} + wal ${kb(afterPrune.files.wal)}`
        : "no retention in this build"),
  );
}
process.exit(0);
