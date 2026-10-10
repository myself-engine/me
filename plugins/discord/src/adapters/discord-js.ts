// DiscordGateway over discord.js. Every Discord specific (intents, partials, builders, API errors) stays here.
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  StringSelectMenuBuilder,
  type MessageActionRowComponentBuilder,
  type SendableChannels,
} from "discord.js";
import { SendRejected, type Origin } from "@me/messenger";
import type { DiscordMessage } from "../domain/inbound.ts";
import type { Row } from "../domain/render.ts";
import type { ComponentPress, ComponentReply, DiscordGateway } from "../ports/index.ts";

const STYLE = { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger };

function toRows(rows: Row[]) {
  return rows.map((row) => {
    const r = new ActionRowBuilder<MessageActionRowComponentBuilder>();
    for (const c of row) {
      if (c.type === "button") r.addComponents(new ButtonBuilder().setCustomId(c.id).setLabel(c.label).setStyle(STYLE[c.style]));
      else
        r.addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(c.id)
            .setPlaceholder(c.placeholder)
            .addOptions(c.options.map((o) => ({ value: o.value, label: o.label.slice(0, 100), default: o.selected }))),
        );
    }
    return r;
  });
}

/** 4xx means Discord definitely refused (429 may be retried); anything else leaves the outcome unknown. */
function classify(err: unknown): unknown {
  if (err instanceof SendRejected) return err;
  if (err instanceof DiscordAPIError && err.status >= 400 && err.status < 500) return new SendRejected(`${err.status} ${err.message}`, err.status === 429);
  return err;
}

export interface DiscordJsGateway extends DiscordGateway {
  /** Logs in and resolves once the client is ready. */
  connect(): Promise<void>;
  destroy(): Promise<void>;
}

export function discordJsGateway(token: string, log: (...a: unknown[]) => void = console.error): DiscordJsGateway {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
    // Without the Channel partial, discord.js v14 drops DMs from uncached channels.
    partials: [Partials.Channel],
  });
  const messageHandlers: ((m: DiscordMessage) => void)[] = [];
  let componentHandler: ((p: ComponentPress) => Promise<ComponentReply>) | null = null;
  const botId = () => client.user?.id ?? "";

  client.on(Events.MessageCreate, (m) => {
    if (m.system) return;
    const place = m.channel.isDMBased() ? "dm" : m.channel.isThread() ? "thread" : "guild";
    const msg: DiscordMessage = {
      place,
      channelId: m.channelId,
      authorId: m.author.id,
      messageId: m.id,
      content: m.content,
      mentionsBot: m.mentions.users.has(botId()),
      repliesToBot: !!m.reference && m.mentions.repliedUser?.id === botId(),
    };
    for (const h of messageHandlers) h(msg);
  });

  client.on(Events.InteractionCreate, async (i) => {
    if ((!i.isButton() && !i.isStringSelectMenu()) || !componentHandler) return;
    try {
      // Acknowledge within Discord's 3 seconds; the answer goes only to the presser.
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const r = await componentHandler({ customId: i.customId, userId: i.user.id, values: i.isStringSelectMenu() ? i.values : [] });
      await i.editReply({
        content: r.text,
        files: r.file ? [new AttachmentBuilder(Buffer.from(r.file.content, "utf8"), { name: r.file.name })] : [],
      });
    } catch (err) {
      log("[discord] interaction failed:", (err as Error)?.message ?? err);
    }
  });

  async function channel(origin: Origin): Promise<SendableChannels> {
    if (origin.kind === "dm") return (await client.users.fetch(origin.conversationId)).createDM();
    const ch = await client.channels.fetch(origin.conversationId);
    if (!ch?.isSendable()) throw new SendRejected(`channel ${origin.conversationId} is not sendable`, false);
    return ch;
  }

  return {
    get botUserId() {
      return botId();
    },
    onMessage: (h) => void messageHandlers.push(h),
    onComponent: (h) => void (componentHandler = h),
    async send(origin, msg) {
      try {
        const sent = await (await channel(origin)).send({
          content: msg.text,
          components: toRows(msg.rows ?? []),
          ...(msg.replyTo ? { reply: { messageReference: msg.replyTo, failIfNotExists: false } } : {}),
          allowedMentions: { parse: [], repliedUser: false },
        });
        return sent.id;
      } catch (err) {
        throw classify(err);
      }
    },
    async edit(origin, messageId, msg) {
      const m = await (await channel(origin)).messages.fetch(messageId);
      await m.edit({ content: msg.text, components: toRows(msg.rows) });
    },
    async react(origin, messageId, emoji) {
      await (await (await channel(origin)).messages.fetch(messageId)).react(emoji);
    },
    async typing(origin) {
      await (await channel(origin)).sendTyping();
    },
    async connect() {
      const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
      await client.login(token);
      await ready;
    },
    destroy: () => client.destroy(),
  };
}
