import type { ActionRowBuilder, EmbedBuilder, MessageActionRowComponentBuilder } from "discord.js";

import type { ClanData } from "../domain/clan-data.js";
import { createProgressActionComponents } from "../discord/progress-action-buttons.js";
import { renderProgressEmbed } from "../renderers/progress-renderer.js";
import { renderSummaryOverviewEmbed } from "../renderers/summary-overview-renderer.js";
import type {
  BossMessageIds,
  ProgressMessageIdRepository,
  SummaryMessageIdRepository,
} from "../repositories/sqlite/boss-message-id-repository.js";
import type { ClanRepository } from "../repositories/sqlite/clan-repository.js";
import { runInTransaction } from "../repositories/sqlite/db.js";
import type { SqliteDatabase } from "../repositories/sqlite/db.js";
import type { ClanBattleDayGuardResult } from "../shared/date-guard.js";
import type { Logger } from "../shared/logger.js";
import type { Clock } from "../shared/time.js";
import { retryDeleteDiscordMessage, retryEditDiscordMessage } from "./discord-message-retry.js";
import { buildRemainAttackEmbed, sendRemainAttackMessage } from "./remain-attack-message.js";
import {
  collectTrackedSummaryMessages,
  createSummaryOverviewMessageIds,
  findCurrentSummaryOverviewMessage,
  hasLegacySummaryMirrorTracking,
  resolveSummaryOverviewStorageLap,
} from "./summary-overview-tracking.js";

export interface AttackServiceMessageCoordinatorOptions {
  database: SqliteDatabase;
  clanRepository: ClanRepository;
  progressMessageIdRepository: ProgressMessageIdRepository;
  summaryMessageIdRepository: SummaryMessageIdRepository;
  clock: Clock;
  logger: Logger;
  redrawRetryDelayMs: number;
}

export interface AttackServiceMessageMember {
  id: string;
  displayName: string;
}

export interface AttackServiceEditableMessage {
  readonly id: string;
  edit(payload: {
    embeds?: readonly EmbedBuilder[];
    components?: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[];
  }): Promise<void>;
  delete?(): Promise<void>;
}

export interface AttackServiceCreatedMessage extends AttackServiceEditableMessage {
  addReaction(emoji: string): Promise<void>;
}

export interface AttackServiceSendPayload {
  content?: string;
  embeds?: readonly EmbedBuilder[];
  components?: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

export interface AttackServiceTextChannel {
  readonly id: string;
  fetchMessage(messageId: string): Promise<AttackServiceEditableMessage>;
  sendMessage(payload: AttackServiceSendPayload): Promise<AttackServiceCreatedMessage>;
}

export interface AttackServiceDiscordGateway {
  getTextChannel(channelId: string): Promise<AttackServiceTextChannel>;
}

export interface AttackServiceRenderRequest {
  member: AttackServiceMessageMember;
  discordGateway: AttackServiceDiscordGateway;
  displayNamesByUserId?: ReadonlyMap<string, string>;
  resolveDisplayNamesByUserIds?: (
    userIds: Iterable<string>,
  ) => Promise<ReadonlyMap<string, string>>;
  currentProgressMessage?: AttackServiceEditableMessage;
}

interface AttackServiceCleanupContext {
  lap: number;
  bossIndex: number;
}

interface MessageUpdateResult {
  updated: boolean;
  missing: boolean;
}

function createBossSlots(): BossMessageIds {
  return [null, null, null, null, null];
}

function cloneDisplayNamesMap(
  displayNamesByUserId: ReadonlyMap<string, string> | undefined,
): Map<string, string> {
  return new Map(displayNamesByUserId ?? []);
}

function collectProgressDisplayNameUserIds(
  clanData: ClanData,
  lap: number,
  bossIndex: number,
): string[] {
  const attackPlayers = clanData.bossStatusByLap.get(lap)?.[bossIndex]?.attackPlayers ?? [];
  return attackPlayers.map((attackStatus) => attackStatus.playerData.userId);
}

function createProgressMessageComponentsForBoss(
  clanData: ClanData,
  lap: number,
  bossIndex: number,
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  return createProgressActionComponents({
    interactive: !(clanData.bossStatusByLap.get(lap)?.[bossIndex]?.beated ?? false),
  });
}

function hasAnyMessageIds(messageIds: readonly (string | null)[] | undefined): boolean {
  return messageIds?.some((messageId) => messageId !== null) ?? false;
}

export class AttackServiceMessageCoordinator {
  constructor(private readonly options: AttackServiceMessageCoordinatorOptions) {}

