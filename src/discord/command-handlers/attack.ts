import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";

import { ProgressAction, parseProgressActionButtonCustomId } from "../progress-action-buttons.js";
import {
  AttackEntryKind,
  AttackEntryStatus,
  type AttackEntry,
} from "../../domain/attack-entry.js";
import { ATTACK_TYPE_INPUTS } from "../../domain/attack-type.js";
import type { ClanData } from "../../domain/clan-data.js";
import { OperationLogType, type OperationLog } from "../../domain/operation-log.js";
import { OperationType } from "../../domain/operation-type.js";
import type { PlayerData } from "../../domain/player-data.js";
import type { AttackEditableMessage, AttackEntrySelector, AttackService } from "../../services/attack-service.js";
import {
  ATTACK_NOT_DECLARED_MESSAGE,
  MESSAGE_DAMAGE_ALL_ATTACKS_CONSUMED_MESSAGE,
} from "../../services/attack-service-support.js";
import type { MemberService } from "../../services/member-service.js";
import type { ProgressMessageService } from "../../services/progress-message-service.js";
import type { RuntimeStateService } from "../../services/runtime-state-service.js";
import { createChannelCarryOverSelector } from "../carryover-selector.js";
import type { InteractionRouter } from "../interaction-router.js";
import {
  DiscordGuildTextGateway,
  SlashResponseChannelAdapter,
  deferChatInputReply,
  resolveCachedGuildDisplayNames,
  resolveGuildDisplayNamesForUserIds,
  resolveManagedInteractionContext,
  resolveMemberIdentity,
} from "./shared.js";

const TRANSIENT_INTERACTION_MESSAGE_DELETE_AFTER_MS = 15_000;
const ATTACK_ENTRY_SELECTION_TIMEOUT_MS = 60_000;
const ATTACK_ENTRY_SELECTION_PREFIX = "attack-entry-select";
const ADMIN_CORRECT_ATTACK_KIND_PERMISSION_ERROR =
  "このコマンドはサーバー管理権限があるメンバーのみ使えます";

export interface AttackCommandHandlersOptions {
  attackService: Pick<
    AttackService,
    "declare" | "finish" | "defeatBoss" | "undo" | "correctAttackKind"
  >;
  progressMessageService: Pick<ProgressMessageService, "resend">;
  runtimeStateService: Pick<RuntimeStateService, "get" | "ensureDateUpToDate"> &
    Partial<Pick<RuntimeStateService, "getOperationLogs" | "getPlayerResourceState">>;
  memberService: Pick<MemberService, "ensureCurrentRemainAttackMessage">;
}

interface AttackCommandContext {
  categoryId: string;
  commandChannelId: string;
  responseChannel: SlashResponseChannelAdapter;
  discordGateway: DiscordGuildTextGateway;
  displayNamesByUserId: ReadonlyMap<string, string>;
}

export function createSlashCarryOverSelector(
  interaction: ChatInputCommandInteraction,
) {
  return createChannelCarryOverSelector(interaction.channel, interaction.user.id, interaction.id);
}

type AttackEntrySelectionChannel = {
  send(payload: {
    content?: string;
    components?: readonly ActionRowBuilder<ButtonBuilder>[];
  }): Promise<Pick<Message, "awaitMessageComponent" | "delete">>;
};

function canSendToAttackEntrySelectionChannel(
  channel: unknown,
): channel is AttackEntrySelectionChannel {
  return Boolean(channel && typeof channel === "object" && "send" in channel && typeof channel.send === "function");
}

function formatAttackEntryKindLabel(kind: AttackEntryKind): string {
  return kind === AttackEntryKind.BATTLE ? "本戦" : "持越";
}

function formatAttackEntryStatusLabel(status: AttackEntryStatus): string {
  switch (status) {
    case AttackEntryStatus.DECLARED:
      return "未確定";
    case AttackEntryStatus.FINISHED:
      return "削り確定";
    case AttackEntryStatus.DEFEATED:
      return "討伐確定";
    default:
      return status;
  }
}

