// SlackGateway over @slack/socket-mode (events in) and @slack/web-api (calls out).
// Every Slack specific (envelopes, acks, Block Kit, API errors, IM channels) stays here.
import { SocketModeClient } from "@slack/socket-mode";
import { ErrorCode, LogLevel, WebClient, type KnownBlock, type Logger } from "@slack/web-api";
import { SendRejected, type Origin } from "@me/messenger";
import { toBlocks } from "../domain/blocks.ts";
import { threadOf, type SlackMessage } from "../domain/inbound.ts";
import type { Row } from "../domain/render.ts";
import type { ComponentPress, ComponentReply, OutboundMessage, SlackGateway } from "../ports/index.ts";

/** The SDK's default logger writes info to stdout, which carries only protocol frames here. */
function stderrLogger(log: (...a: unknown[]) => void): Logger {
  let level = LogLevel.WARN;
  const rank = { [LogLevel.ERROR]: 0, [LogLevel.WARN]: 1, [LogLevel.INFO]: 2, [LogLevel.DEBUG]: 3 };
  const at = (l: LogLevel) => (...msg: unknown[]) => void (rank[l] <= rank[level] && log("[slack]", l, ...msg));
  return {
    debug: at(LogLevel.DEBUG),
    info: at(LogLevel.INFO),
    warn: at(LogLevel.WARN),
    error: at(LogLevel.ERROR),
    setLevel: (l) => void (level = l),
    getLevel: () => level,
    setName: () => {},
  };
}

/**
 * Slack answered: a platform error (ok:false) or a 4xx definitely refused the call; rate limits may be
 * retried. Request errors and 5xx leave the outcome unknown and are rethrown unchanged.
 */
export function classify(err: unknown): unknown {
  if (err instanceof SendRejected) return err;
  const e = err as { code?: string; data?: { error?: string }; statusCode?: number; retryAfter?: number };
  if (e?.code === ErrorCode.RateLimitedError) return new SendRejected(`ratelimited (retry after ${e.retryAfter}s)`, true);
  if (e?.code === ErrorCode.PlatformError) return new SendRejected(e.data?.error ?? "platform error", e.data?.error === "ratelimited");
  if (e?.code === ErrorCode.HTTPError && e.statusCode! >= 400 && e.statusCode! < 500) return new SendRejected(`http ${e.statusCode}`, e.statusCode === 429);
  return err;
}

