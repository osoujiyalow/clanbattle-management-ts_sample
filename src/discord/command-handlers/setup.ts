import { PermissionFlagsBits, type ChatInputCommandInteraction } from "discord.js";

import type { ClanSetupService } from "../../services/clan-setup-service.js";
import type { InteractionRouter } from "../interaction-router.js";
import {
  DiscordGuildAdapter,
  SlashSetupResponseChannelAdapter,
  SlashResponseChannelAdapter,
  deferChatInputReply,
  getInteractionChannelName,
} from "./shared.js";

export interface SetupCommandHandlersOptions {
  clanSetupService: Pick<ClanSetupService, "execute">;
}

const SETUP_ADMIN_REQUIRED_MESSAGE =
  "/setup は管理者権限を持つユーザーだけ実行できます。";

function hasAdministratorPermission(interaction: ChatInputCommandInteraction): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
}

export async function handleSetupCommand(
  interaction: ChatInputCommandInteraction,
  options: SetupCommandHandlersOptions,
): Promise<void> {
  if (!interaction.guild) {
    throw new Error("Guild interaction is required.");
  }

  if (!hasAdministratorPermission(interaction)) {
    await deferChatInputReply(interaction, true);
    await new SlashResponseChannelAdapter(interaction, true).send({
      content: SETUP_ADMIN_REQUIRED_MESSAGE,
    });
    return;
  }

  await deferChatInputReply(interaction, false);

  const responseChannel = new SlashSetupResponseChannelAdapter(
    interaction,
    false,
    interaction.channelId,
    getInteractionChannelName(interaction),
  );

  await options.clanSetupService.execute({
    guild: new DiscordGuildAdapter(interaction.guild),
    responseChannel,
    ...(interaction.options.getString("category_channel_name")
      ? { categoryChannelName: interaction.options.getString("category_channel_name", true) }
      : {}),
  });
}

export function registerSetupCommandHandlers(
  router: InteractionRouter,
  options: SetupCommandHandlersOptions,
): void {
  router.registerChatInputCommand("セットアップ", async (interaction) => {
    await handleSetupCommand(interaction, options);
  });
  router.registerChatInputCommand("setup", async (interaction) => {
    await handleSetupCommand(interaction, options);
  });
}
