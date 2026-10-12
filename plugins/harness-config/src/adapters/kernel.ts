// Events and approvals over the kernel SDK.
import type { Plugin } from "@me/sdk";
import type { Approvals, Events } from "../ports/index.ts";

export function kernelApprovals(plugin: Plugin): Approvals {
  return {
    // `amend` is ignored on purpose: an apply writes exactly the pinned plan.
    request: async (req) => {
      const r = await plugin.approval.request(req);
      return { decision: r.decision, ...(r.note ? { note: r.note } : {}), approvalId: r.approvalId };
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
