// Component custom ids (Discord caps them at 100 characters). Approval and task ids are UUIDs.

export type Action =
  | { type: "approval"; approvalId: string; decision: "approve" | "reject" }
  | { type: "harness"; approvalId: string }
  | { type: "task"; taskId: string; action: "accept" | "reject" | "diff" };

const ID = /^[A-Za-z0-9._:-]{1,80}$/;

export const ids = {
  approve: (approvalId: string) => `me.ap:${approvalId}:approve`,
  reject: (approvalId: string) => `me.ap:${approvalId}:reject`,
  harness: (approvalId: string) => `me.ah:${approvalId}`,
  task: (taskId: string, action: "accept" | "reject" | "diff") => `me.tk:${taskId}:${action}`,
};

export function parseAction(customId: string): Action | null {
  const [prefix, rest] = [customId.slice(0, 6), customId.slice(6)];
  if (prefix === "me.ah:") return ID.test(rest) ? { type: "harness", approvalId: rest } : null;
  const at = rest.lastIndexOf(":");
  if (at < 1) return null;
  const [ref, verb] = [rest.slice(0, at), rest.slice(at + 1)];
  if (!ID.test(ref)) return null;
  if (prefix === "me.ap:" && (verb === "approve" || verb === "reject")) return { type: "approval", approvalId: ref, decision: verb };
  if (prefix === "me.tk:" && (verb === "accept" || verb === "reject" || verb === "diff")) return { type: "task", taskId: ref, action: verb };
  return null;
}
