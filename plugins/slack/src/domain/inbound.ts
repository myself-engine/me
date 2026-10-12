// Slack message → lib/messenger InboundMessage. Pure: the adapter hands over plain data.
import type { InboundMessage, Origin } from "@me/messenger";

export const PLATFORM = "slack";

/** What the gateway adapter reports for one Slack message event, with no SDK types. */
export interface SlackMessage {
  /** `dm` is a 1:1 IM with the bot; channels, private channels and group DMs are `channel`. */
  place: "dm" | "channel";
  channelId: string;
  /** The thread root's ts when the message was posted inside a thread. */
  threadTs: string | null;
  ts: string;
  userId: string;
  text: string;
}

/**
 * A DM is keyed by the user (slack/dm/<userId>), like Discord; the adapter opens the IM when it sends.
 * In channels every conversation is a Slack thread (slack/thread/<channelId>:<rootTs>): a top-level
 * message starts one rooted at itself, and replies inside the thread continue it.
 */
export function originOf(m: SlackMessage): Origin {
  if (m.place === "dm") return { platform: PLATFORM, kind: "dm", conversationId: m.userId };
  return { platform: PLATFORM, kind: "thread", conversationId: `${m.channelId}:${m.threadTs ?? m.ts}` };
}

/** Who may speak and whether a channel is open is decided per channel, not per thread. */
export function channelOrigin(m: SlackMessage): Origin {
  if (m.place === "dm") return originOf(m);
  return { platform: PLATFORM, kind: "group", conversationId: m.channelId };
}

/** Splits a thread origin's conversation id back into the channel and the root ts. */
export function threadOf(conversationId: string): { channel: string; threadTs: string } {
  const at = conversationId.indexOf(":");
  if (at < 1 || at === conversationId.length - 1) throw new Error(`invalid slack thread id: ${conversationId}`);
  return { channel: conversationId.slice(0, at), threadTs: conversationId.slice(at + 1) };
}

export const ownerDm = (ownerId: string): Origin => ({ platform: PLATFORM, kind: "dm", conversationId: ownerId });

/** Slack writes mentions as <@U123> or <@U123|name>. */
const mentionOf = (botUserId: string) => new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, "g");

export const mentionsBot = (text: string, botUserId: string) => !!botUserId && mentionOf(botUserId).test(text);

/** Drops mentions of the bot so "@me /new" reads as "/new". */
export function stripBotMention(text: string, botUserId: string): string {
  if (!botUserId) return text.trim();
  return text.replace(mentionOf(botUserId), "").trim();
}

/**
 * The head should read what the user typed: Slack's <url|label>, <#C1|name> and <@U1> markup becomes
 * plain text, and &, < and > lose their escaping.
 */
export function plainText(text: string): string {
  return text
    .replace(/<((?:https?|mailto):[^|>]+)(?:\|([^>]+))?>/g, (_, url: string, label?: string) => (label && label !== url ? `${label} (${url})` : url))
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<@([A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, name?: string) => `@${name || id}`)
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** `inBotThread`: the message sits in a thread the bot already talks in (Slack's "reply to the bot"). */
export function toInbound(m: SlackMessage, botUserId: string, inBotThread: boolean): InboundMessage {
  return {
    origin: originOf(m),
    authorId: m.userId,
    messageId: m.ts,
    text: plainText(stripBotMention(m.text, botUserId)),
    mentionsBot: mentionsBot(m.text, botUserId),
    repliesToBot: m.place === "channel" && m.threadTs !== null && inBotThread,
  };
}

/**
 * Slack's composer treats a leading "/" as a slash command, so in a DM the user types " /new"
 * (leading space); in a channel "@me /new" works as is. Both trim to "/new".
 */
export const isNewCommand = (text: string) => text.trim() === "/new";
