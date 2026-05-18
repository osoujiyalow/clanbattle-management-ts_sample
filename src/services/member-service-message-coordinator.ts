import type { ActionRowBuilder, EmbedBuilder, MessageActionRowComponentBuilder } from "discord.js";

import type { ClanData } from "../domain/clan-data.js";
import { createProgressActionComponents } from "../discord/progress-action-buttons.js";
import { renderProgressEmbed } from "../renderers/progress-renderer.js";
import { renderSummaryOverviewEmbed } from "../renderers/summary-overview-renderer.js";
import type {
  ProgressMessageIdRepository,
  SummaryMessageIdRepository,
} from "../repositories/sqlite/boss-message-id-repository.js";
import type { ClanRepository } from "../repositories/sqlite/clan-repository.js";
import { runInTransaction } from "../repositories/sqlite/db.js";
import type { SqliteDatabase } from "../repositories/sqlite/db.js";
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

export interface MemberServiceMessageCoordinatorOptions {
  database: SqliteDatabase;
  clanRepository: ClanRepository;
  progressMessageIdRepository: ProgressMessageIdRepository;
  summaryMessageIdRepository: SummaryMessageIdRepository;
  clock: Clock;
  logger: Logger;
  redrawRetryDelayMs: number;
}

export interface MemberServiceMessageActor {
  id: string;
  displayName: string;
}

export interface MemberServiceEditableMessage {
  readonly id: string;
  edit(payload: {
    embeds?: readonly EmbedBuilder[];
    components?: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[];
  }): Promise<void>;
  delete?(): Promise<void>;
}

export interface MemberServiceCreatedMessage {
  readonly id: string;
  addReaction(emoji: string): Promise<void>;
}

export interface MemberServiceTextChannel {
  readonly id: string;
  fetchMessage(messageId: string): Promise<MemberServiceEditableMessage>;
  sendMessage(payload: {
    content?: string;
    embeds?: readonly EmbedBuilder[];
    components?: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[];
  }): Promise<MemberServiceCreatedMessage>;
}

export interface MemberServiceDiscordGateway {
  getTextChannel(channelId: string): Promise<MemberServiceTextChannel>;
}

export interface MemberServiceRenderContext {
  actor: MemberServiceMessageActor;
  discordGateway: MemberServiceDiscordGateway;
  displayNamesByUserId?: ReadonlyMap<string, string>;
}

export interface MemberServiceProgressTarget {
  lap: number;
  bossIndex: number;
}

interface MessageUpdateResult {
  updated: boolean;
  missing: boolean;
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

function createBossSlots(): [string | null, string | null, string | null, string | null, string | null] {
  return [null, null, null, null, null];
}

function cloneDisplayNamesMap(
  displayNamesByUserId: ReadonlyMap<string, string> | undefined,
): Map<string, string> {
  return new Map(displayNamesByUserId ?? []);
}

function mergeDisplayName(
  displayNamesByUserId: Map<string, string>,
  member: MemberServiceMessageActor | undefined,
): void {
  if (!member) {
    return;
  }

  displayNamesByUserId.set(member.id, member.displayName);
}

export class MemberServiceMessageCoordinator {
  constructor(private readonly options: MemberServiceMessageCoordinatorOptions) {}

  async redrawProgressTargets(
    clanData: ClanData,
    targets: readonly MemberServiceProgressTarget[],
    displayNamesByUserId: ReadonlyMap<string, string>,
    discordGateway: MemberServiceDiscordGateway,
  ): Promise<void> {
    for (const target of targets) {
      await this.updateProgressMessage(clanData, target.lap, target.bossIndex, {
        actor: {
          id: "system",
          displayName: "system",
        },
        discordGateway,
        displayNamesByUserId,
      });
    }
  }

  async updateRemainAttackMessage(
    clanData: ClanData,
    request: MemberServiceRenderContext,
  ): Promise<void> {
    const displayNamesByUserId = cloneDisplayNamesMap(request.displayNamesByUserId);
    mergeDisplayName(displayNamesByUserId, request.actor);

    if (!clanData.remainAttackMessageId) {
      await this.createCurrentRemainAttackMessage(clanData, {
        ...request,
        displayNamesByUserId,
      });
      return;
    }

    let remainAttackChannel: MemberServiceTextChannel;
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
      buildRemainAttackEmbed(clanData, displayNamesByUserId, this.options.clock),
      [],
      "remain-attack",
      clanData.categoryId,
    );

    if (!result.updated && result.missing) {
      clanData.remainAttackMessageId = null;
      runInTransaction(this.options.database, () => {
        this.options.clanRepository.update(clanData);
      });
      await this.createCurrentRemainAttackMessage(clanData, {
        ...request,
        displayNamesByUserId,
      });
    }
  }

  async createCurrentRemainAttackMessage(
    clanData: ClanData,
    request: MemberServiceRenderContext,
  ): Promise<string | null> {
    let remainAttackChannel: MemberServiceTextChannel;
    try {
      remainAttackChannel = await request.discordGateway.getTextChannel(clanData.remainAttackChannelId);
    } catch (error) {
      this.options.logger.warn("Failed to resolve remain-attack channel", {
        categoryId: clanData.categoryId,
        error,
      });
      return null;
    }

    const displayNamesByUserId = cloneDisplayNamesMap(request.displayNamesByUserId);
    mergeDisplayName(displayNamesByUserId, request.actor);

    try {
      const result = await sendRemainAttackMessage(
        remainAttackChannel,
        clanData,
        displayNamesByUserId,
        this.options.clock,
      );
      clanData.remainAttackMessageId = result.messageId;
      runInTransaction(this.options.database, () => {
        this.options.clanRepository.update(clanData);
      });

      if (!result.taskKillReactionAdded) {
        this.options.logger.warn("Failed to add task-kill reaction to remain-attack message", {
          categoryId: clanData.categoryId,
          messageId: result.messageId,
          error: result.taskKillReactionError,
        });
      }

      return result.messageId;
    } catch (error) {
      this.options.logger.warn("Failed to create remain-attack message", {
        categoryId: clanData.categoryId,
        error,
      });
      return null;
    }
  }

