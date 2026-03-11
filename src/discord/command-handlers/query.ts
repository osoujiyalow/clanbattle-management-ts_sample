import type { ChatInputCommandInteraction } from "discord.js";

import type { ClanQueryService } from "../../services/clan-query-service.js";
import type { InteractionRouter } from "../interaction-router.js";
import {
  DiscordGuildTextGateway,
  SlashResponseChannelAdapter,
  deferChatInputReply,
  resolveGuildDisplayNames,
  resolveManagedInteractionContext,
} from "./shared.js";

export interface QueryCommandHandlersOptions {
  clanQueryService: Pick<ClanQueryService, "setLap" | "calcCarryOver">;
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
  const bossNumber = interaction.options.getInteger("boss_number");

  await options.clanQueryService.setLap({
    categoryId: managedContext.categoryId ?? interaction.channelId,
    channelId: interaction.channelId,
    lap: interaction.options.getInteger("lap", true),
    ...(bossNumber !== null ? { bossNumber } : {}),
    responseChannel: createQueryResponseChannel(interaction),
    discordGateway: new DiscordGuildTextGateway(interaction.guild),
    displayNamesByUserId: await resolveGuildDisplayNames(interaction.guild),
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

export function registerQueryCommandHandlers(
  router: InteractionRouter,
  options: QueryCommandHandlersOptions,
): void {
  router.registerChatInputCommand("lap", async (interaction) => {
    await handleLapCommand(interaction, options);
  });
  router.registerChatInputCommand("calc_cot", async (interaction) => {
    await handleCalcCarryOverCommand(interaction, options);
  });
}
