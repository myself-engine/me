// Reliability core shared by messenger plugins (Discord, Slack, Telegram).
// Implements the checklist from DECISIONS §15: ledgered delivery, per-conversation sessions,
// serialized handling per conversation, and inbound policy. No platform SDK is imported here.
import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Origins: every conversation is platform/kind/conversationId. A DM is never a channel.
// ---------------------------------------------------------------------------

export type ConversationKind = "dm" | "group" | "thread";

export interface Origin {
  platform: string;
  kind: ConversationKind;
  conversationId: string;
}

const ORIGIN_PART = /^[A-Za-z0-9._:-]+$/;

export function originKey(o: Origin): string {
  for (const part of [o.platform, o.kind, o.conversationId]) {
    if (!ORIGIN_PART.test(part)) throw new Error(`invalid origin part: ${JSON.stringify(part)}`);
  }
  return `${o.platform}/${o.kind}/${o.conversationId}`;
}

export function parseOriginKey(key: string): Origin {
  const [platform, kind, conversationId, ...rest] = key.split("/");
  if (!platform || !conversationId || rest.length || !["dm", "group", "thread"].includes(kind ?? "")) {
    throw new Error(`invalid origin key: ${key}`);
  }
  return { platform, kind: kind as ConversationKind, conversationId };
}

// ---------------------------------------------------------------------------
// Inbound policy: who may talk to the bot, and when a group message counts as addressed.
// ---------------------------------------------------------------------------

export interface InboundMessage {
  origin: Origin;
  authorId: string;
  /** Platform message id; used to ignore redeliveries. */
  messageId: string;
  text: string;
  mentionsBot: boolean;
  /** True when the message replies to one of the bot's own messages. */
  repliesToBot: boolean;
}

export interface Policy {
  dm: "owner-only" | "allowlist" | "open";
  ownerId: string;
  allowlist?: string[];
  /** Group conversations where every message is addressed (no mention needed). */
  openGroups?: string[];
}

export type Admission = { admit: true } | { admit: false; reason: "not-allowed" | "not-addressed" | "own-message" };

export function admit(m: InboundMessage, p: Policy, botUserId: string): Admission {
  if (m.authorId === botUserId) return { admit: false, reason: "own-message" };
  const allowed = p.dm === "open" || m.authorId === p.ownerId || (p.dm === "allowlist" && (p.allowlist ?? []).includes(m.authorId));
  if (m.origin.kind === "dm") return allowed ? { admit: true } : { admit: false, reason: "not-allowed" };
  // Groups: still only people the policy allows, and only when addressed.
  if (!allowed) return { admit: false, reason: "not-allowed" };
  const open = (p.openGroups ?? []).includes(originKey(m.origin));
  return open || m.mentionsBot || m.repliesToBot ? { admit: true } : { admit: false, reason: "not-addressed" };
}

// ---------------------------------------------------------------------------
// Ledger: inbound dedupe, conversation epochs, and outbound delivery records.
// A reply is recorded before it is sent; a send whose outcome is unknown after a crash
// is reissued and visibly labeled as a possible duplicate.
// ---------------------------------------------------------------------------

export type DeliveryState = "pending" | "sending" | "sent" | "failed";

export interface Delivery {
  id: string;
  originKey: string;
  epoch: number;
  replyTo: string | null;
  text: string;
  state: DeliveryState;
  attempts: number;
  platformMessageId: string | null;
  duplicateOf: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export const DUPLICATE_LABEL = "(중복일 수 있음 — 재시작 후 다시 보냄)";

export class Ledger {
  readonly db: Database;

