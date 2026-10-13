// What the Discord window needs from the outside. The app and domain never import discord.js or the SDK.
import type { Origin } from "@me/messenger";
import type { DiscordMessage } from "../domain/inbound.ts";
import type { Row } from "../domain/render.ts";

export interface ComponentPress {
  customId: string;
  userId: string;
  /** Chosen values for a select menu; empty for a button. */
  values: string[];
}

/** Sent back only to the presser (ephemeral). */
export interface ComponentReply {
  text: string;
  file?: { name: string; content: string };
}

export interface DiscordGateway {
  /** The bot's own user id once connected. */
  readonly botUserId: string;
  onMessage(handler: (m: DiscordMessage) => void): void;
  onComponent(handler: (p: ComponentPress) => Promise<ComponentReply>): void;
  /**
   * Resolves with the new message id. Throws messenger's SendRejected when Discord definitely refused;
   * any other error means the outcome is unknown.
   */
  send(origin: Origin, msg: { text: string; replyTo?: string | null; rows?: Row[] }): Promise<string>;
  edit(origin: Origin, messageId: string, msg: { text: string; rows: Row[] }): Promise<void>;
  react(origin: Origin, messageId: string, emoji: string): Promise<void>;
  typing(origin: Origin): Promise<void>;
}

export interface ChatResult {
  threadId: string;
  messageId: string;
  route: string | null;
  status: string;
}

export interface HeadMessage {
  id: string;
  threadId: string;
  text: string;
  status: string;
  error?: string;
}

export interface PendingApproval {
  approvalId: string;
  requester?: string;
  summary?: string;
  risk?: string;
  payload?: Record<string, unknown> | null;
}

export interface Task {
  taskId: string;
  harness: string;
  state: string;
  resultText: string | null;
  origin: Record<string, unknown> | null;
  question?: { id: string; text: string; at: string; kind: "message" | "menu" | "screen"; options?: string[] } | null;
}

/** Entity discord.conversation, keyed by head thread id: which Discord conversation a thread belongs to. */
export interface Conversation {
  threadId: string;
  originKey: string;
  epoch: number;
  createdAt: string;
}

export interface Kernel {
  registerKinds(): Promise<void>;
  /** gjc-head chat.send as a stream; resolves when the head returns. */
  chatSend(p: { threadId: string; text: string }, onUpdate: (u: any) => void): Promise<ChatResult>;
  headMessage(id: string): Promise<HeadMessage | null>;
  listApprovals(): Promise<PendingApproval[]>;
  decideApproval(approvalId: string, d: { decision: "approve" | "reject"; note?: string; amend?: Record<string, unknown> }): Promise<void>;
  task(taskId: string): Promise<Task | null>;
  sealedTasks(): Promise<Task[]>;
  awaitingTasks(): Promise<Task[]>;
  answerTask(taskId: string, answer: { text?: string; choice?: string; questionId: string }): Promise<void>;
  acceptTask(taskId: string, reason: string): Promise<void>;
  rejectTask(taskId: string, reason: string): Promise<void>;
  taskDiff(taskId: string): Promise<{ diff: string; error: string | null }>;
  saveConversation(c: Conversation): Promise<void>;
  conversation(threadId: string): Promise<Conversation | null>;
}

/** Cards already posted (approval or task), so restarts and repeated events do not post twice. */
export interface PostedCard {
  kind: "approval" | "task" | "task-question";
  ref: string;
  originKey: string;
  messageId: string;
  data: Record<string, unknown>;
}

export interface CardStore {
  get(kind: PostedCard["kind"], ref: string): PostedCard | null;
  put(card: PostedCard): void;
}
