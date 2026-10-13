import type { Plugin } from "@me/sdk";
import type { WatchAgent } from "../domain/watch.ts";
import type { AgentStore, WatchEvents, WatchStatus } from "../ports/index.ts";

export const AGENT_KIND = "watch.agent";
export const STATUS_KIND = "watch.status";

export const AGENT_SCHEMA = {
  type: "object",
  required: ["pane", "kind", "state", "since", "lastChangeAt", "stalled"],
  properties: {
    pane: { type: "string" },
    kind: { type: "string" },
    state: { type: "string", enum: ["working", "waiting-input", "idle", "done", "unknown"] },
    since: { type: "string" },
    lastChangeAt: { type: "string" },
    brgrTaskId: { type: ["string", "null"] },
    stalled: { type: "boolean" },
  },
};

export const STATUS_SCHEMA = {
  type: "object",
  required: ["state", "problem", "checkedAt"],
  properties: {
    state: { type: "string", enum: ["ok", "problem"] },
    problem: { type: ["string", "null"] },
    checkedAt: { type: "string" },
  },
};

export function kernelStore(plugin: Plugin): AgentStore {
  return {
    list: async () => (await plugin.entity.list<WatchAgent>({ kind: AGENT_KIND, limit: 1000 })).map((row) => row.data),
    put: async (agent) => void (await plugin.entity.upsert(AGENT_KIND, agent.pane, agent)),
    remove: async (pane) => {
      // The entity protocol has no delete operation; a vanished pane is marked done.
      const prior = await plugin.entity.get<WatchAgent>(AGENT_KIND, pane).catch(() => null);
      if (prior?.data) await plugin.entity.upsert(AGENT_KIND, pane, { ...prior.data, state: "done", lastChangeAt: new Date().toISOString() });
    },
    getStatus: async () => (await plugin.entity.get<WatchStatus>(STATUS_KIND, "current").catch(() => null))?.data ?? null,
    putStatus: async (status) => void (await plugin.entity.upsert(STATUS_KIND, "current", status)),
  };
}

export function kernelEvents(plugin: Plugin): WatchEvents {
  return { emit: async (name, data) => void (await plugin.emit(name, data)) };
}