  async cleanupGeneratedNextLapState(
    clanData: ClanData,
    context: AttackServiceCleanupContext,
    request: AttackServiceRenderRequest,
  ): Promise<void> {
    const nextLap = context.lap + 1;
    const bossIndex = context.bossIndex;

    await this.clearProgressMessageSlot(clanData, nextLap, bossIndex, request);
  }

  async updateProgressMessages(
    clanData: ClanData,
    lap: number,
    bossIndex: number,
    request: AttackServiceRenderRequest,
  ): Promise<void> {
    const displayNamesByUserId = await this.resolveDisplayNamesForUserIds(
      request,
      collectProgressDisplayNameUserIds(clanData, lap, bossIndex),
    );

    const embed = renderProgressEmbed({
      clanData,
      lap,
      bossIndex,
      displayNamesByUserId,
    });

    await this.updateProgressMessage(clanData, lap, bossIndex, embed, request);
  }

  async ensureProgressMessage(
    clanData: ClanData,
    lap: number,
    bossIndex: number,
    request: AttackServiceRenderRequest,
  ): Promise<void> {
    const displayNamesByUserId = await this.resolveDisplayNamesForUserIds(
      request,
      collectProgressDisplayNameUserIds(clanData, lap, bossIndex),
    );

    let bossChannel: AttackServiceTextChannel;
    try {
      bossChannel = await request.discordGateway.getTextChannel(clanData.bossChannelIds[bossIndex]!);
    } catch (error) {
      this.options.logger.warn("Failed to resolve boss channel for progress creation", {
        categoryId: clanData.categoryId,
        lap,
        bossIndex,
        error,
      });
      return;
    }

    const progressEmbed = renderProgressEmbed({
      clanData,
      lap,
      bossIndex,
      displayNamesByUserId,
    });

    try {
      const progressMessage = await bossChannel.sendMessage({
        embeds: [progressEmbed],
        components: createProgressMessageComponentsForBoss(clanData, lap, bossIndex),
      });

      const hadProgressRow = clanData.progressMessageIdsByLap.has(lap);
      const progressMessageIds = clanData.progressMessageIdsByLap.get(lap) ?? createBossSlots();
      progressMessageIds[bossIndex] = progressMessage.id;
      clanData.progressMessageIdsByLap.set(lap, progressMessageIds);

      runInTransaction(this.options.database, () => {
        if (hadProgressRow) {
          this.options.progressMessageIdRepository.update(clanData.categoryId, lap, progressMessageIds);
        } else {
          this.options.progressMessageIdRepository.insert(clanData.categoryId, lap, progressMessageIds);
        }
      });
    } catch (error) {
      this.options.logger.warn("Failed to create progress message", {
        categoryId: clanData.categoryId,
        lap,
        bossIndex,
        error,
      });
    }
  }

  async updateRemainAttackMessage(
    clanData: ClanData,
    request: AttackServiceRenderRequest,
  ): Promise<void> {
    if (!clanData.remainAttackMessageId) {
      await this.createCurrentRemainAttackMessage(clanData, request);
      return;
    }

    const displayNamesByUserId = await this.resolveDisplayNamesForUserIds(
      request,
      clanData.playerDataMap.keys(),
    );

    const embed = buildRemainAttackEmbed(clanData, displayNamesByUserId, this.options.clock);

    let remainAttackChannel: AttackServiceTextChannel;
    try {
      remainAttackChannel = await request.discordGateway.getTextChannel(clanData.remainAttackChannelId);
    } catch (error) {
      this.options.logger.warn("Failed to resolve remain-attack channel for redraw", {
        categoryId: clanData.categoryId,
        error,
      });
      return;
    }

    const result = await this.editMessageWithRetry(
      remainAttackChannel,
      clanData.remainAttackMessageId,
      embed,
      [],
      "remain-attack",
      clanData.categoryId,
    );

    if (!result.updated && result.missing) {
      clanData.remainAttackMessageId = null;
      runInTransaction(this.options.database, () => {
        this.options.clanRepository.update(clanData);
      });
      await this.createCurrentRemainAttackMessage(clanData, request);
    }
  }