function buildAttackEntrySelectionContent(attackEntries: readonly AttackEntry[]): string {
  return attackEntries
    .map((attackEntry, index) => {
      const damageText = attackEntry.damage === null ? "" : ` / ${attackEntry.damage.toLocaleString()}`;
      return `${index + 1}: ${formatAttackEntryStatusLabel(attackEntry.status)} / ${formatAttackEntryKindLabel(attackEntry.kind)}${damageText}`;
    })
    .join("\n");
}

function createAttackEntrySelectionRows(
  customIdPrefix: string,
  attackEntries: readonly AttackEntry[],
): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  for (let index = 0; index < attackEntries.length; index += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (let offset = 0; offset < 5 && index + offset < attackEntries.length; offset += 1) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`${customIdPrefix}:${index + offset}`)
          .setLabel(String(index + offset + 1))
          .setStyle(ButtonStyle.Primary),
      );
    }
    rows.push(row);
  }

  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${customIdPrefix}:cancel`)
        .setLabel("キャンセル")
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  return rows;
}

async function deleteSelectionMessageQuietly(message: Pick<Message, "delete">): Promise<void> {
  try {
    await message.delete();
  } catch {
    // Ignore cleanup failures for selector messages.
  }
}

function parseAttackEntrySelection(
  customId: string,
  customIdPrefix: string,
  attackEntries: readonly AttackEntry[],
): string | null {
  if (!customId.startsWith(`${customIdPrefix}:`)) {
    return null;
  }

  const suffix = customId.slice(customIdPrefix.length + 1);
  if (suffix === "cancel") {
    return null;
  }

  const selectedIndex = Number.parseInt(suffix, 10);
  if (Number.isNaN(selectedIndex)) {
    return null;
  }

  return attackEntries[selectedIndex]?.attackEntryId ?? null;
}

export function createSlashAttackEntrySelector(
  interaction: ChatInputCommandInteraction,
): AttackEntrySelector {
  return async ({ attackEntries }) => {
    if (!canSendToAttackEntrySelectionChannel(interaction.channel)) {
      return null;
    }

    const customIdPrefix = `${ATTACK_ENTRY_SELECTION_PREFIX}:${interaction.id}:${Date.now()}`;
    const selectionMessage = await interaction.channel.send({
      content: buildAttackEntrySelectionContent(attackEntries),
      components: createAttackEntrySelectionRows(customIdPrefix, attackEntries),
    });

    try {
      const selection = await selectionMessage.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: ATTACK_ENTRY_SELECTION_TIMEOUT_MS,
        filter: (buttonInteraction: ButtonInteraction) =>
          buttonInteraction.user.id === interaction.user.id &&
          buttonInteraction.customId.startsWith(`${customIdPrefix}:`),
      });

      await selection.deferUpdate();
      return parseAttackEntrySelection(selection.customId, customIdPrefix, attackEntries);
    } catch {
      return null;
    } finally {
      await deleteSelectionMessageQuietly(selectionMessage);
    }
  };
}

function getButtonCategoryId(interaction: ButtonInteraction): string | null {
  const channel = interaction.channel;
  if (!channel || !("parentId" in channel)) {
    return null;
  }

  return channel.parentId;
}

function hasPendingAttack(
  categoryId: string,
  userId: string,
  channelId: string,
  messageId: string,
  options: AttackCommandHandlersOptions,
): {
  bossIndex: number;
  lap: number;
} | null {
  const clanData = options.runtimeStateService.get(categoryId);
  if (!clanData) {
    return null;
  }

  const bossIndex = clanData.getBossIndexFromChannelId(channelId);
  if (bossIndex === undefined) {
    return null;
  }

  const lap = clanData.getLapFromMessageId(messageId, bossIndex);
  if (lap === undefined) {
    return null;
  }

  const playerData = clanData.getPlayerData(userId);
  const attackPlayers = clanData.bossStatusByLap.get(lap)?.[bossIndex]?.attackPlayers ?? [];
  const pendingAttack = attackPlayers.some(
    (attackStatus) => attackStatus.playerData.userId === playerData?.userId && !attackStatus.attacked,
  );

  if (!pendingAttack) {
    return null;
  }

  return {
    bossIndex,
    lap,
  };
}

function formatNoPendingAttackButtonMessage(
  clanData: ClanData,
  playerData: PlayerData,
  options: AttackCommandHandlersOptions,
): string {
  const playerResourceState = options.runtimeStateService.getPlayerResourceState?.(
    clanData.categoryId,
    playerData.userId,
    clanData.date,
  );
  const occupiedBattleCount =
    (playerResourceState?.battleReservedCount ?? 0) +
    (playerResourceState?.battleConsumedCount ?? playerData.battleAttackCount);
  const remainingBattleCount = Math.max(0, 3 - occupiedBattleCount);
  const carryAvailableCount =
    playerResourceState?.carryAvailableCount ?? playerData.carryOverList.length;

  if (remainingBattleCount === 0 && carryAvailableCount === 0) {
    return MESSAGE_DAMAGE_ALL_ATTACKS_CONSUMED_MESSAGE;
  }

  return ATTACK_NOT_DECLARED_MESSAGE;
}

function matchesUndoLogFromProgressContext(
  logData: { operationType: OperationType; lap: number; bossIndex: number },
  context: { lap: number; bossIndex: number },
): boolean {
  if (logData.bossIndex === context.bossIndex && logData.lap === context.lap) {
    return true;
  }

  return (
    logData.operationType === OperationType.LAST_ATTACK &&
    logData.bossIndex === context.bossIndex &&
    logData.lap + 1 === context.lap
  );
}

function matchesUndoOperationFromProgressContext(
  operationLog: Pick<OperationLog, "operationType" | "lap" | "bossIndex">,
  context: { lap: number; bossIndex: number },
): boolean {
  if (operationLog.bossIndex === context.bossIndex && operationLog.lap === context.lap) {
    return true;
  }

  return (
    operationLog.operationType === OperationLogType.DEFEAT &&
    operationLog.bossIndex === context.bossIndex &&
    operationLog.lap + 1 === context.lap
  );
}

function findLatestUndoableLogForBoss(
  logList: readonly { operationType: OperationType; lap: number; bossIndex: number }[],
  bossIndex: number,
):
  | {
      operationType: OperationType;
      lap: number;
      bossIndex: number;
    }
  | null {
  for (let index = logList.length - 1; index >= 0; index -= 1) {
    const logData = logList[index];
    if (!logData || logData.bossIndex !== bossIndex) {
      continue;
    }

    if (
      logData.operationType !== OperationType.ATTACK_DECLAR &&
      logData.operationType !== OperationType.ATTACK &&
      logData.operationType !== OperationType.LAST_ATTACK
    ) {
      continue;
    }

    return logData;
  }

  return null;
}

function isUndoableOperationLog(
  operationLog: Pick<OperationLog, "operationType">,
): boolean {
  return (
    operationLog.operationType === OperationLogType.DECLARE ||
    operationLog.operationType === OperationLogType.FINISH ||
    operationLog.operationType === OperationLogType.DEFEAT
  );
}

function getUndoOperationLogPrecedence(operationType: OperationLogType): number {
  switch (operationType) {
    case OperationLogType.DECLARE:
      return 0;
    case OperationLogType.FINISH:
      return 1;
    case OperationLogType.DEFEAT:
      return 2;
    default:
      return -1;
  }
}

function compareOperationLogsNewestFirst(
  left: Pick<OperationLog, "occurredAt" | "operationId" | "operationType">,
  right: Pick<OperationLog, "occurredAt" | "operationId" | "operationType">,
): number {
  const occurredAtDiff = right.occurredAt.getTime() - left.occurredAt.getTime();
  if (occurredAtDiff !== 0) {
    return occurredAtDiff;
  }

  const precedenceDiff =
    getUndoOperationLogPrecedence(right.operationType) -
    getUndoOperationLogPrecedence(left.operationType);
  if (precedenceDiff !== 0) {
    return precedenceDiff;
  }

  return right.operationId.localeCompare(left.operationId);
}

function findLatestUndoableOperationForBoss(
  operationLogs: readonly OperationLog[],
  userId: string,
  dayKey: string,
  bossIndex: number,
): OperationLog | null {
  return (
    operationLogs
      .filter(
        (operationLog) =>
          operationLog.userId === userId &&
          operationLog.dayKey === dayKey &&
          operationLog.bossIndex === bossIndex &&
          operationLog.invalidatedAt === null &&
          isUndoableOperationLog(operationLog),
      )
      .sort(compareOperationLogsNewestFirst)[0] ?? null
  );
}

function canDeleteMessageResponse(response: unknown): response is Pick<Message, "delete"> {
  return (
    typeof response === "object" &&
    response !== null &&
    "delete" in response &&
    typeof response.delete === "function"
  );
}

async function sendEphemeralButtonMessage(
  interaction: ButtonInteraction,
  payload: { content?: string },
): Promise<unknown> {
  const normalizedPayload = {
    content: payload.content ?? "",
    ephemeral: true,
  };

  if (interaction.deferred || interaction.replied) {
    return interaction.followUp(normalizedPayload);
  }

  return interaction.reply({
    ...normalizedPayload,
    fetchReply: true,
  });
}

function scheduleEphemeralButtonMessageDeletion(response: unknown, deleteAfterMs: number): void {
  if (!canDeleteMessageResponse(response)) {
    return;
  }

  setTimeout(() => {
    void response.delete().catch(() => {});
  }, deleteAfterMs);
}

function createButtonResponseChannel(interaction: ButtonInteraction) {
  return {
    async send(payload: { content?: string }) {
      const response = await sendEphemeralButtonMessage(interaction, payload);
      scheduleEphemeralButtonMessageDeletion(
        response,
        TRANSIENT_INTERACTION_MESSAGE_DELETE_AFTER_MS,
      );
    },
    async sendTransient(
      payload: { content?: string },
      deleteAfterMs = TRANSIENT_INTERACTION_MESSAGE_DELETE_AFTER_MS,
    ) {
      const response = await sendEphemeralButtonMessage(interaction, payload);
      scheduleEphemeralButtonMessageDeletion(response, deleteAfterMs);
    },
  };
}

function createSilentButtonResponseChannel(interaction: ButtonInteraction) {
  return {
    async send() {},
    async sendTransient(
      payload: { content?: string },
      deleteAfterMs = TRANSIENT_INTERACTION_MESSAGE_DELETE_AFTER_MS,
    ) {
      const response = await sendEphemeralButtonMessage(interaction, payload);
      scheduleEphemeralButtonMessageDeletion(response, deleteAfterMs);
    },
  };
}

function createCurrentButtonProgressMessage(
  interaction: ButtonInteraction,
): AttackEditableMessage {
  return {
    id: interaction.message.id,
    async edit(payload) {
      await interaction.message.edit({
        ...(payload.embeds ? { embeds: payload.embeds } : {}),
        ...(payload.components ? { components: payload.components } : {}),
      });
    },
    async delete() {
      await interaction.message.delete();
    },
  };
}

async function sendUndoMismatchWarning(
  interaction: ButtonInteraction,
  userId: string,
  lap: number,
  bossIndex: number,
  targetChannelId: string,
): Promise<void> {
  const channel = interaction.channel;
  if (!channel || !("send" in channel) || typeof channel.send !== "function") {
    return;
  }

  const sentMessage = await channel.send({
    content:
      `<@${userId}> すでに${lap}周目${bossIndex + 1}ボスに凸しています。\n` +
      `先に<#${targetChannelId}>で↩️を押してください`,
  });

  if ("delete" in sentMessage && typeof sentMessage.delete === "function") {
    setTimeout(() => {
      void sentMessage.delete().catch(() => {});
    }, 30_000);
  }
}

