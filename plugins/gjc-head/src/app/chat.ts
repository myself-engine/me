// The head's use case: judges each message and either answers briefly itself or delegates.
// slang → (fast path | summarize → jev) → direct reply or approval → brgr.
import { homedir } from "node:os";
import { join } from "node:path";
import { chooseHarness, decideRoute, fastPathJudgement, isFastPath } from "../domain/routing.ts";
import { describeFailure, friendlyError, type AlertCause } from "../domain/alerts.ts";
import { brainChoice, checkHeadChoice, checkWorkerChoice, EFFORTS, isAnthropic, WORKER_EFFORTS } from "../domain/settings.ts";
import type { DelegationState, Effort, HeadSettings, Message, Thread } from "../domain/types.ts";
import type { Approvals, Brain, BrainUpdate, Delegator, Events, Judge, ModelCatalog, Normalizer, Store, Summarizer, Turn, WarmBrain } from "../ports/index.ts";

export interface HeadConfig {
  harnesses: string[];
  /** Initial defaults for the head; once the user changes them, the stored settings win. */
  model: string;
  effort: Effort;
  favoriteModels: string[];
  /** Favourite worker models per harness, offered at approval. */
  workerModels: Record<string, string[]>;
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
  models: ModelCatalog;
}

/** A head choice: a model id, an effort, or null to go back to the default. */
export interface Choice {
  model?: string | null;
  effort?: Effort | null;
}

export interface SendParams extends Choice {
  threadId?: string;
  text: string;
  project?: string;
}

