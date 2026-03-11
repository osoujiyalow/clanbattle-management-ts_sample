import type { ChatInputCommandInteraction } from "discord.js";

import type { MemberService } from "../../services/member-service.js";
import type { InteractionRouter } from "../interaction-router.js";
import {
  DiscordGuildTextGateway,
  deferChatInputReply,
  getDisplayNameFromInteraction,
  resolveGuildDisplayNames,
  resolveManagedInteractionContext,
  resolveMemberIdentity,
  resolveRoleMembers,
  SlashResponseChannelAdapter,
} from "./shared.js";

export interface MemberCommandHandlersOptions {
  memberService: Pick<MemberService, "add" | "remove">;
}

async function resolveMemberCommandDisplayNames(
  interaction: ChatInputCommandInteraction,
  members: readonly { id: string; displayName: string }[],
): Promise<ReadonlyMap<string, string>> {
  if (!interaction.guild) {
    throw new Error("Guild interaction is required.");
  }

  const displayNamesByUserId = new Map(await resolveGuildDisplayNames(interaction.guild));
  displayNamesByUserId.set(interaction.user.id, getDisplayNameFromInteraction(interaction));

  for (const member of members) {
    displayNamesByUserId.set(member.id, member.displayName);
  }

  return displayNamesByUserId;
}

async function createMemberBaseRequest(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) {
    throw new Error("Guild interaction is required.");
  }

  const managedContext = await resolveManagedInteractionContext(interaction);
  const actor = {
    id: interaction.user.id,
    displayName: getDisplayNameFromInteraction(interaction),
  };

  return {
    categoryId: managedContext.categoryId ?? interaction.channelId,
    actor,
    responseChannel: new SlashResponseChannelAdapter(
      interaction,
      false,
    ),
    discordGateway: new DiscordGuildTextGateway(interaction.guild),
  };
}

export async function handleAddCommand(
  interaction: ChatInputCommandInteraction,
  options: MemberCommandHandlersOptions,
): Promise<void> {
  if (!interaction.guild) {
    throw new Error("Guild interaction is required.");
  }

  await deferChatInputReply(interaction, false);

  const baseRequest = await createMemberBaseRequest(interaction);
  const memberUser = interaction.options.getUser("member");
  const role = interaction.options.getRole("role");
  const member = memberUser ? await resolveMemberIdentity(interaction.guild, memberUser) : undefined;
  const roleMembers = role ? await resolveRoleMembers(interaction.guild, role) : undefined;

  await options.memberService.add({
    ...baseRequest,
    ...(member ? { member } : {}),
    ...(roleMembers ? { role: { members: roleMembers } } : {}),
    displayNamesByUserId: await resolveMemberCommandDisplayNames(interaction, [
      ...(member ? [member] : []),
      ...(roleMembers ?? []),
    ]),
  });
}

export async function handleRemoveCommand(
  interaction: ChatInputCommandInteraction,
  options: MemberCommandHandlersOptions,
): Promise<void> {
  if (!interaction.guild) {
    throw new Error("Guild interaction is required.");
  }

  await deferChatInputReply(interaction, false);

  const baseRequest = await createMemberBaseRequest(interaction);
  const memberUser = interaction.options.getUser("member");
  const member = memberUser ? await resolveMemberIdentity(interaction.guild, memberUser) : undefined;

  await options.memberService.remove({
    ...baseRequest,
    ...(member ? { member } : {}),
    ...(interaction.options.getBoolean("all") !== null
      ? { all: interaction.options.getBoolean("all") ?? false }
      : {}),
    displayNamesByUserId: await resolveMemberCommandDisplayNames(interaction, member ? [member] : []),
  });
}

export function registerMemberCommandHandlers(
  router: InteractionRouter,
  options: MemberCommandHandlersOptions,
): void {
  router.registerChatInputCommand("add", async (interaction) => {
    await handleAddCommand(interaction, options);
  });
  router.registerChatInputCommand("remove", async (interaction) => {
    await handleRemoveCommand(interaction, options);
  });
}