async function createAttackButtonContext(
  interaction: ButtonInteraction,
  options: AttackCommandHandlersOptions,
): Promise<{
  categoryId: string;
  lap: number;
  bossIndex: number;
  member: Awaited<ReturnType<typeof resolveMemberIdentity>>;
  discordGateway: DiscordGuildTextGateway;
  displayNamesByUserId: ReadonlyMap<string, string>;
  resolveDisplayNamesByUserIds: (
    userIds: Iterable<string>,
  ) => Promise<ReadonlyMap<string, string>>;
  currentProgressMessage: AttackEditableMessage;
} | null> {
  if (!interaction.guild) {
    return null;
  }

  const categoryId = getButtonCategoryId(interaction);
  if (!categoryId) {
    return null;
  }

  await options.runtimeStateService.ensureDateUpToDate(categoryId);

  const clanData = options.runtimeStateService.get(categoryId);
  if (!clanData) {
    return null;
  }

  const bossIndex = clanData.getBossIndexFromChannelId(interaction.channelId);
  if (bossIndex === undefined) {
    return null;
  }

  const lap = clanData.getLapFromMessageId(interaction.message.id, bossIndex);
  if (lap === undefined) {
    return null;
  }

  const member = await resolveMemberIdentity(interaction.guild, interaction.user);
  const displayNamesByUserId = new Map(
    [...resolveCachedGuildDisplayNames(interaction.guild)].filter(([userId]) =>
      clanData.playerDataMap.has(userId),
    ),
  );
  displayNamesByUserId.set(member.id, member.displayName);
  const discordGateway = new DiscordGuildTextGateway(interaction.guild);

  return {
    categoryId,
    lap,
    bossIndex,
    member,
    discordGateway,
    displayNamesByUserId,
    resolveDisplayNamesByUserIds: (userIds) =>
      resolveGuildDisplayNamesForUserIds(interaction.guild!, userIds),
    currentProgressMessage: createCurrentButtonProgressMessage(interaction),
  };
}

