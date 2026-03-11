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
  "/setup \u306f\u7ba1\u7406\u8005\u6a29\u9650\u3092\u6301\u3064\u30e6\u30fc\u30b6\u30fc\u3060\u3051\u5b9f\u884c\u3067\u304d\u307e\u3059\u3002";

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
  router.registerChatInputCommand("setup", async (interaction) => {
    await handleSetupCommand(interaction, options);
  });
}
