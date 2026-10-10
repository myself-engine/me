// TaskStore and Events over the kernel SDK (entity store and event bus).
import type { Plugin } from "@me/sdk";
import type { Task, TaskState } from "../domain/task.ts";
import type { Events, TaskStore } from "../ports/index.ts";

export const KIND = "brgr.task";

export function kernelTaskStore(plugin: Plugin): TaskStore {
  return {
    get: async (taskId) => (await plugin.entity.get<Task>(KIND, taskId))?.data ?? null,
    put: async (task) => {
      await plugin.entity.upsert(KIND, task.taskId, task);
    },
    listByState: async (state: TaskState) => (await plugin.entity.list<Task>({ kind: KIND, where: { state }, limit: 100 })).map((d) => d.data),
  };
}

export function kernelEvents(plugin: Plugin): Events {
  return {
    emit: async (name, data) => {
      await plugin.emit(name, data);
    },
  };
}
