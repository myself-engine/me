// The head's use case: judges each message and either answers briefly itself or delegates.
// slang → (fast path | summarize → jev) → direct reply or approval → brgr.
import { homedir } from "node:os";
import { join } from "node:path";
import { chooseHarness, decideRoute, fastPathJudgement, isFastPath } from "../domain/routing.ts";
import { describeFailure, friendlyError, type AlertCause } from "../domain/alerts.ts";
import { fallbackReason } from "../domain/fallback.ts";
import { withModelFallback } from "@me/gjc";
import { accessOf, brainChoice, checkAccess, checkCooldownSec, checkFallbackModels, checkHeadChoice, checkWorkerChoice, DEFAULT_ACCESS, DEFAULT_COOLDOWN_SEC, EFFORTS, isAccessMode, isAnthropic, WORKER_EFFORTS } from "../domain/settings.ts";
import type { AccessMode, DelegationState, Effort, HeadSettings, Message, Thread } from "../domain/types.ts";
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
  /** Ordered fallback models for direct replies; empty means fail as today. */
  fallbackModels?: string[];
  /** Seconds a failed model stays out; default 600. */
  cooldownSec?: number;
  /** Clock for cooldowns; defaults to Date.now. Tests inject a manual clock. */
  clock?: () => number;
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
  /** Access mode change; "full" needs `confirm: true`. Null clears a thread back to the default. */
  access?: AccessMode | null;
  confirm?: boolean;
  /** Fallback models for direct replies; null resets to the config default. Thread choices ignore it. */
  fallbackModels?: string[] | null;
  /** Fallback cooldown in seconds; null resets to the config default. Thread choices ignore it. */
  cooldownSec?: number | null;
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
/** Read-only conversations never delegate: the delegate judgement becomes this direct reply. */
const READ_ONLY_REPLY = "이 대화는 읽기 전용이라 위임하지 않았어요. 코드를 바꾸려면 입력창 옆의 모드에서 '프로젝트 쓰기' 또는 '전부 알아서'로 바꾸고 다시 말해 주세요.";

