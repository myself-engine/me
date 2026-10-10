// Smoke test against real models: spawns slang, summarize, jev, gjc-head and a fake brgr,
// then sends one simple and one code-change message through the head.
// Usage: bun scripts/smoke-head.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPipePair, type JsonValue } from "@me/protocol";
import { definePlugin } from "@me/sdk";
import { Kernel, loadManifest, validateManifest } from "@me/kernel";

const root = join(import.meta.dir, "..");

function smokeConfig(model: string | undefined): Record<string, Record<string, JsonValue>> {
  const m: Record<string, string> = model ? { model } : {};
  const jev: Record<string, string> = model ? { fallbackModel: model } : {};
  return {
    "gjc-head": { harnesses: ["local.claude-code", "local.codex"], defaultProject: root, ...m },
    summarize: { ...m },
    jev,
  };
}
const dataDir = mkdtempSync(join(tmpdir(), "me-smoke-"));
const kernel = new Kernel({
  dataDir,
  log: (m) => console.error(`[kernel] ${m}`),
  // ME_SMOKE_MODEL overrides the model for every LLM step (e.g. when the default account is logged out).
  pluginConfig: smokeConfig(process.env.ME_SMOKE_MODEL),
});

for (const id of ["slang", "summarize", "jev", "gjc-head"]) {
  await kernel.spawn(await loadManifest(join(root, "plugins", id, "plugin.json")));
  console.error(`${id}: ${kernel.pluginState(id)}`);
}

// Fake brgr so delegation can complete without spending a worker run.
const brgr = definePlugin({ methods: { "task.delegate": (p) => ({ taskId: `fake-${p.harness}` }) } });
const [k1, p1] = createPipePair();
void brgr.run(p1);
await kernel.attach(validateManifest({ id: "brgr", version: "0", protocol: { min: 1, max: 1 }, run: { command: ["true"] }, permissions: [], provides: { methods: ["task.delegate"] } }, root), k1);

let decideNext: "approve" | "reject" = "approve";
const ui = definePlugin({
  onEvent: async (name, data) => {
    if (name !== "kernel.approval.pending") return;
    console.log(`  approval requested: ${data.summary} → ${decideNext}`);
    await ui.approval.decide(data.approvalId, { decision: decideNext });
  },
});
const [k2, p2] = createPipePair();
void ui.run(p2);
await kernel.attach(
  validateManifest({ id: "ui", version: "0", protocol: { min: 1, max: 1 }, run: { command: ["true"] }, permissions: ["call:gjc-head", "approve.decide", "subscribe", "read-state"], subscribes: ["kernel.approval.*"] }, root),
  k2,
);

async function send(text: string) {
  console.log(`\n> ${text}`);
  const started = Date.now();
  let streamed = "";
  const result = await ui.invoke("gjc-head", "chat.send", { text }, {
    stream: true,
    timeoutMs: 300_000,
    newTrace: true,
    onUpdate: (u) => {
      if (u.kind === "text_delta") streamed += u.delta;
      else if (u.kind !== "thought_delta") console.log(`  [${u.kind}]`, JSON.stringify(u).slice(0, 220));
    },
  });
  console.log(`  reply: ${streamed.trim().slice(0, 300) || "(no streamed text)"}`);
  console.log(`  result: ${JSON.stringify(result)} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return result;
}

const results = [] as any[];
results.push(await send("ㅎㅇ 넌 뭐하는 애야? 한 줄로"));
decideNext = "approve";
results.push(await send("me README에 설치 방법 섹션 추가하셈"));

const journal = kernel.store.query({ limit: 1000 });
console.log(`\njournal entries: ${journal.length}, types: ${[...new Set(journal.map((e) => e.type))].join(", ")}`);
await kernel.stop();
const ok = results[0]?.route === "direct" && results[0]?.status === "done" && results[1]?.route === "delegate" && results[1]?.status === "done";
console.log(ok ? "SMOKE OK" : "SMOKE FAILED");
process.exit(ok ? 0 : 1);
