import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildBasedChannel,
  type MessageActionRowComponentBuilder,
  type ModalActionRowComponentBuilder,
  type ModalSubmitInteraction,
  type TextBasedChannel,
} from "discord.js";

import type { InteractionRouter } from "../interaction-router.js";
import { parseTlCarryoverSeconds } from "../../services/tl-conversion-service.js";
import type { TlConversionService } from "../../services/tl-conversion-service.js";

const TL_MODAL_CUSTOM_ID = "tl-modal";
const TL_ACTION_BUTTON_PREFIX = "tl-action";

const TL_MODAL_FIELD_IDS = {
  carryoverSeconds: "carryover-seconds",
  tlBody: "tl-body",
} as const;

type TlAction = "new" | "delete";

export interface TlCommandHandlersOptions {
  tlConversionService: Pick<TlConversionService, "convert">;
}

function createTlModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(TL_MODAL_CUSTOM_ID)
    .setTitle("TL変換")
    .addComponents(
      new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(TL_MODAL_FIELD_IDS.carryoverSeconds)
          .setLabel("持越秒数")
          .setPlaceholder("90")
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
      new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(TL_MODAL_FIELD_IDS.tlBody)
          .setLabel("TL本文")
          .setPlaceholder(
            "TL本文を貼り付けてください。discordからの文章コピーはdiscordの「テキストをコピー」機能を使ってください",
          )
          .setRequired(true)
          .setStyle(TextInputStyle.Paragraph),
      ),
    );
}

function createTlActionButtons(): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(createTlActionButtonCustomId("new"))
      .setLabel("新規")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(createTlActionButtonCustomId("delete"))
      .setLabel("削除")
      .setStyle(ButtonStyle.Secondary),
  );
}

function escapeCodeBlockContent(text: string): string {
  return text.replace(/```/gu, "``\u200b`");
}

function createTlOutputContent(carryoverSeconds: number, convertedText: string): string {
  return `TL変換しました。(${carryoverSeconds}秒持越)\n\`\`\`\n${escapeCodeBlockContent(convertedText)}\n\`\`\``;
}

function resolveInteractionTextChannel(
  interaction: ModalSubmitInteraction,
): (TextBasedChannel & GuildBasedChannel) | null {
  const channel = interaction.channel;
  if (!channel || !channel.isTextBased()) {
    return null;
  }

  return channel as TextBasedChannel & GuildBasedChannel;
}

function parseTlActionButtonCustomId(customId: string): TlAction | null {
  const parts = customId.split(":");
  if (parts.length !== 2 || parts[0] !== TL_ACTION_BUTTON_PREFIX) {
    return null;
  }

  const [, action] = parts;
  if (action !== "new" && action !== "delete") {
    return null;
  }

  return action;
}

export function createTlActionButtonCustomId(action: TlAction): string {
  return `${TL_ACTION_BUTTON_PREFIX}:${action}`;
}

export async function handleTlCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.showModal(createTlModal());
}

export async function handleTlModalSubmit(
  interaction: ModalSubmitInteraction,
  options: TlCommandHandlersOptions,
): Promise<void> {
    const carryoverSeconds = parseTlCarryoverSeconds(
      interaction.fields.getTextInputValue(TL_MODAL_FIELD_IDS.carryoverSeconds),
    );
    if (typeof carryoverSeconds !== "number") {
      await interaction.reply({
        content: carryoverSeconds.message,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const result = options.tlConversionService.convert({
      carryoverSeconds,
      tlBody: interaction.fields.getTextInputValue(TL_MODAL_FIELD_IDS.tlBody),
    });
    if (!result.ok) {
      await interaction.reply({
        content: result.message,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const channel = resolveInteractionTextChannel(interaction);
    if (!channel) {
      await interaction.reply({
        content: "このチャンネルではTL変換結果を送信できません。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    });
    await channel.send({
      content: createTlOutputContent(carryoverSeconds, result.convertedText),
      components: [createTlActionButtons()],
      allowedMentions: {
        parse: [],
      },
    });
    await interaction.deleteReply();
}

export async function handleTlButtonInteraction(
  interaction: ButtonInteraction,
): Promise<void> {
  const action = parseTlActionButtonCustomId(interaction.customId);
  if (!action) {
    return;
  }

  if (action === "new") {
    await interaction.showModal(createTlModal());
    return;
  }

  await interaction.deferUpdate();
  await interaction.message.delete();
}

export function registerTlCommandHandlers(
  router: InteractionRouter,
  options: TlCommandHandlersOptions,
): void {
  router.registerChatInputCommand("tl", async (interaction) => {
    await handleTlCommand(interaction);
  });
  router.registerButtonHandler(/^tl-action:/u, async (interaction) => {
    await handleTlButtonInteraction(interaction);
  });
  router.registerModalHandler(TL_MODAL_CUSTOM_ID, async (interaction) => {
    await handleTlModalSubmit(interaction, options);
  });
}