const now = () => new Date().toISOString();
const TOOL_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", omp: "OMP", gjc: "GJC", opencode: "OpenCode" };
/** The tool's product name for people: local.claude-code → Claude Code. */
const toolName = (harness: string) => TOOL_NAMES[harness.replace(/^local\./, "")] ?? harness.replace(/^local\./, "");
const expandHome = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export function createHead(ports: HeadPorts, config: HeadConfig) {
  const { brain, normalizer, summarizer, judge, approvals, delegator, store, events, models } = ports;

  /** Records the blocking cause as gjc-head.alert (one doc per cause) so it survives reloads. */
  async function recordAlert(err: unknown, threadId: string, messageId: string) {
    const found = describeFailure(err);
    if (!found) return;
    const ts = now();
    try {
      await store.saveAlert({ id: found.cause, cause: found.cause, title: found.title, fix: found.fix, detail: String((err as Error)?.message ?? err).slice(0, 500), active: true, ts, updatedAt: ts, threadId, messageId });
    } catch {
      // The message error below still tells the user what to do.
    }
  }

  /** Clears the causes that the same success proves over: a direct reply proves the brain works, a delegation proves brgr works. */
  async function clearAlerts(causes: AlertCause[]) {
    for (const cause of causes) {
      try {
        await store.clearAlert(cause);
      } catch {
        // Clearing is best-effort; a stale alert is fixed on the next success.
      }
    }
  }

  /** Stored settings, with the config's favourites and worker choices always current. */
  async function settings(): Promise<HeadSettings> {
    const saved = await store.getSettings();
    const userFavorites = [...new Set(saved?.userFavorites ?? [])];
    const configFavorites = [...new Set(config.favoriteModels)];
    return {
      id: "default",
      model: saved?.model ?? config.model,
      effort: saved?.effort ?? config.effort,
      favorites: [...new Set([...configFavorites, ...userFavorites, config.model])],
      userFavorites,
      configFavorites,
      efforts: EFFORTS,
      workers: { models: config.workerModels, efforts: WORKER_EFFORTS },
    };
  }

  /** Changes the defaults for new threads (and threads without their own choice). */
  async function setDefaults(p: Choice) {
    checkHeadChoice(p);
    const s = await settings();
    if (p.model) s.model = p.model.trim();
    if (p.effort) s.effort = p.effort;
    await store.saveSettings(s);
    return s;
  }

  /** Stars or unstars a model in the picker's favourites. Config favourites stay: un starring one is a no-op. */
  async function setFavorite(p: { model?: unknown; on?: unknown }) {
    if (typeof p.model !== "string" || !p.model.trim()) throw new Error("모델 이름이 비어 있어요");
    const model = p.model.trim();
    if (isAnthropic(model)) throw new Error(`${model}은 대화 엔진(GJC)에서 쓸 수 없어요. Claude 모델은 Claude Code에서만 써요`);
    const s = await settings();
    const next = new Set(s.userFavorites);
    if (p.on === false) next.delete(model);
    else next.add(model);
    s.userFavorites = [...next];
    s.favorites = [...new Set([...s.configFavorites, ...s.userFavorites, config.model])];
    await store.saveSettings(s);
    return s;
  }

  /** Applies a choice to a thread; null clears it back to the default. */
  function applyChoice(thread: Thread, p: Choice) {
    checkHeadChoice(p);
    if (p.model !== undefined) thread.model = p.model ? p.model.trim() : null;
    if (p.effort !== undefined) thread.effort = p.effort ?? null;
  }

  async function setThread(p: Choice & { threadId: string }) {
    const thread = await store.getThread(p.threadId);
    if (!thread) throw new Error(`unknown thread ${p.threadId}`);
    applyChoice(thread, p);
    await store.saveThread(thread);
    return thread;
  }

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
    checkHeadChoice(p);
    const threshold = config.simpleThreshold;

    const thread = await ensureThread(p);
    if (p.project && expandHome(p.project) !== thread.project) thread.project = expandHome(p.project);
    applyChoice(thread, p);
    const choice = brainChoice(thread, await settings());
    turn.update({ kind: "thread", threadId: thread.id, project: thread.project });

    const user: Message = { id: crypto.randomUUID(), threadId: thread.id, role: "user", text: p.text, ts: now(), traceId: turn.traceId, status: "done" };
    await saveMessage(user);
    const reply: Message = { id: crypto.randomUUID(), threadId: thread.id, role: "assistant", text: "", ts: now(), traceId: turn.traceId, status: "pending" };
    await saveMessage(reply);
    turn.update({ kind: "message", userMessageId: user.id, messageId: reply.id });

    // Start the brain now; if the answer turns out to be direct, its startup is already done.
    let warm = brain.prepare?.({ sessionId: thread.sessionId, ...choice }) ?? null;
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
        const w = warm;
        warm = null;
        await answerDirectly(thread, reply, p.text, turn, w, choice);
      }
      else {
        // Delegated: the warm brain will never get a prompt.
        warm?.cancel();
        warm = null;
        await delegate(thread, reply, turn);
      }
      turn.phase?.("done", "완료", 1);

      reply.status = "done";
      if (reply.route === "direct") await clearAlerts(["gjc-login", "model-refused"]);
      else if (reply.delegation?.state === "delegated") await clearAlerts(["herdr-pane", "dirty-repo", "model-refused"]);
    } catch (err: any) {
      warm?.cancel();
      warm = null;
      reply.status = "error";
      reply.error = friendlyError(err);
      turn.update({ kind: "error", message: reply.error });
      await recordAlert(err, thread.id, reply.id);
    }
    thread.updatedAt = now();
    await store.saveThread(thread);
    await saveMessage(reply);
    return { threadId: thread.id, messageId: reply.id, route: reply.route ?? null, status: reply.status };
  }

  async function answerDirectly(thread: Thread, reply: Message, text: string, turn: Turn, warm: WarmBrain | null, choice: { model: string; effort: Effort }) {
    reply.status = "streaming";
    await saveMessage(reply);
    const onUpdate = (u: BrainUpdate) => {
      if (u.kind === "text_delta") reply.text += u.delta;
      turn.update(u);
    };
    const res = warm
      ? await warm.reply({ prompt: text, signal: turn.signal, onUpdate })
      : await brain.reply({ prompt: text, sessionId: thread.sessionId, signal: turn.signal, onUpdate, ...choice });
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
      summary: `${toolName(s.harness)}에 맡기기: ${s.summaryEn}`,
      risk: s.needsCodeChange ? "medium" : "low",
      payload: {
        harness: s.harness,
        harnesses: config.harnesses,
        workers: { models: config.workerModels, efforts: WORKER_EFFORTS },
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
      reply.text = decision.note === "expired" ? "승인 대기 시간이 지나서 맡기지 않았어요." : "맡기지 않았어요.";
      turn.update({ kind: "delegation", state: "rejected", note: decision.note ?? null });
      return;
    }

    const { harness, amended } = chooseHarness({ suggested: s.harness, harnesses: config.harnesses, amend: decision.amend });
    if (amended) {
      reply.delegation.harness = harness;
      reply.delegation.suggestedHarness = s.harness;
    }
    const worker = checkWorkerChoice({ harness, model: decision.amend?.model, effort: decision.amend?.effort });
    Object.assign(reply.delegation, worker);

    turn.phase?.("delegating", "위임 중");
    const task = await delegator.delegate({
      harness,
      ...worker,
      objective: brief,
      criterion,
      project: thread.project,
      origin: { plugin: "gjc-head", messageId: reply.id, threadId: thread.id },
    });
    reply.taskId = task.taskId;
    reply.delegation.state = "delegated";
    reply.text = `${toolName(harness)}에 맡겼어요. 결과가 나오면 여기서 확인할 수 있어요.`;
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

  return {
    /** Registers kinds and stores the settings once, so screens can read them as an entity. */
    async init() {
      await store.registerKinds();
      await store.saveSettings(await settings());
    },
    send,
    onTaskEvent,
    settings,
    setDefaults,
    setFavorite,
    setThread,
    models: () => models.list(),
  };
}