async function createAttackCommandContext(
  options: AttackCommandHandlersOptions,
  interaction: ChatInputCommandInteraction,
): Promise<AttackCommandContext> {
  if (!interaction.guild) {
    throw new Error("Guild interaction is required.");
  }

  const managedContext = await resolveManagedInteractionContext(interaction);
  const categoryId = managedContext.categoryId ?? interaction.channelId;
  const clanData = options.runtimeStateService.get(categoryId);
  return {
    categoryId,
    commandChannelId: managedContext.commandChannelId,
    responseChannel: new SlashResponseChannelAdapter(interaction, false),
    discordGateway: new DiscordGuildTextGateway(interaction.guild),
    displayNamesByUserId: clanData
      ? await resolveGuildDisplayNamesForUserIds(interaction.guild, clanData.playerDataMap.keys())
      : resolveCachedGuildDisplayNames(interaction.guild),
  };
}

async function resolveTargetMember(
  interaction: ChatInputCommandInteraction,
) {
  if (!interaction.guild) {
    throw new Error("Guild interaction is required.");
  }

  return resolveMemberIdentity(interaction.guild, interaction.options.getUser("member", true));
}

async function resolveActorMember(
  interaction: ChatInputCommandInteraction,
) {
  if (!interaction.guild) {
    throw new Error("Guild interaction is required.");
  }

  return resolveMemberIdentity(interaction.guild, interaction.user);
}

