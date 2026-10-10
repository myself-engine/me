// CheckStore and Events over the kernel SDK (entity store and event bus), plus the real clock.
import type { Plugin } from "@me/sdk";
import type { CheckRecord } from "../domain/check.ts";
import type { CheckStore, Clock, Events } from "../ports/index.ts";

/** Entity kind for this instance: `<plugin id>.check`, so several ops instances (one per machine) can coexist. */
export const kindFor = (pluginId: string) => `${pluginId}.check`;

export const KIND_SCHEMA = {
  type: "object",
  required: ["id", "kind", "ok", "status", "detail", "latencyMs", "checkedAt", "since"],
  properties: {
    id: { type: "string" },
    kind: { type: "string" },
    ok: { type: "boolean" },
    status: { type: "string", enum: ["up", "down", "unknown"] },
    detail: { type: "string" },
    latencyMs: { type: "number" },
    checkedAt: { type: "string" },
    since: { type: "string" },
  },
};

export function kernelCheckStore(plugin: Plugin): CheckStore {
  return {
    list: async () => (await plugin.entity.list<CheckRecord>({ kind: kindFor(plugin.id), limit: 1000 })).map((d) => d.data),
    put: async (record) => {
      await plugin.entity.upsert(kindFor(plugin.id), record.id, record);
    },
  };
}

export function kernelEvents(plugin: Plugin): Events {
  return {
    emit: async (name, data) => {
      await plugin.emit(name, data);
    },
  };
}

export function systemClock(): Clock {
  return {
    now: () => Date.now(),
    every: (ms, fn) => {
      const t = setInterval(fn, ms);
      return () => clearInterval(t);
    },
  };
}
