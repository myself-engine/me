// pluginConfig.slack, validated. Tokens are never inline: only paths to files holding them.
import type { Policy } from "@me/messenger";
import { PLATFORM } from "./inbound.ts";

export interface SlackConfig {
  /** App-level token (xapp-…) for Socket Mode. */
  appTokenFile: string;
  /** Bot token (xoxb-…) for the Web API. */
  botTokenFile: string;
  policy: Policy;
  approvalsToOwnerDm: boolean;
  drainIntervalMs: number;
  chatTimeoutMs: number;
  /** Minimum gap between edits of a streaming reply (Slack rate-limits chat.update). */
  streamIntervalMs: number;
}

const SLACK_ID = /^[A-Z0-9]{2,}$/;

const strings = (v: unknown, name: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x)) throw new Error(`slack: ${name} must be a list of ids`);
  return v as string[];
};

const file = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v) throw new Error(`slack: ${name} is required`);
  return v;
};

export function parseConfig(raw: Record<string, unknown>): SlackConfig {
  for (const inline of ["token", "appToken", "botToken"]) {
    if (inline in raw) throw new Error(`slack: put tokens in files and set appTokenFile/botTokenFile; inline ${inline} is not accepted`);
  }
  const appTokenFile = file(raw.appTokenFile, "appTokenFile");
  const botTokenFile = file(raw.botTokenFile, "botTokenFile");
  const { ownerId } = raw;
  if (typeof ownerId !== "string" || !/^[UW][A-Z0-9]+$/.test(ownerId)) throw new Error("slack: ownerId (a Slack member id like U0123ABCD) is required");
  const dm = raw.dm ?? "owner-only";
  if (dm !== "owner-only" && dm !== "allowlist" && dm !== "open") throw new Error(`slack: dm must be owner-only, allowlist or open`);
  const allowlist = strings(raw.allowlist, "allowlist");
  // openGroups take channel ids or full origin keys (slack/group/<channelId>).
  const openGroups = strings(raw.openGroups, "openGroups").map((g) => {
    const key = g.includes("/") ? g : `${PLATFORM}/group/${g}`;
    if (!key.startsWith(`${PLATFORM}/group/`) || !SLACK_ID.test(key.slice(`${PLATFORM}/group/`.length))) throw new Error(`slack: openGroups entry ${g} is not a channel id`);
    return key;
  });
  const ms = (v: unknown, fallback: number) => (typeof v === "number" && v >= 0 ? v : fallback);
  return {
    appTokenFile,
    botTokenFile,
    policy: { dm, ownerId, allowlist, openGroups },
    approvalsToOwnerDm: raw.approvalsToOwnerDm === true,
    drainIntervalMs: ms(raw.drainIntervalMs, 5_000),
    chatTimeoutMs: ms(raw.chatTimeoutMs, 2_000_000),
    streamIntervalMs: ms(raw.streamIntervalMs, 1_500),
  };
}
