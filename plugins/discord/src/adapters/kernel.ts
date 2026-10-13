// Kernel port over the SDK: gjc-head chat.send, approvals, brgr tasks and entities.
import type { Plugin } from "@me/sdk";
import type { Conversation, HeadMessage, Kernel, Task } from "../ports/index.ts";

export const CONVERSATION = "discord.conversation";

export function kernelPort(plugin: Plugin, opts: { chatTimeoutMs: number }): Kernel {
  return {
    async registerKinds() {
      await plugin.entity.registerKind(CONVERSATION, { type: "object", required: ["threadId", "originKey", "epoch"] });
    },
    // Each Discord message is user input, not a kernel call: start a fresh trace for it.
    chatSend: (p, onUpdate) =>
      plugin.withTrace(crypto.randomUUID(), () =>
        plugin.invoke("gjc-head", "chat.send", p, { stream: true, onUpdate, timeoutMs: opts.chatTimeoutMs }),
      ),
    headMessage: async (id) => (await plugin.entity.get<HeadMessage>("gjc-head.message", id))?.data ?? null,
    listApprovals: async () =>
      (await plugin.approval.list()).map((a) => ({
        ...a,
        payload: a.payload && typeof a.payload === "object" && !Array.isArray(a.payload) ? (a.payload as Record<string, unknown>) : null,
      })),
    decideApproval: async (approvalId, d) => void (await plugin.approval.decide(approvalId, d as any)),
    task: async (taskId) => (await plugin.entity.get<Task>("brgr.task", taskId))?.data ?? null,
    sealedTasks: async () => (await plugin.entity.list<Task>({ kind: "brgr.task", where: { state: "sealed" }, limit: 200 })).map((d) => d.data),
    awaitingTasks: async () => (await plugin.entity.list<Task>({ kind: "brgr.task", where: { state: "awaiting-input" }, limit: 200 })).map((d) => d.data),
    answerTask: async (taskId, answer) => void (await plugin.invoke("brgr", "task.answer", { taskId, ...answer }, { timeoutMs: 30_000 })),
    acceptTask: async (taskId, reason) => void (await plugin.invoke("brgr", "task.accept", { taskId, reason }, { timeoutMs: 120_000 })),
    rejectTask: async (taskId, reason) => void (await plugin.invoke("brgr", "task.reject", { taskId, reason }, { timeoutMs: 120_000 })),
    taskDiff: (taskId) => plugin.invoke("brgr", "task.diff", { taskId }, { timeoutMs: 60_000 }),
    saveConversation: async (c) => void (await plugin.entity.upsert(CONVERSATION, c.threadId, c)),
    conversation: async (threadId) => (await plugin.entity.get<Conversation>(CONVERSATION, threadId))?.data ?? null,
  };
}