function hasManageGuildPermission(interaction: ChatInputCommandInteraction): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

export async function handleAttackDeclareCommand(
  interaction: ChatInputCommandInteraction,
  options: AttackCommandHandlersOptions,
): Promise<void> {
  await deferChatInputReply(interaction, false);

  const context = await createAttackCommandContext(options, interaction);
  const member = await resolveTargetMember(interaction);
  const lap = interaction.options.getInteger("lap");
  const bossNumber = interaction.options.getInteger("boss_number");

  await options.attackService.declare({
    ...context,
    channelId: context.commandChannelId,
    member,
    attackType: interaction.options.getString("attack_type", true),
    ...(lap !== null ? { lap } : {}),
    ...(bossNumber !== null ? { bossNumber } : {}),
  });
}

export async function handleAttackFinishCommand(
  interaction: ChatInputCommandInteraction,
  options: AttackCommandHandlersOptions,
): Promise<void> {
  await deferChatInputReply(interaction, false);

  const context = await createAttackCommandContext(options, interaction);
  const member = await resolveTargetMember(interaction);
  const lap = interaction.options.getInteger("lap");
  const bossNumber = interaction.options.getInteger("boss_number");
  const damage = interaction.options.getInteger("damage");

  await options.attackService.finish({
    ...context,
    channelId: context.commandChannelId,
    member,
    ...(lap !== null ? { lap } : {}),
    ...(bossNumber !== null ? { bossNumber } : {}),
    ...(damage !== null ? { damage } : {}),
  });
}