  async ensureCurrentRemainAttackMessage(
    clanData: ClanData | undefined,
    dayGuardResult: ClanBattleDayGuardResult | null,
    request: AttackServiceRenderRequest,
  ): Promise<void> {
    if (
      !clanData ||
      (!dayGuardResult?.shouldCreateRemainAttackMessage && clanData.remainAttackMessageId)
    ) {
      return;
    }

    await this.createCurrentRemainAttackMessage(clanData, request);
  }

  async ensureCurrentSummaryMessage(
    clanData: ClanData | undefined,
    dayGuardResult: ClanBattleDayGuardResult | null,
    request: AttackServiceRenderRequest,
  ): Promise<void> {
    if (!clanData) {
      return;
    }

    if (
      !dayGuardResult?.changed &&
      !hasLegacySummaryMirrorTracking(clanData) &&
      findCurrentSummaryOverviewMessage(clanData)
    ) {
      return;
    }

    await this.cleanupLegacySummaryMirrorsIfNeeded(clanData, request);

    if (findCurrentSummaryOverviewMessage(clanData)) {
      return;
    }

    await this.createSummaryMessage(clanData, request);
  }

  private async clearProgressMessageSlot(
    clanData: ClanData,
    lap: number,
    bossIndex: number,
    request: AttackServiceRenderRequest,
  ): Promise<void> {
    const messageIds = clanData.progressMessageIdsByLap.get(lap);
    const messageId = messageIds?.[bossIndex];

    if (messageId) {
      try {
        const bossChannel = await request.discordGateway.getTextChannel(clanData.bossChannelIds[bossIndex]!);
        await this.deleteMessageWithRetry(
          bossChannel,
          messageId,
          "progress",
          clanData.categoryId,
          lap,
          bossIndex,
        );
      } catch (error) {
        this.options.logger.warn("Failed to resolve boss channel for progress cleanup", {
          categoryId: clanData.categoryId,
          lap,
          bossIndex,
          error,
        });
      }
    }

    if (!messageIds) {
      return;
    }

    messageIds[bossIndex] = null;
    if (hasAnyMessageIds(messageIds)) {
      this.options.progressMessageIdRepository.update(clanData.categoryId, lap, messageIds);
      return;
    }

    clanData.progressMessageIdsByLap.delete(lap);
    this.options.progressMessageIdRepository.deleteByLap(clanData.categoryId, lap);
  }

  private async updateProgressMessage(
    clanData: ClanData,
    lap: number,
    bossIndex: number,
    embed: EmbedBuilder,
    request: AttackServiceRenderRequest,
  ): Promise<void> {
    const progressMessageId = clanData.progressMessageIdsByLap.get(lap)?.[bossIndex];
    if (!progressMessageId) {
      await this.ensureProgressMessage(clanData, lap, bossIndex, request);
      return;
    }

    const components = createProgressMessageComponentsForBoss(clanData, lap, bossIndex);
    const editedDirectly = await this.tryEditCurrentProgressMessage(
      request,
      progressMessageId,
      embed,
      components,
      clanData.categoryId,
      lap,
      bossIndex,
    );
    if (editedDirectly) {
      return;
    }

    let bossChannel: AttackServiceTextChannel;
    try {
      bossChannel = await request.discordGateway.getTextChannel(clanData.bossChannelIds[bossIndex]!);
    } catch (error) {
      this.options.logger.warn("Failed to resolve boss channel for progress redraw", {
        categoryId: clanData.categoryId,
        lap,
        bossIndex,
        error,
      });
      return;
    }

    const result = await this.editMessageWithRetry(
      bossChannel,
      progressMessageId,
      embed,
      components,
      "progress",
      clanData.categoryId,
      lap,
      bossIndex,
    );

    if (!result.updated && result.missing) {
      await this.ensureProgressMessage(clanData, lap, bossIndex, request);
    }
  }

