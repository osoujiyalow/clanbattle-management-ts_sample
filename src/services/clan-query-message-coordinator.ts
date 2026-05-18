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

export interface ClanQueryMessageCoordinatorOptions {
  clanRepository: ClanRepository;
  progressMessageIdRepository: ProgressMessageIdRepository;
  summaryMessageIdRepository: SummaryMessageIdRepository;
  clock: Clock;
  logger: Logger;
  redrawRetryDelayMs: number;
}

export interface ClanQueryMessageEditableMessage {
  readonly id: string;
  edit(payload: {
    embeds?: readonly EmbedBuilder[];
    components?: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[];
  }): Promise<void>;
  delete(): Promise<void>;
}

export interface ClanQueryMessageCreatedMessage extends ClanQueryMessageEditableMessage {
  addReaction(emoji: string): Promise<void>;
}

export interface ClanQueryMessageTextChannel {
  readonly id: string;
  fetchMessage(messageId: string): Promise<ClanQueryMessageEditableMessage>;
  sendMessage(payload: {
    content?: string;
    embeds?: readonly EmbedBuilder[];
    components?: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[];
  }): Promise<ClanQueryMessageCreatedMessage>;
}

export interface ClanQueryMessageDiscordGateway {
  getTextChannel(channelId: string): Promise<ClanQueryMessageTextChannel>;
}

export interface ClanQueryMessageRenderContext {
  responseChannel: {
    send(payload: { content?: string }): Promise<void>;
  };
  discordGateway: ClanQueryMessageDiscordGateway;
  displayNamesByUserId?: ReadonlyMap<string, string>;
}

function createBossSlots(): [string | null, string | null, string | null, string | null, string | null] {
  return [null, null, null, null, null];
}

function cloneDisplayNamesMap(
  displayNamesByUserId: ReadonlyMap<string, string> | undefined,
): Map<string, string> {
  return new Map(displayNamesByUserId ?? []);
}

export class ClanQueryMessageCoordinator {
  constructor(private readonly options: ClanQueryMessageCoordinatorOptions) {}

  async deleteProgressMessage(
    clanData: ClanData,
    lap: number,
    bossIndex: number,
    request: ClanQueryMessageRenderContext,
  ): Promise<void> {
    const progressMessageId = clanData.progressMessageIdsByLap.get(lap)?.[bossIndex];
    if (!progressMessageId) {
      return;
    }

    const bossChannel = await request.discordGateway.getTextChannel(clanData.bossChannelIds[bossIndex]!);
    const result = await retryDeleteDiscordMessage({
      channel: bossChannel,
      messageId: progressMessageId,
      retryDelayMs: this.options.redrawRetryDelayMs,
    });

    if (!result.success && !result.missing) {
      this.options.logger.warn("Failed to delete progress message during lap reset", {
        categoryId: clanData.categoryId,
        lap,
        bossIndex,
        messageId: progressMessageId,
        error: result.error,
      });
    }
  }

  async sendNewProgressMessage(
    clanData: ClanData,
    lap: number,
    bossIndex: number,
    request: ClanQueryMessageRenderContext,
    createSummaryIfMissing: boolean,
  ): Promise<string> {
    const bossChannel = await request.discordGateway.getTextChannel(clanData.bossChannelIds[bossIndex]!);
    const displayNamesByUserId = cloneDisplayNamesMap(request.displayNamesByUserId);
    const progressEmbed = renderProgressEmbed({
      clanData,
      lap,
      bossIndex,
      displayNamesByUserId,
    });
    const progressMessage = await bossChannel.sendMessage({
      embeds: [progressEmbed],
      components: createProgressActionComponents({
        interactive: !(clanData.bossStatusByLap.get(lap)?.[bossIndex]?.beated ?? false),
      }),
    });

    const progressMessageIds = clanData.progressMessageIdsByLap.get(lap) ?? createBossSlots();
    progressMessageIds[bossIndex] = progressMessage.id;
    clanData.progressMessageIdsByLap.set(lap, progressMessageIds);
    this.options.progressMessageIdRepository.update(clanData.categoryId, lap, progressMessageIds);

    if (createSummaryIfMissing) {
      await this.updateSummaryMessage(clanData, request);
    }

    return progressMessage.id;
  }