export async function handleDefeatBossCommand(
  interaction: ChatInputCommandInteraction,
  options: AttackCommandHandlersOptions,
): Promise<void> {
  await deferChatInputReply(interaction, false);

  const context = await createAttackCommandContext(options, interaction);
  const member = await resolveTargetMember(interaction);
  const lap = interaction.options.getInteger("lap");
  const bossNumber = interaction.options.getInteger("boss_number");

  await options.attackService.defeatBoss({
    ...context,
    channelId: context.commandChannelId,
    member,
    ...(lap !== null ? { lap } : {}),
    ...(bossNumber !== null ? { bossNumber } : {}),
  });
}

export async function handleUndoCommand(
  interaction: ChatInputCommandInteraction,
  options: AttackCommandHandlersOptions,
): Promise<void> {
  await deferChatInputReply(interaction, false);

  const context = await createAttackCommandContext(options, interaction);
  const member = await resolveTargetMember(interaction);
  const bossNumber = interaction.options.getInteger("boss_number");

  await options.attackService.undo({
    ...context,
    channelId: context.commandChannelId,
    member,
    ...(bossNumber !== null ? { bossNumber } : {}),
  });
}

export async function handleCorrectAttackKindCommand(
  interaction: ChatInputCommandInteraction,
  options: AttackCommandHandlersOptions,
): Promise<void> {
  await deferChatInputReply(interaction, false);

  const context = await createAttackCommandContext(options, interaction);
  const member = await resolveActorMember(interaction);

  await options.attackService.correctAttackKind({
    ...context,
    channelId: context.commandChannelId,
    member,
    lap: interaction.options.getInteger("lap", true),
    bossNumber: interaction.options.getInteger("boss_number", true),
    selectAttackEntry: createSlashAttackEntrySelector(interaction),
  });
}

export async function handleAdminCorrectAttackKindCommand(
  interaction: ChatInputCommandInteraction,
  options: AttackCommandHandlersOptions,
): Promise<void> {
  if (!hasManageGuildPermission(interaction)) {
    await interaction.reply({
      content: ADMIN_CORRECT_ATTACK_KIND_PERMISSION_ERROR,
      ephemeral: true,
    });
    return;
  }

  await deferChatInputReply(interaction, false);

  const context = await createAttackCommandContext(options, interaction);
  const member = await resolveTargetMember(interaction);

  await options.attackService.correctAttackKind({
    ...context,
    channelId: context.commandChannelId,
    member,
    lap: interaction.options.getInteger("lap", true),
    bossNumber: interaction.options.getInteger("boss_number", true),
    selectAttackEntry: createSlashAttackEntrySelector(interaction),
  });
}

export async function handleResendProgressMessageCommand(
  interaction: ChatInputCommandInteraction,
  options: AttackCommandHandlersOptions,
): Promise<void> {
  await deferChatInputReply(interaction, false);

  const context = await createAttackCommandContext(options, interaction);
  const lap = interaction.options.getInteger("lap");
  const bossNumber = interaction.options.getInteger("boss_number");

  await options.progressMessageService.resend({
    ...context,
    channelId: context.commandChannelId,
    ...(lap !== null ? { lap } : {}),
    ...(bossNumber !== null ? { bossNumber } : {}),
  });
}