export interface SlackSdkGateway extends SlackGateway {
  /** Checks the bot token (auth.test) and opens the Socket Mode connection. */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export function slackSdkGateway(tokens: { appToken: string; botToken: string }, log: (...a: unknown[]) => void = console.error): SlackSdkGateway {
  const logger = stderrLogger(log);
  // No SDK retries: a resend after a network error must go through the ledger (outcome unknown → duplicate label).
  const web = new WebClient(tokens.botToken, { logger, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 30_000 });
  const socket = new SocketModeClient({ appToken: tokens.appToken, logger, autoReconnectEnabled: true });
  const messageHandlers: ((m: SlackMessage) => void)[] = [];
  let componentHandler: ((p: ComponentPress) => Promise<ComponentReply>) | null = null;
  let botUserId = "";
  /** IM channel per user, learned from inbound DMs or conversations.open. */
  const ims = new Map<string, string>();

  // One listener for every envelope: each is acked first, whatever its type, because Slack redelivers
  // anything not acked within 3 seconds and eventually stops sending events. Unhandled types are ignored.
  socket.on("slack_event", async ({ ack, type, body }: { ack: () => Promise<void>; type: string; body: any }) => {
    await ack().catch((err: unknown) => log("[slack] ack failed:", (err as Error)?.message ?? err));
    try {
      if (type === "events_api" && body?.event?.type === "message") onMessageEvent(body.event);
      else if (type === "interactive" && body?.type === "block_actions") await onBlockActions(body);
    } catch (err) {
      log("[slack] event failed:", (err as Error)?.message ?? err);
    }
  });

  function onMessageEvent(event: any) {
    // Edits, deletions, joins and bot posts (including our own chat.update) carry a subtype or bot_id.
    if ((event.subtype && event.subtype !== "file_share" && event.subtype !== "thread_broadcast") || event.bot_id || !event.user) return;
    const place = event.channel_type === "im" ? "dm" : "channel";
    if (place === "dm") ims.set(event.user, event.channel);
    const msg: SlackMessage = {
      place,
      channelId: event.channel,
      threadTs: event.thread_ts && event.thread_ts !== event.ts ? event.thread_ts : null,
      ts: event.ts,
      userId: event.user,
      text: typeof event.text === "string" ? event.text : "",
    };
    for (const h of messageHandlers) h(msg);
  }

  async function onBlockActions(body: any) {
    const action = body.actions?.[0];
    const channel: string | undefined = body.channel?.id ?? body.container?.channel_id;
    const user: string | undefined = body.user?.id;
    if (!componentHandler || !action?.action_id || !channel || !user) return;
    const threadTs: string | undefined = body.container?.thread_ts ?? body.message?.thread_ts;
    const r = await componentHandler({ customId: action.action_id, userId: user, values: action.selected_option?.value ? [action.selected_option.value] : [] });
    if (r.file) {
      await web.files.uploadV2({ channel_id: channel, filename: r.file.name, title: r.file.name, content: r.file.content, ...(threadTs ? { thread_ts: threadTs } : {}) } as any);
    }
    await web.chat.postEphemeral({ channel, user, text: r.text, ...(threadTs ? { thread_ts: threadTs } : {}) });
  }

  /** Where an origin's messages go: the IM for a DM, the channel and root ts for a thread. */
  async function target(origin: Origin): Promise<{ channel: string; thread_ts?: string }> {
    if (origin.kind === "dm") {
      let channel = ims.get(origin.conversationId);
      if (!channel) {
        const r = await web.conversations.open({ users: origin.conversationId });
        channel = r.channel?.id;
        if (!channel) throw new SendRejected(`no IM channel for ${origin.conversationId}`, false);
        ims.set(origin.conversationId, channel);
      }
      return { channel };
    }
    if (origin.kind === "thread") {
      const { channel, threadTs } = threadOf(origin.conversationId);
      return { channel, thread_ts: threadTs };
    }
    return { channel: origin.conversationId };
  }

  const body = (msg: { text: string; rows?: Row[] }) =>
    msg.rows ? { text: msg.text.slice(0, 3000), blocks: toBlocks({ text: msg.text, rows: msg.rows }) as unknown as KnownBlock[] } : { text: msg.text };

  return {
    get botUserId() {
      return botUserId;
    },
    onMessage: (h) => void messageHandlers.push(h),
    onComponent: (h) => void (componentHandler = h),
    // replyTo needs no field: a DM answer goes top level and a thread answer into the thread it came from.
    async send(origin, msg: OutboundMessage) {
      try {
        const r = await web.chat.postMessage({ ...(await target(origin)), ...body(msg), unfurl_links: false, unfurl_media: false });
        if (!r.ts) throw new Error("chat.postMessage returned no ts");
        return r.ts;
      } catch (err) {
        throw classify(err);
      }
    },
    async edit(origin, messageId, msg) {
      try {
        const { channel } = await target(origin);
        await web.chat.update({ channel, ts: messageId, ...body(msg) });
      } catch (err) {
        throw classify(err);
      }
    },
    async react(origin, messageId, emoji) {
      try {
        await web.reactions.add({ channel: (await target(origin)).channel, timestamp: messageId, name: emoji });
      } catch (err) {
        if ((err as { data?: { error?: string } })?.data?.error !== "already_reacted") throw err;
      }
    },
    async connect() {
      const auth = await web.auth.test();
      if (!auth.user_id) throw new Error("auth.test returned no bot user id");
      botUserId = auth.user_id;
      await socket.start();
    },
    disconnect: () => socket.disconnect(),
  };
}