  async updateRemainAttackMessage(
    clanData: ClanData,
    request: ClanQueryMessageRenderContext,
  ): Promise<void> {
    if (!clanData.remainAttackMessageId) {
      return;
    }

    const remainAttackChannel = await request.discordGateway.getTextChannel(
      clanData.remainAttackChannelId,
    );
    const displayNamesByUserId = cloneDisplayNamesMap(request.displayNamesByUserId);
    const embed = buildRemainAttackEmbed(clanData, displayNamesByUserId, this.options.clock);

    await this.editRemainAttackMessage(
      remainAttackChannel,
      clanData.remainAttackMessageId,
      embed,
      clanData.categoryId,
    );
  }

  async ensureCurrentRemainAttackMessage(
    clanData: ClanData | undefined,
    dayGuardResult: ClanBattleDayGuardResult | null,
    request: ClanQueryMessageRenderContext,
  ): Promise<void> {
    if (
      !clanData ||
      (!dayGuardResult?.shouldCreateRemainAttackMessage && clanData.remainAttackMessageId)
    ) {
      return;
    }

    const remainAttackChannel = await request.discordGateway.getTextChannel(clanData.remainAttackChannelId);
    const displayNamesByUserId = cloneDisplayNamesMap(request.displayNamesByUserId);
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
    this.options.clanRepository.update(clanData);
  }

  async ensureCurrentSummaryMessage(
    clanData: ClanData | undefined,
    dayGuardResult: ClanBattleDayGuardResult | null,
    request: ClanQueryMessageRenderContext,
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

  async updateSummaryMessage(
    clanData: ClanData,
    request: ClanQueryMessageRenderContext,
  ): Promise<void> {
    await this.syncSummaryMessage(clanData, request);
  }

  private async syncSummaryMessage(
    clanData: ClanData,
    request: ClanQueryMessageRenderContext,
  ): Promise<void> {
    await this.cleanupLegacySummaryMirrorsIfNeeded(clanData, request);

    const trackedSummary = findCurrentSummaryOverviewMessage(clanData);
    if (!trackedSummary) {
      await this.createSummaryMessage(clanData, request);
      return;
    }

    const summaryChannel = await request.discordGateway.getTextChannel(clanData.summaryChannelId);
    const result = await retryEditDiscordMessage({
      channel: summaryChannel,
      messageId: trackedSummary.messageId,
      payload: {
        embeds: [renderSummaryOverviewEmbed(clanData)],
      },
      retryDelayMs: this.options.redrawRetryDelayMs,
    });

    if (!result.success && result.missing) {
      clanData.summaryMessageIdsByLap = new Map();
      this.options.summaryMessageIdRepository.deleteAllByCategory(clanData.categoryId);
      await this.createSummaryMessage(clanData, request);
    }
  }

  private async cleanupLegacySummaryMirrorsIfNeeded(
    clanData: ClanData,
    request: ClanQueryMessageRenderContext,
  ): Promise<void> {
    if (!hasLegacySummaryMirrorTracking(clanData)) {
      return;
    }

    const summaryChannel = await request.discordGateway.getTextChannel(clanData.summaryChannelId);
    for (const trackedSummary of collectTrackedSummaryMessages(clanData)) {
      await retryDeleteDiscordMessage({
        channel: summaryChannel,
        messageId: trackedSummary.messageId,
        retryDelayMs: this.options.redrawRetryDelayMs,
      });
    }

    clanData.summaryMessageIdsByLap = new Map();
    this.options.summaryMessageIdRepository.deleteAllByCategory(clanData.categoryId);
  }

  private async createSummaryMessage(
    clanData: ClanData,
    request: ClanQueryMessageRenderContext,
  ): Promise<void> {
    const summaryChannel = await request.discordGateway.getTextChannel(clanData.summaryChannelId);
    const summaryMessage = await summaryChannel.sendMessage({
      embeds: [renderSummaryOverviewEmbed(clanData)],
    });

    const storageLap = resolveSummaryOverviewStorageLap(clanData);
    const summaryMessageIds = createSummaryOverviewMessageIds(summaryMessage.id);
    clanData.summaryMessageIdsByLap.set(storageLap, summaryMessageIds);
    this.options.summaryMessageIdRepository.insert(clanData.categoryId, storageLap, summaryMessageIds);
  }

  private async editRemainAttackMessage(
    channel: ClanQueryMessageTextChannel,
    messageId: string,
    embed: EmbedBuilder,
    categoryId: string,
  ): Promise<void> {
    const result = await retryEditDiscordMessage({
      channel,
      messageId,
      payload: {
        embeds: [embed],
        components: [],
      },
      retryDelayMs: this.options.redrawRetryDelayMs,
    });

    if (!result.success) {
      this.options.logger.warn("Failed to redraw remain-attack message", {
        categoryId,
        messageId,
        missing: result.missing,
        error: result.error,
      });
    }
  }
}