export async function handleProgressActionButtonInteraction(
  interaction: ButtonInteraction,
  options: AttackCommandHandlersOptions,
): Promise<void> {
  const action = parseProgressActionButtonCustomId(interaction.customId);
  if (!action) {
    return;
  }

  await interaction.deferUpdate();

  const context = await createAttackButtonContext(interaction, options);
  if (!context) {
    return;
  }

  const clanData = options.runtimeStateService.get(context.categoryId);
  if (!clanData) {
    return;
  }

  const playerData = clanData.getPlayerData(context.member.id);
  if (!playerData) {
    return;
  }

  if (action === ProgressAction.BATTLE || action === ProgressAction.CARRYOVER) {
    const attackPlayers = clanData.bossStatusByLap.get(context.lap)?.[context.bossIndex]?.attackPlayers ?? [];
    const alreadyDeclared = attackPlayers.some(
      (attackStatus) => attackStatus.playerData.userId === playerData.userId && !attackStatus.attacked,
    );
    const attackType =
      action === ProgressAction.BATTLE
        ? ATTACK_TYPE_INPUTS.BATTLE
        : ATTACK_TYPE_INPUTS.CARRYOVER;

    if (!alreadyDeclared) {
      await options.attackService.declare({
        categoryId: context.categoryId,
        channelId: interaction.channelId,
        lap: context.lap,
        bossNumber: context.bossIndex + 1,
        attackType,
        member: context.member,
        responseChannel: createSilentButtonResponseChannel(interaction),
        discordGateway: context.discordGateway,
        displayNamesByUserId: context.displayNamesByUserId,
        resolveDisplayNamesByUserIds: context.resolveDisplayNamesByUserIds,
        currentProgressMessage: context.currentProgressMessage,
        deferNonProgressMessageUpdates: true,
      });
    }
    return;
  }

  if (action === ProgressAction.FINISH) {
    if (hasPendingAttack(context.categoryId, context.member.id, interaction.channelId, interaction.message.id, options)) {
      await options.attackService.finish({
        categoryId: context.categoryId,
        channelId: interaction.channelId,
        lap: context.lap,
        bossNumber: context.bossIndex + 1,
        member: context.member,
        responseChannel: createSilentButtonResponseChannel(interaction),
        discordGateway: context.discordGateway,
        displayNamesByUserId: context.displayNamesByUserId,
        resolveDisplayNamesByUserIds: context.resolveDisplayNamesByUserIds,
        currentProgressMessage: context.currentProgressMessage,
        deferNonProgressMessageUpdates: true,
      });
    } else {
      await createSilentButtonResponseChannel(interaction).sendTransient({
        content: formatNoPendingAttackButtonMessage(clanData, playerData, options),
      });
    }
    return;
  }

  if (action === ProgressAction.DEFEAT) {
    if (hasPendingAttack(context.categoryId, context.member.id, interaction.channelId, interaction.message.id, options)) {
      await options.attackService.defeatBoss({
        categoryId: context.categoryId,
        channelId: interaction.channelId,
        lap: context.lap,
        bossNumber: context.bossIndex + 1,
        member: context.member,
        responseChannel: createSilentButtonResponseChannel(interaction),
        discordGateway: context.discordGateway,
        displayNamesByUserId: context.displayNamesByUserId,
        resolveDisplayNamesByUserIds: context.resolveDisplayNamesByUserIds,
        currentProgressMessage: context.currentProgressMessage,
        deferNonProgressMessageUpdates: true,
      });
    } else {
      await createSilentButtonResponseChannel(interaction).sendTransient({
        content: formatNoPendingAttackButtonMessage(clanData, playerData, options),
      });
    }
    return;
  }

  const projectedOperationLogs = options.runtimeStateService.getOperationLogs?.(context.categoryId) ?? [];
  const operationLog = findLatestUndoableOperationForBoss(
    projectedOperationLogs,
    playerData.userId,
    clanData.date,
    context.bossIndex,
  );
  const logData =
    operationLog
      ? {
          operationType:
            operationLog.operationType === OperationLogType.DECLARE
              ? OperationType.ATTACK_DECLAR
              : operationLog.operationType === OperationLogType.FINISH
              ? OperationType.ATTACK
                : OperationType.LAST_ATTACK,
          lap: operationLog.lap,
          bossIndex: operationLog.bossIndex,
        }
      : projectedOperationLogs.length > 0
        ? null
        : findLatestUndoableLogForBoss(playerData.log, context.bossIndex);
  if (!logData) {
    return;
  }

  const matchesContext = operationLog
    ? matchesUndoOperationFromProgressContext(operationLog, context)
    : matchesUndoLogFromProgressContext(logData, context);
  if (matchesContext) {
    await options.attackService.undo({
      categoryId: context.categoryId,
      channelId: interaction.channelId,
      lap: context.lap,
      bossNumber: context.bossIndex + 1,
      member: context.member,
      responseChannel: createButtonResponseChannel(interaction),
      suppressSuccessResponse: true,
      discordGateway: context.discordGateway,
      displayNamesByUserId: context.displayNamesByUserId,
      resolveDisplayNamesByUserIds: context.resolveDisplayNamesByUserIds,
      currentProgressMessage: context.currentProgressMessage,
      deferNonProgressMessageUpdates: true,
    });
    return;
  }

  await sendUndoMismatchWarning(
    interaction,
    context.member.id,
    logData.lap,
    logData.bossIndex,
    clanData.bossChannelIds[logData.bossIndex] ?? interaction.channelId,
  );
}

