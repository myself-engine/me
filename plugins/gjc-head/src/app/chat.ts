// The head's use case: judges each message and either answers briefly itself or delegates.
// slang → (fast path | summarize → jev) → direct reply or approval → brgr.
import { homedir } from "node:os";
import { join } from "node:path";
import { chooseHarness, decideRoute, fastPathJudgement, isFastPath } from "../domain/routing.ts";
import type { DelegationState, Message, Thread } from "../domain/types.ts";
import type { Approvals, Brain, Delegator, Events, Judge, Normalizer, Store, Summarizer, Turn } from "../ports/index.ts";

export interface HeadConfig {
  harnesses: string[];
  simpleThreshold: number;
  approvalExpiresSec: number;
  defaultProject: string;
}

export interface HeadPorts {
  brain: Brain;
  normalizer: Normalizer;
  summarizer: Summarizer;
  judge: Judge;
  approvals: Approvals;
  delegator: Delegator;
  store: Store;
  events: Events;
}

export interface SendParams {
  threadId?: string;
  text: string;
  project?: string;
}

const now = () => new Date().toISOString();
const expandHome = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export function createHead(ports: HeadPorts, config: HeadConfig) {
  const { brain, normalizer, summarizer, judge, approvals, delegator, store, events } = ports;

  async function saveMessage(m: Message) {
    await store.saveMessage(m);
    await events.messageChanged(m);
  }

  async function ensureThread(p: SendParams): Promise<Thread> {
    if (p.threadId) {
      const t = await store.getThread(p.threadId);
      if (t) return t;
    }
    const t: Thread = {
      id: p.threadId ?? crypto.randomUUID(),
      title: p.text.slice(0, 40),
      project: expandHome(p.project ?? config.defaultProject),
      sessionId: null,
      createdAt: now(),
      updatedAt: now(),
    };
    await store.saveThread(t);
    return t;
  }

  async function send(p: SendParams, turn: Turn) {
    if (!p.text?.trim()) throw new Error("text is required");
    const threshold = config.simpleThreshold;

    const thread = await ensureThread(p);
    if (p.project && expandHome(p.project) !== thread.project) thread.project = expandHome(p.project);
    turn.update({ kind: "thread", threadId: thread.id, project: thread.project });

    const user: Message = { id: crypto.randomUUID(), threadId: thread.id, role: "user", text: p.text, ts: now(), traceId: turn.traceId, status: "done" };
    await saveMessage(user);
    const reply: Message = { id: crypto.randomUUID(), threadId: thread.id, role: "assistant", text: "", ts: now(), traceId: turn.traceId, status: "pending" };
    await saveMessage(reply);
    turn.update({ kind: "message", userMessageId: user.id, messageId: reply.id });

    try {
      turn.phase?.("understanding", "이해 중");
      const understood = await normalizer.normalize(p.text);
      reply.understood = understood;
      turn.update({ kind: "understood", ...understood });

      if (isFastPath(understood.normalized)) {
        // Short chat with no work signals: skip summarize and jev.
        reply.judgement = fastPathJudgement();
        reply.route = "direct";
      } else {
        // Judge first (Jev, ~0.5s); the slower summary is only needed to write a delegation brief.
        turn.phase?.("judging", "판정 중");
        reply.judgement = await judge.judge({ request: understood.normalized });
        reply.route = decideRoute({ needsCodeChange: false, simpleProb: reply.judgement.simpleProb, threshold });
      }
      turn.update({ kind: "judgement", ...reply.judgement, route: reply.route, threshold });
      if (reply.route === "delegate") {
        turn.phase?.("summarizing", "지시서 작성 중");
        const summary = await summarizer.summarize({ original: p.text, normalized: understood.normalized, harnesses: config.harnesses, project: thread.project });
        reply.summary = summary;
        turn.update({ kind: "summary", ...summary });
      }
      await saveMessage(reply);

      if (reply.route === "direct") {
        turn.phase?.("answering", "답변 작성 중");
        await answerDirectly(thread, reply, p.text, turn);
      }
      else await delegate(thread, reply, turn);
      turn.phase?.("done", "완료", 1);

      reply.status = "done";
    } catch (err: any) {
      reply.status = "error";
      reply.error = String(err?.message ?? err);
      turn.update({ kind: "error", message: reply.error });
    }
    thread.updatedAt = now();
    await store.saveThread(thread);
    await saveMessage(reply);
    return { threadId: thread.id, messageId: reply.id, route: reply.route ?? null, status: reply.status };
  }

  async function answerDirectly(thread: Thread, reply: Message, text: string, turn: Turn) {
    reply.status = "streaming";
    await saveMessage(reply);
    const res = await brain.reply({
      prompt: text,
      sessionId: thread.sessionId,
      signal: turn.signal,
      onUpdate: (u) => {
        if (u.kind === "text_delta") reply.text += u.delta;
        turn.update(u);
      },
    });
    if (res.violation) {
      await events.guardViolation({ messageId: reply.id, toolName: res.violation.toolName });
      throw new Error(`head tried to use tool ${res.violation.toolName}; run aborted`);
    }
    reply.text = res.text || reply.text;
    if (res.sessionId) thread.sessionId = res.sessionId;
  }

  async function delegate(thread: Thread, reply: Message, turn: Turn) {
    const s = reply.summary!;
    const brief = s.brief || s.summaryEn;
    const criterion = s.criterion?.trim() || undefined;
    reply.delegation = { state: "awaiting-approval", harness: s.harness, brief, ...(criterion ? { criterion } : {}) };
    await saveMessage(reply);

    turn.phase?.("awaiting-approval", "승인 대기");
    const decisionPromise = approvals.request({
      summary: `${s.harness}에 위임: ${s.summaryEn}`,
      risk: s.needsCodeChange ? "medium" : "low",
      payload: {
        harness: s.harness,
        harnesses: config.harnesses,
        brief,
        ...(criterion ? { criterion } : {}),
        ...(s.role ? { role: s.role } : {}),
        project: thread.project,
        messageId: reply.id,
      },
      expiresInSec: config.approvalExpiresSec,
    });
    turn.update({ kind: "delegation", state: "awaiting-approval", harness: s.harness, brief });
    const decision = await decisionPromise;
    reply.delegation.approvalId = decision.approvalId;

    if (decision.decision !== "approve") {
      reply.delegation.state = "rejected";
      reply.delegation.note = decision.note;
      reply.text = decision.note === "expired" ? "승인 대기 시간이 지나서 위임하지 않았어요." : "위임하지 않았어요.";
      turn.update({ kind: "delegation", state: "rejected", note: decision.note ?? null });
      return;
    }

    const { harness, amended } = chooseHarness({ suggested: s.harness, harnesses: config.harnesses, amend: decision.amend });
    if (amended) {
      reply.delegation.harness = harness;
      reply.delegation.suggestedHarness = s.harness;
    }

    turn.phase?.("delegating", "위임 중");
    const task = await delegator.delegate({
      harness,
      objective: brief,
      criterion,
      project: thread.project,
      origin: { plugin: "gjc-head", messageId: reply.id, threadId: thread.id },
    });
    reply.taskId = task.taskId;
    reply.delegation.state = "delegated";
    reply.text = `${harness}에 맡겼어요. 결과가 나오면 여기서 확인할 수 있어요.`;
    turn.update({ kind: "delegation", state: "delegated", taskId: task.taskId, harness, ...(amended ? { suggestedHarness: s.harness } : {}) });
  }

  /** Mirrors brgr task state onto the message that started the task. */
  async function onTaskEvent(data: { taskId?: string; state?: string }) {
    if (!data?.taskId) return;
    for (const m of await store.messagesByTask(data.taskId)) {
      if (!m.delegation) continue;
      m.delegation.state = (data.state as DelegationState) ?? m.delegation.state;
      await saveMessage(m);
    }
  }

  return { registerKinds: () => store.registerKinds(), send, onTaskEvent };
}
