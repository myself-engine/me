// Discord message → lib/messenger InboundMessage. Pure: the adapter hands over plain data.
import type { InboundMessage, Origin } from "@me/messenger";

export const PLATFORM = "discord";

/** What the gateway adapter reports for one Discord message, with no discord.js types. */
export interface DiscordMessage {
  place: "dm" | "guild" | "thread";
  channelId: string;
  authorId: string;
  messageId: string;
  content: string;
  mentionsBot: boolean;
  repliesToBot: boolean;
}

/**
 * A DM is keyed by the user, not the DM channel: the owner's DM is then simply
 * discord/dm/<ownerId>, and the adapter opens the channel when it sends.
 */
export function originOf(m: DiscordMessage): Origin {
  if (m.place === "dm") return { platform: PLATFORM, kind: "dm", conversationId: m.authorId };
  return { platform: PLATFORM, kind: m.place === "thread" ? "thread" : "group", conversationId: m.channelId };
}

export const ownerDm = (ownerId: string): Origin => ({ platform: PLATFORM, kind: "dm", conversationId: ownerId });

/** Drops mentions of the bot so "@me /new" reads as "/new". */
export function stripBotMention(text: string, botUserId: string): string {
  if (!botUserId) return text.trim();
  return text.replaceAll(`<@${botUserId}>`, "").replaceAll(`<@!${botUserId}>`, "").trim();
}

export function toInbound(m: DiscordMessage, botUserId: string): InboundMessage {
  return {
    origin: originOf(m),
    authorId: m.authorId,
    messageId: m.messageId,
    text: stripBotMention(m.content, botUserId),
    mentionsBot: m.mentionsBot,
    repliesToBot: m.repliesToBot,
  };
}

export const isNewCommand = (text: string) => text.trim() === "/new";
