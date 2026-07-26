import type { ChatInputCommandInteraction } from "discord.js";

import { ResourceAdjustmentType } from "../../domain/resource-adjustment.js";
import type { ClanQueryService } from "../../services/clan-query-service.js";
import type { MemberService } from "../../services/member-service.js";
import type { RuntimeStateService } from "../../services/runtime-state-service.js";
import { cleanupDepartedMembersOnDateRollover } from "../day-rollover-departed-member-cleanup.js";
import type { InteractionRouter } from "../interaction-router.js";
import {
  DiscordGuildTextGateway,
  SlashResponseChannelAdapter,
  deferChatInputReply,
  resolveCachedGuildDisplayNames,
  resolveGuildDisplayNamesForUserIds,
  resolveMemberIdentity,
  resolveManagedInteractionContext,
} from "./shared.js";

export interface QueryCommandHandlersOptions {
  clanQueryService: Pick<ClanQueryService, "setLap" | "calcCarryOver" | "adjustRemainAttackCount">;
  memberService: Pick<MemberService, "remove">;
  runtimeStateService: Pick<RuntimeStateService, "get" | "ensureDateUpToDate">;
}

function createQueryResponseChannel(interaction: ChatInputCommandInteraction): SlashResponseChannelAdapter {
  return new SlashResponseChannelAdapter(
    interaction,
    false,
  );
}

export async function handleLapCommand(
  interaction: ChatInputCommandInteraction,
  options: QueryCommandHandlersOptions,
): Promise<void> {
  if (!interaction.guild) {
    throw new Error("Guild interaction is required.");
  }

  await deferChatInputReply(interaction, false);

  const managedContext = await resolveManagedInteractionContext(interaction);
  const categoryId = managedContext.categoryId ?? interaction.channelId;
  const bossNumber = interaction.options.getInteger("boss_number");
  const discordGateway = new DiscordGuildTextGateway(interaction.guild);
  await cleanupDepartedMembersOnDateRollover({
    runtimeStateService: options.runtimeStateService,
    memberService: options.memberService,
    guild: interaction.guild,
    categoryId,
    discordGateway,
  });
  const clanData = options.runtimeStateService.get(categoryId);

  await options.clanQueryService.setLap({
    categoryId,
    channelId: interaction.channelId,
    lap: interaction.options.getInteger("lap", true),
    ...(bossNumber !== null ? { bossNumber } : {}),
    responseChannel: createQueryResponseChannel(interaction),
    discordGateway,
    displayNamesByUserId: clanData
      ? await resolveGuildDisplayNamesForUserIds(interaction.guild, clanData.playerDataMap.keys())
      : resolveCachedGuildDisplayNames(interaction.guild),
  });
}

export async function handleCalcCarryOverCommand(
  interaction: ChatInputCommandInteraction,
  options: QueryCommandHandlersOptions,
): Promise<void> {
  await deferChatInputReply(interaction, false);

  await options.clanQueryService.calcCarryOver({
    values: interaction.options.getString("values", true),
    responseChannel: createQueryResponseChannel(interaction),
  });
}

export async function handleAdjustRemainAttackCountCommand(
  interaction: ChatInputCommandInteraction,
  options: QueryCommandHandlersOptions,
): Promise<void> {
  if (!interaction.guild) {
    throw new Error("Guild interaction is required.");
  }

  await deferChatInputReply(interaction, false);

  const managedContext = await resolveManagedInteractionContext(interaction);
  const categoryId = managedContext.categoryId ?? interaction.channelId;
  const discordGateway = new DiscordGuildTextGateway(interaction.guild);
  await cleanupDepartedMembersOnDateRollover({
    runtimeStateService: options.runtimeStateService,
    memberService: options.memberService,
    guild: interaction.guild,
    categoryId,
    discordGateway,
  });
  const clanData = options.runtimeStateService.get(categoryId);
  const member = await resolveMemberIdentity(interaction.guild, interaction.options.getUser("member", true));
  const actor = await resolveMemberIdentity(interaction.guild, interaction.user);
  const typeValue = interaction.options.getString("type", true);

  await options.clanQueryService.adjustRemainAttackCount({
    categoryId,
    channelId: interaction.channelId,
    actor,
    member,
    type:
      typeValue === ResourceAdjustmentType.BATTLE
        ? ResourceAdjustmentType.BATTLE
        : ResourceAdjustmentType.CARRYOVER,
    remaining: interaction.options.getInteger("remaining", true),
    responseChannel: createQueryResponseChannel(interaction),
    discordGateway,
    displayNamesByUserId: clanData
      ? await resolveGuildDisplayNamesForUserIds(interaction.guild, clanData.playerDataMap.keys())
      : resolveCachedGuildDisplayNames(interaction.guild),
  });
}

export function registerQueryCommandHandlers(
  router: InteractionRouter,
  options: QueryCommandHandlersOptions,
): void {
  router.registerChatInputCommand("周回数変更", async (interaction) => {
    await handleLapCommand(interaction, options);
  });
  router.registerChatInputCommand("lap", async (interaction) => {
    await handleLapCommand(interaction, options);
  });
  router.registerChatInputCommand("持越し計算", async (interaction) => {
    await handleCalcCarryOverCommand(interaction, options);
  });
  router.registerChatInputCommand("time", async (interaction) => {
    await handleCalcCarryOverCommand(interaction, options);
  });
  router.registerChatInputCommand("calc_cot", async (interaction) => {
    await handleCalcCarryOverCommand(interaction, options);
  });
  router.registerChatInputCommand("残凸修正", async (interaction) => {
    await handleAdjustRemainAttackCountCommand(interaction, options);
  });
  router.registerChatInputCommand("adjust_remain_attack_count", async (interaction) => {
    await handleAdjustRemainAttackCountCommand(interaction, options);
  });
}
