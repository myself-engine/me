// Events over the kernel SDK.
import type { Plugin } from "@me/sdk";
import type { Events } from "../ports/index.ts";

export function kernelEvents(plugin: Plugin): Events {
  return {
    emit: async (name, data) => {
      await plugin.emit(name, data);
    },
  };
}
