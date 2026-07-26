import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";

import type { MemberService } from "../../services/member-service.js";
import type { RuntimeStateService } from "../../services/runtime-state-service.js";
import { cleanupDepartedMembersOnDateRollover } from "../day-rollover-departed-member-cleanup.js";
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
  memberService: Pick<
    MemberService,
    "add" | "remove" | "increaseBattleAttackLimit" | "decreaseBattleAttackLimit"
  >;
  runtimeStateService: Pick<
    RuntimeStateService,
    "get" | "ensureDateUpToDate" | "getPlayerResourceState"
  >;
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

async function createMemberBaseRequest(
  interaction: ChatInputCommandInteraction,
  options: MemberCommandHandlersOptions,
  ephemeral = false,
) {
  if (!interaction.guild) {
    throw new Error("Guild interaction is required.");
  }

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

  const actor = {
    id: interaction.user.id,
    displayName: getDisplayNameFromInteraction(interaction),
  };

  return {
    categoryId,
    actor,
    responseChannel: new SlashResponseChannelAdapter(
      interaction,
      ephemeral,
    ),
    discordGateway,
  };
}

const EXTRA_BATTLE_ATTACK_CONFIRM_PREFIX = "add-extra-attacks";
const EXTRA_BATTLE_ATTACK_CONFIRM_TIMEOUT_MS = 60_000;

function createExtraBattleAttackConfirmationRow(
  customIdPrefix: string,
  canDecrease: boolean,
) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:increase`)
      .setLabel("3凸増やす")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:decrease`)
      .setLabel("3凸減らす")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!canDecrease),
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:cancel`)
      .setLabel("キャンセル")
      .setStyle(ButtonStyle.Secondary),
  );
}

async function deleteInteractionReplyQuietly(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    await interaction.deleteReply();
  } catch {
    // The confirmation may already have been removed.
  }
}

async function confirmExtraBattleAttacks(
  interaction: ChatInputCommandInteraction,
  options: MemberCommandHandlersOptions,
  request: Awaited<ReturnType<typeof createMemberBaseRequest>> & {
    member: { id: string; displayName: string };
    displayNamesByUserId: ReadonlyMap<string, string>;
  },
  currentBattleAttackLimit: number,
  canDecrease: boolean,
): Promise<void> {
  const customIdPrefix = `${EXTRA_BATTLE_ATTACK_CONFIRM_PREFIX}:${interaction.id}`;
  await interaction.editReply({
    content: `現在<@${request.member.id}>は${currentBattleAttackLimit}凸です。`,
    components: [createExtraBattleAttackConfirmationRow(customIdPrefix, canDecrease)],
  });

  let selectedAction: "increase" | "decrease" | null = null;
  try {
    const confirmationMessage = await interaction.fetchReply();
    const selection = await confirmationMessage.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: EXTRA_BATTLE_ATTACK_CONFIRM_TIMEOUT_MS,
      filter: (buttonInteraction: ButtonInteraction) =>
        buttonInteraction.user.id === interaction.user.id &&
        buttonInteraction.customId.startsWith(`${customIdPrefix}:`),
    });

    await selection.deferUpdate();
    if (selection.customId === `${customIdPrefix}:increase`) {
      selectedAction = "increase";
    } else if (selection.customId === `${customIdPrefix}:decrease`) {
      selectedAction = "decrease";
    }
  } catch {
    // A timed-out confirmation is treated as "no".
  } finally {
    await deleteInteractionReplyQuietly(interaction);
  }

  if (selectedAction === "increase") {
    await options.memberService.increaseBattleAttackLimit(request);
  } else if (selectedAction === "decrease") {
    await options.memberService.decreaseBattleAttackLimit(request);
  }
}

export async function handleAddCommand(
  interaction: ChatInputCommandInteraction,
  options: MemberCommandHandlersOptions,
): Promise<void> {
  if (!interaction.guild) {
    throw new Error("Guild interaction is required.");
  }

  const memberUser = interaction.options.getUser("member");
  const role = interaction.options.getRole("role");
  const managedContext = await resolveManagedInteractionContext(interaction);
  const categoryId = managedContext.categoryId ?? interaction.channelId;
  const isExplicitDuplicateMemberAdd = Boolean(
    memberUser &&
      !role &&
      options.runtimeStateService.get(categoryId)?.playerDataMap.has(memberUser.id),
  );

  await deferChatInputReply(interaction, isExplicitDuplicateMemberAdd);

  const baseRequest = await createMemberBaseRequest(
    interaction,
    options,
    isExplicitDuplicateMemberAdd,
  );
  const member = memberUser ? await resolveMemberIdentity(interaction.guild, memberUser) : undefined;
  const roleMembers = role ? await resolveRoleMembers(interaction.guild, role) : undefined;
  const displayNamesByUserId = await resolveMemberCommandDisplayNames(
    interaction,
    baseRequest.categoryId,
    options,
    [
      ...(member ? [member] : []),
      ...(roleMembers ?? []),
    ],
  );

  const existingPlayerData =
    member && !role
      ? options.runtimeStateService.get(baseRequest.categoryId)?.getPlayerData(member.id)
      : undefined;
  if (member && existingPlayerData) {
    const playerResourceState = options.runtimeStateService.getPlayerResourceState(
      baseRequest.categoryId,
      member.id,
      options.runtimeStateService.get(baseRequest.categoryId)?.date ?? "",
    );
    const occupiedBattleAttackCount =
      (playerResourceState?.battleReservedCount ?? 0) +
      (playerResourceState?.battleConsumedCount ?? existingPlayerData.battleAttackCount);
    const canDecrease =
      existingPlayerData.battleAttackLimit > 3 &&
      occupiedBattleAttackCount <= existingPlayerData.battleAttackLimit - 3;
    await confirmExtraBattleAttacks(
      interaction,
      options,
      {
        ...baseRequest,
        member,
        displayNamesByUserId,
      },
      existingPlayerData.battleAttackLimit,
      canDecrease,
    );
    return;
  }

  await options.memberService.add({
    ...baseRequest,
    ...(member ? { member } : {}),
    ...(roleMembers ? { role: { members: roleMembers } } : {}),
    displayNamesByUserId,
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

  const baseRequest = await createMemberBaseRequest(interaction, options);
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
  router.registerButtonHandler(/^add-extra-attacks:/u, async () => {
    // Handled by the confirmation message collector.
  });
  router.registerChatInputCommand("メンバー削除", async (interaction) => {
    await handleRemoveCommand(interaction, options);
  });
  router.registerChatInputCommand("remove", async (interaction) => {
    await handleRemoveCommand(interaction, options);
  });
}