  async updateSummaryMessage(
    clanData: ClanData,
    request: AttackServiceRenderRequest,
  ): Promise<void> {
    await this.cleanupLegacySummaryMirrorsIfNeeded(clanData, request);

    const trackedSummary = findCurrentSummaryOverviewMessage(clanData);
    if (!trackedSummary) {
      await this.createSummaryMessage(clanData, request);
      return;
    }

    let summaryChannel: AttackServiceTextChannel;
    try {
      summaryChannel = await request.discordGateway.getTextChannel(clanData.summaryChannelId);
    } catch (error) {
      this.options.logger.warn("Failed to resolve summary channel for redraw", {
        categoryId: clanData.categoryId,
        error,
      });
      return;
    }

    const result = await this.editMessageWithRetry(
      summaryChannel,
      trackedSummary.messageId,
      renderSummaryOverviewEmbed(clanData),
      undefined,
      "summary",
      clanData.categoryId,
      trackedSummary.lap,
      0,
    );

    if (!result.updated && result.missing) {
      clanData.summaryMessageIdsByLap = new Map();
      runInTransaction(this.options.database, () => {
        this.options.summaryMessageIdRepository.deleteAllByCategory(clanData.categoryId);
      });
      await this.createSummaryMessage(clanData, request);
    }
  }

  private async cleanupLegacySummaryMirrorsIfNeeded(
    clanData: ClanData,
    request: AttackServiceRenderRequest,
  ): Promise<void> {
    if (!hasLegacySummaryMirrorTracking(clanData)) {
      return;
    }

    let summaryChannel: AttackServiceTextChannel;
    try {
      summaryChannel = await request.discordGateway.getTextChannel(clanData.summaryChannelId);
    } catch (error) {
      this.options.logger.warn("Failed to resolve summary channel for legacy cleanup", {
        categoryId: clanData.categoryId,
        error,
      });
      return;
    }

    for (const trackedSummary of collectTrackedSummaryMessages(clanData)) {
      await this.deleteMessageWithRetry(
        summaryChannel,
        trackedSummary.messageId,
        "summary",
        clanData.categoryId,
        trackedSummary.lap,
        trackedSummary.bossIndex,
      );
    }

    clanData.summaryMessageIdsByLap = new Map();
    runInTransaction(this.options.database, () => {
      this.options.summaryMessageIdRepository.deleteAllByCategory(clanData.categoryId);
    });
  }

  private async createSummaryMessage(
    clanData: ClanData,
    request: AttackServiceRenderRequest,
  ): Promise<void> {
    let summaryChannel: AttackServiceTextChannel;
    try {
      summaryChannel = await request.discordGateway.getTextChannel(clanData.summaryChannelId);
    } catch (error) {
      this.options.logger.warn("Failed to resolve summary channel for creation", {
        categoryId: clanData.categoryId,
        error,
      });
      return;
    }

    try {
      const summaryMessage = await summaryChannel.sendMessage({
        embeds: [renderSummaryOverviewEmbed(clanData)],
      });

      const storageLap = resolveSummaryOverviewStorageLap(clanData);
      const messageIds = createSummaryOverviewMessageIds(summaryMessage.id);
      const hadSummaryRow = clanData.summaryMessageIdsByLap.has(storageLap);
      clanData.summaryMessageIdsByLap.set(storageLap, messageIds);

      runInTransaction(this.options.database, () => {
        if (hadSummaryRow) {
          this.options.summaryMessageIdRepository.update(clanData.categoryId, storageLap, messageIds);
        } else {
          this.options.summaryMessageIdRepository.insert(clanData.categoryId, storageLap, messageIds);
        }
      });
    } catch (error) {
      this.options.logger.warn("Failed to create summary message", {
        categoryId: clanData.categoryId,
        error,
      });
    }
  }