export function registerAttackCommandHandlers(
  router: InteractionRouter,
  options: AttackCommandHandlersOptions,
): void {
  router.registerButtonHandler(/^carryover-select:/u, async () => {
    // Handled by awaitMessageComponent collectors; suppress router warnings.
  });
  router.registerButtonHandler(/^progress-action:/u, async (interaction) => {
    await handleProgressActionButtonInteraction(interaction, options);
  });
  router.registerChatInputCommand("代理凸宣言", async (interaction) => {
    await handleAttackDeclareCommand(interaction, options);
  });
  router.registerChatInputCommand("attack_declare", async (interaction) => {
    await handleAttackDeclareCommand(interaction, options);
  });
  router.registerChatInputCommand("代理削り", async (interaction) => {
    await handleAttackFinishCommand(interaction, options);
  });
  router.registerChatInputCommand("attack_fin", async (interaction) => {
    await handleAttackFinishCommand(interaction, options);
  });
  router.registerChatInputCommand("代理討伐", async (interaction) => {
    await handleDefeatBossCommand(interaction, options);
  });
  router.registerChatInputCommand("defeat_boss", async (interaction) => {
    await handleDefeatBossCommand(interaction, options);
  });
  router.registerChatInputCommand("代理戻る", async (interaction) => {
    await handleUndoCommand(interaction, options);
  });
  router.registerChatInputCommand("戻る", async (interaction) => {
    await handleUndoCommand(interaction, options);
  });
  router.registerChatInputCommand("undo", async (interaction) => {
    await handleUndoCommand(interaction, options);
  });
  router.registerChatInputCommand("本戦持越入れ替え", async (interaction) => {
    await handleCorrectAttackKindCommand(interaction, options);
  });
  router.registerChatInputCommand("correct_attack_kind", async (interaction) => {
    await handleCorrectAttackKindCommand(interaction, options);
  });
  router.registerChatInputCommand("本戦持越入れ替えメンバー指定", async (interaction) => {
    await handleAdminCorrectAttackKindCommand(interaction, options);
  });
  router.registerChatInputCommand("admin_correct_attack_kind", async (interaction) => {
    await handleAdminCorrectAttackKindCommand(interaction, options);
  });
  router.registerChatInputCommand("再送", async (interaction) => {
    await handleResendProgressMessageCommand(interaction, options);
  });
  router.registerChatInputCommand("resend", async (interaction) => {
    await handleResendProgressMessageCommand(interaction, options);
  });
  router.registerChatInputCommand("resend_progress_message", async (interaction) => {
    await handleResendProgressMessageCommand(interaction, options);
  });
}
