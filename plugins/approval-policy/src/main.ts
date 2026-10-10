// approval-policy: auto-approves pending approvals that match configured low-risk rules.
// It is a separate plugin from the requester, so the kernel's "no self-approval" rule still holds,
// and every automatic decision is journaled with the rule that allowed it.
import { definePlugin } from "@me/sdk";
import { evaluate, type PendingApproval, type Rule } from "./policy.ts";

const decided = new Set<string>();

const plugin = definePlugin({
  async onInit() {
    // Approvals that were pending before this plugin started are evaluated too.
    for (const a of await plugin.approval.list()) await consider(a as PendingApproval);
  },
  async onEvent(name, data) {
    if (name === "kernel.approval.pending") await consider(data as PendingApproval);
  },
  methods: {
    "rules.list": () => rules(),
    evaluate: (p: PendingApproval) => evaluate(p, rules()),
  },
});

function rules(): Rule[] {
  return ((plugin.config.rules as unknown) as Rule[]) ?? [];
}

async function consider(a: PendingApproval) {
  if (decided.has(a.approvalId)) return;
  const v = evaluate(a, rules());
  if (!v.auto) return;
  decided.add(a.approvalId);
  try {
    await plugin.approval.decide(a.approvalId, { decision: "approve", note: `자동 승인: ${v.rule}` });
  } catch (err) {
    // Already decided by the user or expired; nothing to do.
    console.error(`[approval-policy] could not decide ${a.approvalId}:`, err);
  }
}

await plugin.run();