  private async createCurrentRemainAttackMessage(
    clanData: ClanData,
    request: AttackServiceRenderRequest,
  ): Promise<void> {
    const displayNamesByUserId = await this.resolveDisplayNamesForUserIds(
      request,
      clanData.playerDataMap.keys(),
    );

    let remainAttackChannel: AttackServiceTextChannel;
    try {
      remainAttackChannel = await request.discordGateway.getTextChannel(clanData.remainAttackChannelId);
    } catch (error) {
      this.options.logger.warn("Failed to resolve remain-attack channel for current message creation", {
        categoryId: clanData.categoryId,
        error,
      });
      return;
    }

    try {
      const remainAttackMessage = await sendRemainAttackMessage(
        remainAttackChannel,
        clanData,
        displayNamesByUserId,
        this.options.clock,
      );
      clanData.remainAttackMessageId = remainAttackMessage.messageId;
      if (!remainAttackMessage.taskKillReactionAdded) {
        this.options.logger.warn("Failed to add task-kill reaction to remain-attack message", {
          categoryId: clanData.categoryId,
          messageId: remainAttackMessage.messageId,
          error: remainAttackMessage.taskKillReactionError,
        });
      }
    } catch (error) {
      this.options.logger.warn("Failed to create remain-attack message", {
        categoryId: clanData.categoryId,
        error,
      });
      return;
    }

    runInTransaction(this.options.database, () => {
      this.options.clanRepository.update(clanData);
    });
  }

  private async editMessageWithRetry(
    channel: AttackServiceTextChannel,
    messageId: string,
    embed: EmbedBuilder,
    components:
      | readonly ActionRowBuilder<MessageActionRowComponentBuilder>[]
      | undefined,
    kind: "progress" | "summary" | "remain-attack",
    categoryId: string,
    lap?: number,
    bossIndex?: number,
  ): Promise<MessageUpdateResult> {
    const result = await retryEditDiscordMessage({
      channel,
      messageId,
      payload: {
        embeds: [embed],
        ...(components !== undefined ? { components } : {}),
      },
      retryDelayMs: this.options.redrawRetryDelayMs,
    });

    if (!result.success) {
      this.options.logger.warn("Failed to redraw Discord message", {
        categoryId,
        kind,
        lap,
        bossIndex,
        messageId,
        missing: result.missing,
        error: result.error,
      });
    }

    return {
      updated: result.success,
      missing: result.missing,
    };
  }

  private async deleteMessageWithRetry(
    channel: AttackServiceTextChannel,
    messageId: string,
    kind: "progress" | "summary",
    categoryId: string,
    lap: number,
    bossIndex: number,
  ): Promise<void> {
    const result = await retryDeleteDiscordMessage({
      channel,
      messageId,
      retryDelayMs: this.options.redrawRetryDelayMs,
    });

    if (result.success) {
      return;
    }

    if (result.deleteUnsupported) {
      this.options.logger.warn("Fetched Discord message does not support deletion", {
        categoryId,
        kind,
        lap,
        bossIndex,
        messageId,
      });
      return;
    }

    this.options.logger.warn("Failed to delete Discord message", {
      categoryId,
      kind,
      lap,
      bossIndex,
      messageId,
      missing: result.missing,
      error: result.error,
    });
  }

  private async tryEditCurrentProgressMessage(
    request: AttackServiceRenderRequest,
    progressMessageId: string,
    embed: EmbedBuilder,
    components: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[],
    categoryId: string,
    lap: number,
    bossIndex: number,
  ): Promise<boolean> {
    if (request.currentProgressMessage?.id !== progressMessageId) {
      return false;
    }

    try {
      await request.currentProgressMessage.edit({
        embeds: [embed],
        components,
      });
      return true;
    } catch (error) {
      this.options.logger.debug("Direct progress message edit failed; falling back to fetch/edit", {
        categoryId,
        lap,
        bossIndex,
        messageId: progressMessageId,
        error,
      });
      return false;
    }
  }

  private async resolveDisplayNamesForUserIds(
    request: AttackServiceRenderRequest,
    userIds: Iterable<string>,
  ): Promise<Map<string, string>> {
    const displayNamesByUserId = cloneDisplayNamesMap(request.displayNamesByUserId);
    displayNamesByUserId.set(request.member.id, request.member.displayName);

    if (!request.resolveDisplayNamesByUserIds) {
      return displayNamesByUserId;
    }

    const missingUserIds = [...new Set(userIds)].filter((userId) => !displayNamesByUserId.has(userId));
    if (missingUserIds.length === 0) {
      return displayNamesByUserId;
    }

    const resolvedDisplayNames = await request.resolveDisplayNamesByUserIds(missingUserIds);
    for (const [userId, displayName] of resolvedDisplayNames.entries()) {
      displayNamesByUserId.set(userId, displayName);
    }

    return displayNamesByUserId;
  }
}
