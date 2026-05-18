import type { ChatInputCommandInteraction } from "discord.js";

import type { MemberService } from "../../services/member-service.js";
import type { RuntimeStateService } from "../../services/runtime-state-service.js";
import type { InteractionRouter } from "../interaction-router.js";
import {
  DiscordGuildTextGateway,
  deferChatInputReply,
  getDisplayNameFromInteraction,
  resolveCachedGuildDisplayNames,
  resolveGuildDisplayNamesForUserIds,
  resolveManagedInteractionContext,
  resolveMemberIdentity,
  resolveRoleMembers,
  SlashResponseChannelAdapter,
} from "./shared.js";

export interface MemberCommandHandlersOptions {
  memberService: Pick<MemberService, "add" | "remove">;
  runtimeStateService: Pick<RuntimeStateService, "get">;
}

async function resolveMemberCommandDisplayNames(
  interaction: ChatInputCommandInteraction,
  categoryId: string,
  options: MemberCommandHandlersOptions,
  members: readonly { id: string; displayName: string }[],
): Promise<ReadonlyMap<string, string>> {
  if (!interaction.guild) {
    throw new Error("Guild interaction is required.");
  }

  const clanData = options.runtimeStateService.get(categoryId);
  const displayNamesByUserId = clanData
    ? new Map(
        await resolveGuildDisplayNamesForUserIds(
          interaction.guild,
          clanData.playerDataMap.keys(),
        ),
      )
    : new Map(resolveCachedGuildDisplayNames(interaction.guild));
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
    displayNamesByUserId: await resolveMemberCommandDisplayNames(
      interaction,
      baseRequest.categoryId,
      options,
      [
        ...(member ? [member] : []),
        ...(roleMembers ?? []),
      ],
    ),
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
    displayNamesByUserId: await resolveMemberCommandDisplayNames(
      interaction,
      baseRequest.categoryId,
      options,
      member ? [member] : [],
    ),
  });
}

export function registerMemberCommandHandlers(
  router: InteractionRouter,
  options: MemberCommandHandlersOptions,
): void {
  router.registerChatInputCommand("メンバー追加", async (interaction) => {
    await handleAddCommand(interaction, options);
  });
  router.registerChatInputCommand("add", async (interaction) => {
    await handleAddCommand(interaction, options);
  });
  router.registerChatInputCommand("メンバー削除", async (interaction) => {
    await handleRemoveCommand(interaction, options);
  });
  router.registerChatInputCommand("remove", async (interaction) => {
    await handleRemoveCommand(interaction, options);
  });
}
