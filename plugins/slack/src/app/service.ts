// The Slack window's use cases: a messenger front end for gjc-head, the same peer as the web and Discord plugins.
// Inbound: admit → dedupe → one queue per conversation → chat.send. Outbound replies go through the ledger.
// While the head streams, a preview message is edited in place; the ledgered final reply replaces it.
import {
  ConversationQueue,
  Ledger,
  SendRejected,
  admit,
  drain,
  originKey,
  parseOriginKey,
  type InboundMessage,
  type Origin,
  type PlatformSender,
} from "@me/messenger";
import type { SlackConfig } from "../domain/config.ts";
import { parseAction } from "../domain/ids.ts";
import { channelOrigin, isNewCommand, originOf, ownerDm, toInbound, type SlackMessage } from "../domain/inbound.ts";
import { toMrkdwn } from "../domain/mrkdwn.ts";
import { REACTIONS, stageOf, type Stage } from "../domain/progress.ts";
import { approvalCard, approvalDecidedCard, approvalView, taskCard, taskClosedCard, type ApprovalView } from "../domain/render.ts";
import { SLACK_LIMIT, splitMessage, truncate } from "../domain/split.ts";
import type { CardStore, ComponentPress, ComponentReply, Kernel, PendingApproval, SlackGateway } from "../ports/index.ts";

export interface AppDeps {
  gateway: SlackGateway;
  kernel: Kernel;
  ledger: Ledger;
  cards: CardStore;
  config: SlackConfig;
  now?: () => string;
  log?: (...args: unknown[]) => void;
}

/** Room left in each chunk for the duplicate label a recovered delivery gets appended. */
export const CHUNK_LIMIT = SLACK_LIMIT - 100;
/** Footer of a streaming preview; a preview left behind by a crash still reads as unfinished. */
export const STREAMING = "_✍️ 답하는 중…_";

const REFUSED = "이 버튼은 주인만 누를 수 있어요.";
const TASK_CLOSED = new Set(["accepted", "applied", "apply-failed", "rejected", "cancelled"]);
const errText = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 300);

