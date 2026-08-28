import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from "discord.js";

import { resolveCurrentBossHp } from "../../domain/boss-hp.js";
import type { HpChangeService } from "../../services/hp-change-service.js";
import type { RuntimeStateService } from "../../services/runtime-state-service.js";
import {
  NumericTokenizationError,
  parseNormalizedIntegerToken,
  tokenizeNumericInput,
} from "../../shared/numeric-tokenizer.js";
import type { InteractionRouter } from "../interaction-router.js";
import {
  DiscordGuildTextGateway,
  SlashResponseChannelAdapter,
  resolveGuildDisplayNamesForUserIds,
  resolveManagedInteractionContext,
  resolveMemberIdentity,
} from "./shared.js";

const HP_CHANGE_MODAL_PREFIX = "hp-change";
const HP_CHANGE_INPUT_ID = "target-hp";

interface HpChangeModalContext {
  categoryId: string;
  ownerUserId: string;
  lap: number;
  bossIndex: number;
}

export interface HpChangeCommandHandlersOptions {
  hpChangeService: Pick<HpChangeService, "changeBossHp">;
  runtimeStateService: Pick<RuntimeStateService, "get">;
}

function hasManageGuildPermission(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

function createModalCustomId(context: HpChangeModalContext): string {
  return [
    HP_CHANGE_MODAL_PREFIX,
    context.categoryId,
    context.ownerUserId,
    context.lap,
    context.bossIndex,
  ].join(":");
}

function parseModalCustomId(customId: string): HpChangeModalContext | null {
  const [prefix, categoryId, ownerUserId, lapText, bossIndexText, ...rest] = customId.split(":");
  if (
    prefix !== HP_CHANGE_MODAL_PREFIX ||
    !categoryId ||
    !ownerUserId ||
    !lapText ||
    !bossIndexText ||
    rest.length > 0
  ) {
    return null;
  }

  const lap = Number.parseInt(lapText, 10);
  const bossIndex = Number.parseInt(bossIndexText, 10);
  if (!Number.isSafeInteger(lap) || lap <= 0 || !Number.isInteger(bossIndex) || bossIndex < 0) {
    return null;
  }

  return {
    categoryId,
    ownerUserId,
    lap,
    bossIndex,
  };
}

function parseTargetHp(value: string): number | null {
  try {
    const tokens = tokenizeNumericInput(value);
    if (tokens.length !== 1) {
      return null;
    }

    return parseNormalizedIntegerToken(tokens[0]!);
  } catch (error) {
    if (error instanceof NumericTokenizationError) {
      return null;
    }

    throw error;
  }
}

function createHpChangeModal(context: HpChangeModalContext, currentHp: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(createModalCustomId(context))
    .setTitle(`${context.lap}周目 ${context.bossIndex + 1}ボス HP修正`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(HP_CHANGE_INPUT_ID)
          .setLabel("修正後HP（万）")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(20)
          .setValue(String(currentHp)),
      ),
    );
}

export async function handleHpChangeCommand(
  interaction: ChatInputCommandInteraction,
  options: HpChangeCommandHandlersOptions,
): Promise<void> {
  if (!interaction.guild || !interaction.guildId) {
    await interaction.reply({
      content: "サーバー内のボスチャンネルで実行してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!hasManageGuildPermission(interaction)) {
    await interaction.reply({
      content: "このコマンドの実行には「サーバー管理」権限が必要です。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const managedContext = await resolveManagedInteractionContext(interaction);
  const categoryId = managedContext.categoryId;
  const clanData = categoryId ? options.runtimeStateService.get(categoryId) : undefined;
  if (!categoryId || !clanData) {
    await interaction.reply({
      content: "凸管理カテゴリ内のボスチャンネルで実行してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const bossIndex = clanData.getBossIndexFromChannelId(interaction.channelId);
  if (bossIndex === undefined) {
    await interaction.reply({
      content: "`/hp_change` は各ボスチャンネルで実行してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let lap: number;
  try {
    lap = clanData.getLatestLap(bossIndex);
  } catch {
    await interaction.reply({
      content: "対象ボスの現在周回を取得できませんでした。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const bossStatusData = clanData.bossStatusByLap.get(lap)?.[bossIndex];
  if (!bossStatusData) {
    await interaction.reply({
      content: "対象ボスのHP情報が見つかりません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (bossStatusData.beated) {
    await interaction.reply({
      content: "討伐済みのボスはHP修正できません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.showModal(
    createHpChangeModal(
      {
        categoryId,
        ownerUserId: interaction.user.id,
        lap,
        bossIndex,
      },
      resolveCurrentBossHp(bossStatusData),
    ),
  );
}

export async function handleHpChangeModal(
  interaction: ModalSubmitInteraction,
  options: HpChangeCommandHandlersOptions,
): Promise<void> {
  const context = parseModalCustomId(interaction.customId);
  if (!context) {
    await interaction.reply({
      content: "HP修正画面の情報が不正です。もう一度 `/hp_change` を実行してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (context.ownerUserId !== interaction.user.id || !hasManageGuildPermission(interaction)) {
    await interaction.reply({
      content: "このHP修正画面は操作できません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.guild || !interaction.channelId) {
    await interaction.reply({
      content: "サーバー内のボスチャンネルで実行してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const targetHp = parseTargetHp(interaction.fields.getTextInputValue(HP_CHANGE_INPUT_ID));
  if (targetHp === null) {
    await interaction.reply({
      content: "修正後HPは整数で入力してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  const clanData = options.runtimeStateService.get(context.categoryId);
  const actor = await resolveMemberIdentity(interaction.guild, interaction.user);
  const displayNameUserIds = new Set<string>([actor.id]);
  if (clanData) {
    for (const attackStatus of clanData.bossStatusByLap.get(context.lap)?.[context.bossIndex]
      ?.attackPlayers ?? []) {
      displayNameUserIds.add(attackStatus.playerData.userId);
    }
  }

  const displayNamesByUserId = await resolveGuildDisplayNamesForUserIds(
    interaction.guild,
    displayNameUserIds,
  );
  await options.hpChangeService.changeBossHp({
    categoryId: context.categoryId,
    channelId: interaction.channelId,
    lap: context.lap,
    bossIndex: context.bossIndex,
    targetHp,
    actor,
    responseChannel: new SlashResponseChannelAdapter(interaction, false),
    discordGateway: new DiscordGuildTextGateway(interaction.guild),
    displayNamesByUserId,
    resolveDisplayNamesByUserIds: (userIds) =>
      resolveGuildDisplayNamesForUserIds(interaction.guild!, userIds),
  });
}

export function registerHpChangeCommandHandlers(
  router: InteractionRouter,
  options: HpChangeCommandHandlersOptions,
): void {
  router.registerChatInputCommand("hp_change", async (interaction) => {
    await handleHpChangeCommand(interaction, options);
  });
  router.registerModalHandler(/^hp-change:/u, async (interaction) => {
    await handleHpChangeModal(interaction, options);
  });
}