export function createHead(ports: HeadPorts, config: HeadConfig) {
  const { brain, normalizer, summarizer, judge, approvals, delegator, store, events, models } = ports;
  /** Models that failed eligibly stay out until this time (ms); shared by every turn. */
  const cooldowns = new Map<string, number>();
  const clock = config.clock ?? Date.now;

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
      access: isAccessMode(saved?.access) ? saved.access : DEFAULT_ACCESS,
      fallbackModels: saved?.fallbackModels ?? config.fallbackModels ?? [],
      cooldownSec: saved?.cooldownSec ?? config.cooldownSec ?? DEFAULT_COOLDOWN_SEC,
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
    const access = checkAccess(p);
    const fb = checkFallbackModels(p);
    const cd = checkCooldownSec(p);
    const s = await settings();
    if (p.model) s.model = p.model.trim();
    if (p.effort) s.effort = p.effort;
    if (access.access) s.access = access.access;
    if (p.fallbackModels !== undefined) s.fallbackModels = fb.fallbackModels ?? config.fallbackModels ?? [];
    if (p.cooldownSec !== undefined) s.cooldownSec = cd.cooldownSec ?? config.cooldownSec ?? DEFAULT_COOLDOWN_SEC;
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

  /** Applies an access change to a thread; null clears it back to the default. */
  function applyAccess(thread: Thread, p: Choice) {
    const access = checkAccess(p);
    if (p.access !== undefined) thread.access = access.access ?? null;
  }

  async function setThread(p: Choice & { threadId: string }) {
    const thread = await store.getThread(p.threadId);
    if (!thread) throw new Error(`unknown thread ${p.threadId}`);
    applyChoice(thread, p);
    applyAccess(thread, p);
    await store.saveThread(thread);
    return thread;
  }

  async function saveMessage(m: Message) {
    await store.saveMessage(m);
    await events.messageChanged(m);
  }

  async function ensureThread(p: SendParams, defaultAccess: AccessMode): Promise<{ thread: Thread; created: boolean }> {
    if (p.threadId) {
      const t = await store.getThread(p.threadId);
      if (t) return { thread: t, created: false };
    }
    const t: Thread = {
      id: p.threadId ?? crypto.randomUUID(),
      title: p.text.slice(0, 40),
      project: expandHome(p.project ?? config.defaultProject),
      sessionId: null,
      access: p.access ?? defaultAccess,
      createdAt: now(),
      updatedAt: now(),
    };
    await store.saveThread(t);
    return { thread: t, created: true };
  }

  async function send(p: SendParams, turn: Turn) {
    if (!p.text?.trim()) throw new Error("text is required");
    checkHeadChoice(p);
    checkAccess(p);
    const threshold = config.simpleThreshold;
    const defaults = await settings();
    // Refuse a bad fallback config before anything runs, like other head choices.
    const fbModels = checkFallbackModels({ fallbackModels: defaults.fallbackModels }).fallbackModels ?? [];
    const fbCooldownSec = checkCooldownSec({ cooldownSec: defaults.cooldownSec }).cooldownSec ?? DEFAULT_COOLDOWN_SEC;

    const { thread, created } = await ensureThread(p, defaults.access);
    // A thread keeps its mode: chat.send's access only applies to a new thread.
    if (!created && p.access !== undefined) turn.update({ kind: "access", mode: accessOf(thread, defaults), kept: true });
    if (p.project && expandHome(p.project) !== thread.project) thread.project = expandHome(p.project);
    applyChoice(thread, p);
    const choice = brainChoice(thread, defaults);
    const access = accessOf(thread, defaults);
    turn.update({ kind: "thread", threadId: thread.id, project: thread.project, access });

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
      // Read-only conversations never delegate: the delegate verdict becomes a direct reply instead.
      const readOnly = reply.route === "delegate" && access === "read";
      if (readOnly) {
        warm?.cancel();
        warm = null;
        reply.route = "direct";
        reply.text = READ_ONLY_REPLY;
        turn.update({ kind: "access", mode: access, delegated: false });
      } else if (reply.route === "delegate") {
        turn.phase?.("summarizing", "지시서 작성 중");
        const summary = await summarizer.summarize({ original: p.text, normalized: understood.normalized, harnesses: config.harnesses, project: thread.project });
        reply.summary = summary;
        turn.update({ kind: "summary", ...summary });
      }
      await saveMessage(reply);

      if (reply.route === "direct" && !readOnly) {
        turn.phase?.("answering", "답변 작성 중");
        const w = warm;
        warm = null;
        const usedFallback = await answerDirectly(thread, reply, p.text, turn, w, choice, { models: fbModels, cooldownSec: fbCooldownSec });
        if (!usedFallback) await clearAlerts(["gjc-login", "model-refused", "model-unavailable"]);
      }
      else if (!readOnly) {
        // Delegated: the warm brain will never get a prompt.
        warm?.cancel();
        warm = null;
        await delegate(thread, reply, turn, access);
      }
      turn.phase?.("done", "완료", 1);

      reply.status = "done";
      if (reply.route === "direct" && !readOnly) {
        // Direct-without-fallback already cleared above; a fallback keeps the
        // primary's alert so the user still fixes it.
      } else if (reply.route === "direct") await clearAlerts(["gjc-login", "model-refused", "model-unavailable"]);
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

  /**
   * Answers with the thread's model, falling back to each configured fallback
   * model in order when the failure is eligible (quota, expired auth, model
   * gone, provider 5xx/network). Returns true when a fallback answered.
   * The summarize/judge calls keep today's behavior: jev owns its own
   * OpenRouter→GJC chain and summarize's model belongs to that plugin.
   */
  async function answerDirectly(
    thread: Thread,
    reply: Message,
    text: string,
    turn: Turn,
    warm: WarmBrain | null,
    choice: { model: string; effort: Effort },
    fb: { models: string[]; cooldownSec: number },
  ): Promise<boolean> {
    reply.status = "streaming";
    await saveMessage(reply);
    const onUpdate = (u: BrainUpdate) => {
      if (u.kind === "text_delta") reply.text += u.delta;
      turn.update(u);
    };
    let warmUsed = false;
    try {
      const res = await withModelFallback({
        primary: choice.model,
        fallbackModels: fb.models,
        cooldownSec: fb.cooldownSec,
        cooldowns,
        now: clock,
        isEligible: fallbackReason,
        run: async (model) => {
          if (model === choice.model && warm) {
            warmUsed = true;
            const w = warm;
            warm = null;
            return w.reply({ prompt: text, signal: turn.signal, onUpdate });
          }
          // Drop partial deltas from the failed attempt; the winner's full text replaces them below.
          reply.text = "";
          return brain.reply({ prompt: text, sessionId: thread.sessionId, signal: turn.signal, onUpdate, model, effort: choice.effort });
        },
        onFallback: (f) => turn.update({ kind: "fallback", ...f }),
      });
      if (res.value.violation) {
        await events.guardViolation({ messageId: reply.id, toolName: res.value.violation.toolName });
        throw new Error(`head tried to use tool ${res.value.violation.toolName}; run aborted`);
      }
      reply.text = res.value.text || reply.text;
      if (res.value.sessionId) thread.sessionId = res.value.sessionId;
      if (res.fallback) {
        reply.fallback = res.fallback;
        // The primary is still broken: keep its alert so the user fixes it.
        await recordAlert(res.primaryError, thread.id, reply.id);
        return true;
      }
      return false;
    } finally {
      if (!warmUsed) warm?.cancel();
    }
  }

  async function delegate(thread: Thread, reply: Message, turn: Turn, access: AccessMode) {
    const s = reply.summary!;
    const brief = s.brief || s.summaryEn;
    const criterion = s.criterion?.trim() || undefined;
    reply.delegation = { state: "awaiting-approval", harness: s.harness, brief, ...(criterion ? { criterion } : {}) };
    await saveMessage(reply);

    // Project and full modes start at once without a kernel approval; the record keeps how it was approved.
    if (access === "project" || access === "full") {
      const approvedBy = `mode:${access}` as const;
      reply.delegation.approvedBy = approvedBy;
      turn.phase?.("delegating", "위임 중");
      const task = await delegator.delegate({
        harness: s.harness,
        objective: brief,
        criterion,
        project: thread.project,
        origin: { plugin: "gjc-head", messageId: reply.id, threadId: thread.id },
        ...(access === "full" ? { autoApply: true } : {}),
      });
      reply.taskId = task.taskId;
      reply.delegation.state = "delegated";
      reply.text = `${toolName(s.harness)}에 맡겼어요. 결과가 나오면 여기서 확인할 수 있어요.`;
      turn.update({ kind: "delegation", state: "delegated", taskId: task.taskId, harness: s.harness, approvedBy });
      return;
    }

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
    reply.delegation.approvedBy = "user";

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
