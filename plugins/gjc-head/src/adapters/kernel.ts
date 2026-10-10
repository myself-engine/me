// Ports over the kernel SDK: other plugins via invoke, entities, approvals and events.
import type { Plugin } from "@me/sdk";
import type { Judgement, Message, Summary, Thread, Understood } from "../domain/types.ts";
import type { Approvals, Delegator, Events, Judge, Normalizer, Store, Summarizer } from "../ports/index.ts";

export const THREAD = "gjc-head.thread";
export const MESSAGE = "gjc-head.message";

export function kernelNormalizer(plugin: Plugin): Normalizer {
  return { normalize: (text) => plugin.invoke<Understood>("slang", "normalize", { text }) };
}

export function kernelSummarizer(plugin: Plugin): Summarizer {
  return { summarize: (p) => plugin.invoke<Summary>("summarize", "summarize", p, { timeoutMs: 120_000 }) };
}

export function kernelJudge(plugin: Plugin): Judge {
  return { judge: (p) => plugin.invoke<Judgement>("jev", "judge", p, { timeoutMs: 120_000 }) };
}

export function kernelApprovals(plugin: Plugin): Approvals {
  return { request: (p) => plugin.approval.request(p as Parameters<Plugin["approval"]["request"]>[0]) };
}

export function brgrDelegator(plugin: Plugin): Delegator {
  return { delegate: (p) => plugin.invoke<{ taskId: string }>("brgr", "task.delegate", p, { timeoutMs: 120_000 }) };
}

export function entityStore(plugin: Plugin): Store {
  return {
    async registerKinds() {
      await plugin.entity.registerKind(THREAD, { type: "object", required: ["id", "title", "project"] });
      await plugin.entity.registerKind(MESSAGE, {
        type: "object",
        required: ["id", "threadId", "role", "text", "status"],
        properties: { role: { enum: ["user", "assistant"] }, status: { enum: ["pending", "streaming", "done", "error"] } },
      });
    },
    getThread: async (id) => (await plugin.entity.get<Thread>(THREAD, id))?.data ?? null,
    saveThread: async (t) => void (await plugin.entity.upsert(THREAD, t.id, t)),
    saveMessage: async (m) => void (await plugin.entity.upsert(MESSAGE, m.id, m)),
    messagesByTask: async (taskId) => (await plugin.entity.list<Message>({ kind: MESSAGE, where: { taskId }, limit: 5 })).map((d) => d.data),
  };
}

export function kernelEvents(plugin: Plugin): Events {
  return {
    messageChanged: async (m) => void (await plugin.emit("message.changed", { id: m.id, threadId: m.threadId })),
    guardViolation: async (p) => void (await plugin.emit("guard.violation", p)),
  };
}