export function createSlackApp(deps: AppDeps) {
  const { gateway, kernel, ledger, cards, config } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const log = deps.log ?? ((...a: unknown[]) => console.error("[slack]", ...a));
  const queue = new ConversationQueue();
  const inflight = new Set<Promise<unknown>>();
  const posting = new Set<string>();
  /** Harness picked in a card's select menu, per approval, until the approval is decided. */
  const chosen = new Map<string, string>();
  /** Streaming preview to overwrite with the final reply, keyed by origin key + the user's message ts. */
  const previews = new Map<string, string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const track = <T>(p: Promise<T>) => {
    const t = p.catch((err) => log("failed:", errText(err)));
    inflight.add(t);
    void t.finally(() => inflight.delete(t));
    return t;
  };
  const quietly = (p: Promise<unknown>) => void p.catch((err) => log("best-effort call failed:", errText(err)));

  // ---- outbound: ledger + a single drainer ---------------------------------

  // Only a reply's first chunk carries replyTo, so it alone can take over the preview. If the preview is
  // gone (deleted, or Slack refuses the edit), the chunk is posted as a new message instead.
  const sender: PlatformSender = {
    async send(origin, text, replyTo) {
      const key = replyTo ? `${originKey(origin)}|${replyTo}` : null;
      const preview = key ? previews.get(key) : undefined;
      if (key && preview) {
        try {
          await gateway.edit(origin, preview, { text });
          previews.delete(key);
          return preview;
        } catch (err) {
          if (!(err instanceof SendRejected) || err.retryable) throw err;
          previews.delete(key);
        }
      }
      return gateway.send(origin, { text, replyTo });
    },
  };
  let draining: Promise<void> | null = null;
  let again = false;

  /** Drains the ledger; concurrent callers share one run so a delivery is never sent twice. */
  function drainNow(): Promise<void> {
    if (draining) {
      again = true;
      return draining;
    }
    draining = (async () => {
      do {
        again = false;
        const r = await drain(ledger, sender);
        if (r.failed || r.uncertain) log("drain:", r);
      } while (again);
    })().finally(() => {
      draining = null;
    });
    return draining;
  }

  async function reply(origin: Origin, text: string, replyTo: string | null) {
    splitMessage(toMrkdwn(text), CHUNK_LIMIT).forEach((chunk, i) => ledger.enqueue(origin, chunk, i === 0 ? replyTo : null));
    await drainNow();
  }

  /**
   * A best-effort live view of the streamed text: posted on the first delta, then edited at most
   * every streamIntervalMs. It is not ledgered; the final reply goes through the ledger and replaces it.
   */
  function streamPreview(origin: Origin, replyTo: string) {
    let text = "";
    let shown = "";
    let ts: string | null = null;
    let closed = false;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let chain: Promise<void> = Promise.resolve();

    const flush = () => {
      pending = null;
      if (closed || text === shown) return;
      shown = text;
      const body = `${truncate(toMrkdwn(text), CHUNK_LIMIT - STREAMING.length - 2)}\n\n${STREAMING}`;
      chain = chain
        .then(async () => {
          if (closed) return;
          if (ts) await gateway.edit(origin, ts, { text: body });
          else ts = await gateway.send(origin, { text: body, replyTo });
        })
        .catch((err) => log("stream preview failed:", errText(err)));
    };

    return {
      push(delta: string) {
        text += delta;
        if (!closed && !pending) pending = setTimeout(flush, ts || shown ? config.streamIntervalMs : 0);
      },
      /** Stops updating and resolves with the preview's ts, if one was posted. */
      async finish(): Promise<string | null> {
        closed = true;
        if (pending) clearTimeout(pending);
        await chain;
        return ts;
      },
    };
  }

  // ---- conversations ↔ head threads ------------------------------------------

  async function newThread(origin: Origin, epoch: number) {
    const threadId = crypto.randomUUID();
    // The kernel mapping first: a thread the window cannot map back would strand its approvals and tasks.
    await kernel.saveConversation({ threadId, originKey: originKey(origin), epoch, createdAt: now() });
    ledger.setSession(origin, threadId);
    return threadId;
  }

  async function threadFor(origin: Origin) {
    const c = ledger.conversation(origin);
    return c.sessionId ?? newThread(origin, c.epoch);
  }

  async function originOfThread(threadId: unknown): Promise<Origin | null> {
    if (typeof threadId !== "string" || !threadId) return null;
    const c = await kernel.conversation(threadId);
    return c ? parseOriginKey(c.originKey) : null;
  }

  // ---- inbound ---------------------------------------------------------------

  function onMessage(m: SlackMessage) {
    let inbound: InboundMessage;
    try {
      inbound = toInbound(m, gateway.botUserId, ledger.hasConversation(originOf(m)));
      // Admission is per channel (allowlist, openGroups); the conversation itself is the thread.
      if (!admit({ ...inbound, origin: channelOrigin(m) }, config.policy, gateway.botUserId).admit) return;
    } catch (err) {
      return log("unroutable message:", errText(err));
    }
    if (!ledger.recordInbound(inbound)) return; // Slack redelivered it
    quietly(gateway.react(inbound.origin, inbound.messageId, REACTIONS.received));
    return track(queue.run(inbound.origin, () => handle(inbound)));
  }

  async function handle(m: InboundMessage) {
    const { origin } = m;
    const shown = new Set<Stage>();
    const stage = (s: Stage) => {
      if (shown.has(s)) return;
      shown.add(s);
      quietly(gateway.react(origin, m.messageId, REACTIONS[s]));
    };

    if (isNewCommand(m.text)) {
      await newThread(origin, ledger.newEpoch(origin));
      stage("done");
      return reply(origin, "새 대화를 시작했어요.", m.messageId);
    }
    if (!m.text) return;

    const preview = streamPreview(origin, m.messageId);
    let streamed = "";
    let text: string;
    try {
      const threadId = await threadFor(origin);
      const result = await kernel.chatSend({ threadId, text: m.text }, (u) => {
        if (u?.kind === "text_delta" && typeof u.delta === "string") {
          streamed += u.delta;
          preview.push(u.delta);
        }
        const s = stageOf(u);
        if (s) stage(s);
      });
      // chat.send returns ids only; the reply text lives on the head's message entity.
      const msg = await kernel.headMessage(result.messageId).catch(() => null);
      if (result.status === "error") {
        stage("error");
        text = `⚠️ 처리하지 못했어요: ${msg?.error ?? "알 수 없는 오류"}`;
      } else {
        stage("done");
        text = msg?.text?.trim() || streamed.trim();
      }
    } catch (err) {
      stage("error");
      text = `⚠️ 처리하지 못했어요: ${errText(err)}`;
    }
    const ts = await preview.finish();
    if (ts) previews.set(`${originKey(origin)}|${m.messageId}`, ts);
    if (text) await reply(origin, text, m.messageId);
  }

  // ---- approvals -------------------------------------------------------------

  async function approvalOrigin(a: PendingApproval): Promise<Origin | null> {
    const messageId = a.payload?.messageId;
    if (typeof messageId === "string") {
      const msg = await kernel.headMessage(messageId);
      const origin = await originOfThread(msg?.threadId);
      if (origin) return origin;
    }
    return config.approvalsToOwnerDm ? ownerDm(config.policy.ownerId) : null;
  }

  async function postApproval(a: PendingApproval) {
    const key = `approval:${a.approvalId}`;
    if (posting.has(key) || cards.get("approval", a.approvalId)) return;
    posting.add(key);
    try {
      const origin = await approvalOrigin(a);
      if (!origin) return;
      const view = approvalView(a);
      const card = approvalCard(view, null);
      const messageId = await gateway.send(origin, card);
      cards.put({ kind: "approval", ref: a.approvalId, originKey: originKey(origin), messageId, data: { view } });
    } finally {
      posting.delete(key);
    }
  }

  async function closeApproval(d: { approvalId: string; decision: string; note?: string | null; amend?: Record<string, unknown> | null }) {
    chosen.delete(d.approvalId);
    const card = cards.get("approval", d.approvalId);
    if (!card) return;
    const view = card.data.view as ApprovalView;
    await gateway.edit(parseOriginKey(card.originKey), card.messageId, approvalDecidedCard(view, d));
  }

  async function pickHarness(approvalId: string, harness: string | undefined): Promise<ComponentReply> {
    const card = cards.get("approval", approvalId);
    const view = card?.data.view as ApprovalView | undefined;
    if (!card || !view) return { text: "이미 처리됐거나 모르는 승인 요청이에요." };
    if (!harness || !view.harnesses.includes(harness)) return { text: "목록에 없는 하네스예요." };
    chosen.set(approvalId, harness);
    quietly(gateway.edit(parseOriginKey(card.originKey), card.messageId, approvalCard(view, harness)));
    return { text: `하네스를 \`${harness}\`(으)로 골랐어요. 승인을 누르면 이 하네스로 맡겨요.` };
  }

  async function decide(approvalId: string, decision: "approve" | "reject"): Promise<ComponentReply> {
    const view = cards.get("approval", approvalId)?.data.view as ApprovalView | undefined;
    const harness = chosen.get(approvalId);
    const amend = decision === "approve" && harness && harness !== view?.harness ? { harness } : undefined;
    await kernel.decideApproval(approvalId, { decision, note: "slack", ...(amend ? { amend } : {}) });
    if (decision === "reject") return { text: "거절했어요." };
    return { text: amend ? `\`${harness}\`(으)로 바꿔서 승인했어요.` : "승인했어요." };
  }

  // ---- delegated tasks ------------------------------------------------------

  async function postTask(taskId: string) {
    const key = `task:${taskId}`;
    if (posting.has(key) || cards.get("task", taskId)) return;
    posting.add(key);
    try {
      const task = await kernel.task(taskId);
      if (!task || task.state !== "sealed") return;
      const origin = await originOfThread(task.origin?.threadId);
      if (!origin) return;
      const card = taskCard(task);
      const messageId = await gateway.send(origin, card);
      cards.put({ kind: "task", ref: taskId, originKey: originKey(origin), messageId, data: { text: card.text } });
    } finally {
      posting.delete(key);
    }
  }

  async function closeTask(taskId: string, state: string) {
    const card = cards.get("task", taskId);
    if (!card) return;
    await gateway.edit(parseOriginKey(card.originKey), card.messageId, taskClosedCard(String(card.data.text ?? ""), state));
  }

  async function taskAction(taskId: string, action: "accept" | "reject" | "diff"): Promise<ComponentReply> {
    if (action === "accept") {
      await kernel.acceptTask(taskId, "Slack에서 수락");
      return { text: "수락했어요. 변경을 프로젝트에 반영해요." };
    }
    if (action === "reject") {
      await kernel.rejectTask(taskId, "Slack에서 거절");
      return { text: "거절했어요." };
    }
    const d = await kernel.taskDiff(taskId);
    if (d.error) return { text: `diff를 가져오지 못했어요: ${d.error.slice(0, 300)}` };
    if (!d.diff.trim()) return { text: "변경된 내용이 없어요." };
    return { text: "diff를 첨부했어요.", file: { name: `${taskId.slice(0, 8)}.diff`, content: d.diff } };
  }

  // ---- components (owner-only) ----------------------------------------------

  async function onComponent(p: ComponentPress): Promise<ComponentReply> {
    const action = parseAction(p.customId);
    if (!action) return { text: "모르는 버튼이에요." };
    if (p.userId !== config.policy.ownerId) return { text: REFUSED };
    try {
      if (action.type === "harness") return await pickHarness(action.approvalId, p.values[0]);
      if (action.type === "approval") return await decide(action.approvalId, action.decision);
      return await taskAction(action.taskId, action.action);
    } catch (err) {
      return { text: `실패했어요: ${errText(err)}` };
    }
  }

  // ---- kernel events ----------------------------------------------------------

  function onKernelEvent(name: string, data: any) {
    if (name === "kernel.approval.pending" && data?.approvalId) return track(postApproval(data));
    if (name === "kernel.approval.decided" && data?.approvalId) return track(closeApproval(data));
    if (!name.startsWith("brgr.task.") || typeof data?.taskId !== "string") return; // gjc-head.message.*: the web's concern
    const state = name.slice("brgr.task.".length);
    if (state === "sealed") return track(postTask(data.taskId));
    if (TASK_CLOSED.has(state)) return track(closeTask(data.taskId, state));
  }

  // Handlers go on before the socket connects so no early message is missed; recovery runs before any drain.
  gateway.onMessage(onMessage);
  gateway.onComponent(onComponent);
  const recovered = ledger.recoverUncertain();
  if (recovered.length) log(`reissuing ${recovered.length} uncertain repl${recovered.length === 1 ? "y" : "ies"} with the duplicate label`);

  return {
    /** Call once the gateway is connected: drains recovered replies and posts what was missed while down. */
    async start() {
      await kernel.registerKinds();
      await drainNow();
      timer = setInterval(() => void drainNow().catch((err) => log("drain failed:", errText(err))), config.drainIntervalMs);
      for (const a of await kernel.listApprovals()) await track(postApproval(a));
      for (const t of await kernel.sealedTasks()) await track(postTask(t.taskId));
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    onKernelEvent,
    drain: drainNow,
    /** Resolves when every message and event in flight has been handled. */
    async idle() {
      while (inflight.size) await Promise.all([...inflight]);
      if (draining) await draining;
    },
  };
}

export type SlackApp = ReturnType<typeof createSlackApp>;