  constructor(path: string, private now: () => string = () => new Date().toISOString()) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inbound (origin TEXT NOT NULL, message_id TEXT NOT NULL, received_at TEXT NOT NULL, PRIMARY KEY (origin, message_id));
      CREATE TABLE IF NOT EXISTS conversations (origin TEXT PRIMARY KEY, epoch INTEGER NOT NULL, session_id TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY, origin TEXT NOT NULL, epoch INTEGER NOT NULL, reply_to TEXT, text TEXT NOT NULL,
        state TEXT NOT NULL, attempts INTEGER NOT NULL, platform_message_id TEXT, duplicate_of TEXT, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS deliveries_state ON deliveries(state);
    `);
  }

  /** Records an inbound message; false means it was already seen (platform redelivery). */
  recordInbound(m: InboundMessage): boolean {
    const r = this.db
      .prepare("INSERT OR IGNORE INTO inbound (origin, message_id, received_at) VALUES (?, ?, ?)")
      .run(originKey(m.origin), m.messageId, this.now());
    return r.changes === 1;
  }

  /** The conversation's current epoch and head session (one session per conversation). */
  conversation(origin: Origin): { epoch: number; sessionId: string | null } {
    const key = originKey(origin);
    const row = this.db.prepare("SELECT epoch, session_id FROM conversations WHERE origin = ?").get(key) as any;
    if (row) return { epoch: row.epoch, sessionId: row.session_id };
    this.db.prepare("INSERT INTO conversations (origin, epoch, session_id, updated_at) VALUES (?, 0, NULL, ?)").run(key, this.now());
    return { epoch: 0, sessionId: null };
  }

  /** True once the conversation has been seen (created by conversation(), setSession() or newEpoch()). */
  hasConversation(origin: Origin): boolean {
    return this.db.prepare("SELECT 1 FROM conversations WHERE origin = ?").get(originKey(origin)) !== null;
  }

  setSession(origin: Origin, sessionId: string) {
    this.conversation(origin);
    this.db.prepare("UPDATE conversations SET session_id = ?, updated_at = ? WHERE origin = ?").run(sessionId, this.now(), originKey(origin));
  }

  /** `/new`: starts a fresh session for this conversation only. Pending replies of the old epoch are dropped. */
  newEpoch(origin: Origin): number {
    const { epoch } = this.conversation(origin);
    const next = epoch + 1;
    const key = originKey(origin);
    this.db.prepare("UPDATE conversations SET epoch = ?, session_id = NULL, updated_at = ? WHERE origin = ?").run(next, this.now(), key);
    this.db
      .prepare("UPDATE deliveries SET state = 'failed', error = 'superseded by /new', updated_at = ? WHERE origin = ? AND epoch < ? AND state = 'pending'")
      .run(this.now(), key, next);
    return next;
  }

  /** Step 1: record the reply before any network call. */
  enqueue(origin: Origin, text: string, replyTo: string | null = null): Delivery {
    const { epoch } = this.conversation(origin);
    const id = crypto.randomUUID();
    const t = this.now();
    this.db
      .prepare("INSERT INTO deliveries VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?, ?)")
      .run(id, originKey(origin), epoch, replyTo, text, t, t);
    return this.get(id)!;
  }

  /** Step 2: mark the attempt; if the process dies now, the outcome is unknown. */
  markSending(id: string) {
    this.db.prepare("UPDATE deliveries SET state = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(this.now(), id);
  }

  /** Step 3a: the platform confirmed the send. */
  markSent(id: string, platformMessageId: string) {
    this.db.prepare("UPDATE deliveries SET state = 'sent', platform_message_id = ?, error = NULL, updated_at = ? WHERE id = ?").run(platformMessageId, this.now(), id);
  }

  /** Step 3b: the platform definitely rejected it; it may be retried as pending. */
  markFailed(id: string, error: string, retry: boolean) {
    this.db.prepare("UPDATE deliveries SET state = ?, error = ?, updated_at = ? WHERE id = ?").run(retry ? "pending" : "failed", error, this.now(), id);
  }

  /**
   * After a restart: deliveries left in `sending` have an unknown outcome. Each becomes a new
   * pending delivery whose text carries the duplicate label, and the original is closed.
   */
  recoverUncertain(): Delivery[] {
    const stuck = this.db.prepare("SELECT id FROM deliveries WHERE state = 'sending'").all() as { id: string }[];
    const reissued: Delivery[] = [];
    for (const { id } of stuck) {
      const d = this.get(id)!;
      const t = this.now();
      this.db.prepare("UPDATE deliveries SET state = 'failed', error = 'outcome unknown after restart', updated_at = ? WHERE id = ?").run(t, id);
      const copyId = crypto.randomUUID();
      this.db
        .prepare("INSERT INTO deliveries VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, ?, NULL, ?, ?)")
        .run(copyId, d.originKey, d.epoch, d.replyTo, `${d.text}\n\n${DUPLICATE_LABEL}`, id, t, t);
      reissued.push(this.get(copyId)!);
    }
    return reissued;
  }

  /** Pending deliveries of the current epoch, oldest first, for the sender loop. */
  pending(): Delivery[] {
    return (
      this.db
        .prepare(
          `SELECT d.* FROM deliveries d JOIN conversations c ON c.origin = d.origin
           WHERE d.state = 'pending' AND d.epoch = c.epoch ORDER BY d.created_at, d.rowid`,
        )
        .all() as any[]
    ).map(rowToDelivery);
  }

  get(id: string): Delivery | null {
    const r = this.db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id) as any;
    return r ? rowToDelivery(r) : null;
  }

  close() {
    this.db.close();
  }
}

function rowToDelivery(r: any): Delivery {
  return {
    id: r.id,
    originKey: r.origin,
    epoch: r.epoch,
    replyTo: r.reply_to,
    text: r.text,
    state: r.state,
    attempts: r.attempts,
    platformMessageId: r.platform_message_id,
    duplicateOf: r.duplicate_of,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Serialization: messages racing the same conversation are handled one at a time, in order.
// Different conversations run concurrently.
// ---------------------------------------------------------------------------

export class ConversationQueue {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(origin: Origin, task: () => Promise<T>): Promise<T> {
    const key = originKey(origin);
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(task);
    this.tails.set(key, next);
    // The cleanup chain must not surface the task's rejection a second time.
    next
      .finally(() => {
        if (this.tails.get(key) === next) this.tails.delete(key);
      })
      .catch(() => {});
    return next;
  }

  /** Number of conversations with work in flight. */
  get active(): number {
    return this.tails.size;
  }
}

// ---------------------------------------------------------------------------
// Sender: drains the ledger through a platform adapter.
// ---------------------------------------------------------------------------

export interface PlatformSender {
  /** Resolves with the platform message id. Throw SendRejected when the platform definitely refused. */
  send(origin: Origin, text: string, replyTo: string | null): Promise<string>;
}

export class SendRejected extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** Sends every pending delivery once. Unknown errors leave the delivery `sending` (outcome unknown). */
export async function drain(ledger: Ledger, sender: PlatformSender, maxAttempts = 3): Promise<{ sent: number; failed: number; uncertain: number }> {
  const out = { sent: 0, failed: 0, uncertain: 0 };
  for (const d of ledger.pending()) {
    ledger.markSending(d.id);
    try {
      const pid = await sender.send(parseOriginKey(d.originKey), d.text, d.replyTo);
      ledger.markSent(d.id, pid);
      out.sent++;
    } catch (err) {
      if (err instanceof SendRejected) {
        const retry = err.retryable && d.attempts + 1 < maxAttempts;
        ledger.markFailed(d.id, err.message, retry);
        if (!retry) out.failed++;
      } else {
        // Network error mid-send: we cannot know whether it arrived. Leave it `sending`;
        // recoverUncertain() will reissue it with the duplicate label.
        out.uncertain++;
      }
    }
  }
  return out;
}