  async ensureCurrentSummaryMessage(
    clanData: ClanData | undefined,
    request: MemberServiceRenderContext,
  ): Promise<void> {
    if (!clanData) {
      return;
    }

    if (!hasLegacySummaryMirrorTracking(clanData) && findCurrentSummaryOverviewMessage(clanData)) {
      return;
    }

    await this.cleanupLegacySummaryMirrorsIfNeeded(clanData, request);

    if (findCurrentSummaryOverviewMessage(clanData)) {
      return;
    }

    await this.createSummaryMessage(clanData, request);
  }

  async updateSummaryMessage(
    clanData: ClanData,
    request: MemberServiceRenderContext,
  ): Promise<void> {
    await this.syncSummaryMessage(clanData, request);
  }

  private async updateProgressMessage(
    clanData: ClanData,
    lap: number,
    bossIndex: number,
    request: MemberServiceRenderContext,
  ): Promise<void> {
    const progressMessageId = clanData.progressMessageIdsByLap.get(lap)?.[bossIndex];
    if (!progressMessageId) {
      await this.ensureProgressMessage(clanData, lap, bossIndex, request);
      return;
    }

    let bossChannel: MemberServiceTextChannel;
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

    const embed = renderProgressEmbed({
      clanData,
      lap,
      bossIndex,
      displayNamesByUserId: cloneDisplayNamesMap(request.displayNamesByUserId),
    });

    const result = await this.editMessageWithRetry(
      bossChannel,
      progressMessageId,
      embed,
      createProgressMessageComponentsForBoss(clanData, lap, bossIndex),
      "progress",
      clanData.categoryId,
      lap,
      bossIndex,
    );

    if (!result.updated && result.missing) {
      await this.ensureProgressMessage(clanData, lap, bossIndex, request);
    }
  }

  private async syncSummaryMessage(
    clanData: ClanData,
    request: MemberServiceRenderContext,
  ): Promise<void> {
    await this.cleanupLegacySummaryMirrorsIfNeeded(clanData, request);

    const trackedSummary = findCurrentSummaryOverviewMessage(clanData);
    if (!trackedSummary) {
      await this.createSummaryMessage(clanData, request);
      return;
    }

    let summaryChannel: MemberServiceTextChannel;
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

  private async ensureProgressMessage(
    clanData: ClanData,
    lap: number,
    bossIndex: number,
    request: MemberServiceRenderContext,
  ): Promise<void> {
    let bossChannel: MemberServiceTextChannel;
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

    const embed = renderProgressEmbed({
      clanData,
      lap,
      bossIndex,
      displayNamesByUserId: cloneDisplayNamesMap(request.displayNamesByUserId),
    });

    try {
      const progressMessage = await bossChannel.sendMessage({
        embeds: [embed],
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

      await this.updateSummaryMessage(clanData, request);
    } catch (error) {
      this.options.logger.warn("Failed to create progress message", {
        categoryId: clanData.categoryId,
        lap,
        bossIndex,
        error,
      });
    }
  }

  private async cleanupLegacySummaryMirrorsIfNeeded(
    clanData: ClanData,
    request: MemberServiceRenderContext,
  ): Promise<void> {
    if (!hasLegacySummaryMirrorTracking(clanData)) {
      return;
    }

    let summaryChannel: MemberServiceTextChannel;
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
      const result = await retryDeleteDiscordMessage({
        channel: summaryChannel,
        messageId: trackedSummary.messageId,
        retryDelayMs: this.options.redrawRetryDelayMs,
      });

      if (!result.success && !result.missing && !result.deleteUnsupported) {
        this.options.logger.warn("Failed to cleanup legacy summary mirror", {
          categoryId: clanData.categoryId,
          lap: trackedSummary.lap,
          bossIndex: trackedSummary.bossIndex,
          error: result.error,
        });
      }
    }

    clanData.summaryMessageIdsByLap = new Map();
    runInTransaction(this.options.database, () => {
      this.options.summaryMessageIdRepository.deleteAllByCategory(clanData.categoryId);
    });
  }

  private async createSummaryMessage(
    clanData: ClanData,
    request: MemberServiceRenderContext,
  ): Promise<void> {
    let summaryChannel: MemberServiceTextChannel;
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
      const summaryMessageIds = createSummaryOverviewMessageIds(summaryMessage.id);
      const hadSummaryRow = clanData.summaryMessageIdsByLap.has(storageLap);
      clanData.summaryMessageIdsByLap.set(storageLap, summaryMessageIds);

      runInTransaction(this.options.database, () => {
        if (hadSummaryRow) {
          this.options.summaryMessageIdRepository.update(clanData.categoryId, storageLap, summaryMessageIds);
        } else {
          this.options.summaryMessageIdRepository.insert(clanData.categoryId, storageLap, summaryMessageIds);
        }
      });
    } catch (error) {
      this.options.logger.warn("Failed to create summary message", {
        categoryId: clanData.categoryId,
        error,
      });
    }
  }

  private async editMessageWithRetry(
    channel: MemberServiceTextChannel,
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
}
