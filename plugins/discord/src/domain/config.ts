// pluginConfig.discord, validated. The bot token is never inline: only a path to a file holding it.
import type { Policy } from "@me/messenger";
import { PLATFORM } from "./inbound.ts";

export interface DiscordConfig {
  tokenFile: string;
  policy: Policy;
  approvalsToOwnerDm: boolean;
  drainIntervalMs: number;
  chatTimeoutMs: number;
  /** Default channel for notify (schedule delivery). Unset means notify refuses. */
  notifyChannel?: string;
}

const strings = (v: unknown, name: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x)) throw new Error(`discord: ${name} must be a list of ids`);
  return v as string[];
};

export function parseConfig(raw: Record<string, unknown>): DiscordConfig {
  if ("token" in raw) throw new Error("discord: put the bot token in a file and set tokenFile; inline token is not accepted");
  const { tokenFile, ownerId } = raw;
  if (typeof tokenFile !== "string" || !tokenFile) throw new Error("discord: tokenFile is required");
  if (typeof ownerId !== "string" || !/^\d+$/.test(ownerId)) throw new Error("discord: ownerId (a Discord user id) is required");
  const dm = raw.dm ?? "owner-only";
  if (dm !== "owner-only" && dm !== "allowlist" && dm !== "open") throw new Error(`discord: dm must be owner-only, allowlist or open`);
  // openGroups take channel ids or full origin keys (discord/group/<channelId>).
  const openGroups = strings(raw.openGroups, "openGroups").map((g) => (g.includes("/") ? g : `${PLATFORM}/group/${g}`));
  const notifyChannel = raw.notifyChannel;
  if (notifyChannel !== undefined && (typeof notifyChannel !== "string" || !/^\d+$/.test(notifyChannel))) {
    throw new Error("discord: notifyChannel must be a channel id");
  }
  return {
    tokenFile,
    policy: { dm, ownerId, allowlist: strings(raw.allowlist, "allowlist"), openGroups },
    approvalsToOwnerDm: raw.approvalsToOwnerDm === true,
    drainIntervalMs: typeof raw.drainIntervalMs === "number" ? raw.drainIntervalMs : 5_000,
    chatTimeoutMs: typeof raw.chatTimeoutMs === "number" ? raw.chatTimeoutMs : 2_000_000,
    ...(typeof raw.notifyChannel === "string" && raw.notifyChannel ? { notifyChannel: raw.notifyChannel } : {}),
  };
}
