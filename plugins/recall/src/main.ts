import { definePlugin, type Plugin } from "@me/sdk";
import { createRecallService, type RecallFact, type RecallStore } from "./recall.ts";

const FACT_SCHEMA = {
  type: "object",
  required: ["id", "project", "text", "source", "createdAt", "pinned"],
  properties: {
    id: { type: "string" }, project: { type: "string" }, text: { type: "string" },
    source: { enum: ["user", "task"] }, createdAt: { type: "string" }, pinned: { type: "boolean" }, deleted: { type: "boolean" },
  },
};

async function listAll<T>(plugin: Plugin, kind: string, where?: Record<string, string | number | boolean>) {
  const rows: any[] = [];
  let after: string | undefined;
  while (true) {
    const batch = await plugin.entity.list<T>({ kind, ...(where ? { where } : {}), limit: 1000, ...(after ? { after } : {}) });
    rows.push(...batch);
    if (batch.length < 1000) return rows;
    after = batch.at(-1)?.id;
  }
}

let service: ReturnType<typeof createRecallService>;
const plugin = definePlugin({
  async onInit() {
    await plugin.entity.registerKind("fact", FACT_SCHEMA);
    const store: RecallStore = {
      messages: async () => (await listAll(plugin, "gjc-head.message")).map((doc) => ({ id: doc.id, updatedSeq: doc.updatedSeq, data: doc.data })),
      threads: async () => (await listAll(plugin, "gjc-head.thread")).map((doc) => ({ id: doc.id, data: doc.data })),
      facts: async (project) => (await listAll<RecallFact>(plugin, "recall.fact", project ? { project } : undefined)).map((doc) => doc.data),
      fact: async (id) => (await plugin.entity.get<RecallFact>("recall.fact", id).catch(() => null))?.data ?? null,
      putFact: async (fact) => { await plugin.entity.upsert("recall.fact", fact.id, fact); },
    };
    service = createRecallService({ dbPath: `${process.env.ME_DATA_DIR ?? "."}/recall.sqlite`, store, config: plugin.config as any });
  },
  methods: {
    "recall.search": (p) => service.search(p ?? {}),
    "recall.status": () => service.status(),
    "recall.remember": (p) => service.remember(p ?? {}),
    "recall.forget": (p) => service.forget(p ?? {}),
    "recall.facts": (p) => service.facts(p ?? {}),
    "recall.context": (p) => service.context(p ?? {}),
  },
});

await plugin.run();
