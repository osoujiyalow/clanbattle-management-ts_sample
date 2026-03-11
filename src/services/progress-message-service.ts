import type { EmbedBuilder } from "discord.js";

import { EMOJIS } from "../constants/emojis.js";
import { USER_MESSAGES } from "../constants/messages.js";
import type { ClanData } from "../domain/clan-data.js";
import { renderProgressEmbed } from "../renderers/progress-renderer.js";
import { ProgressMessageIdRepository } from "../repositories/sqlite/boss-message-id-repository.js";
import { BossStatusRepository } from "../repositories/sqlite/boss-status-repository.js";
import { ClanRepository } from "../repositories/sqlite/clan-repository.js";
import { runInTransaction, type SqliteDatabase } from "../repositories/sqlite/db.js";
import type { ClanBattleDayGuardResult } from "../shared/date-guard.js";
import type { Logger } from "../shared/logger.js";
import { type Clock, systemClock } from "../shared/time.js";
import { sendRemainAttackMessage } from "./remain-attack-message.js";
import type { RuntimeStateService } from "./runtime-state-service.js";

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const PROGRESS_REACTIONS = [
  EMOJIS.physics,
  EMOJIS.magic,
  EMOJIS.carryover,
  EMOJIS.attack,
  EMOJIS.lastAttack,
  EMOJIS.reverse,
] as const;

function createBossSlots(): [string | null, string | null, string | null, string | null, string | null] {
  return [null, null, null, null, null];
}

function cloneDisplayNamesMap(
  displayNamesByUserId: ReadonlyMap<string, string> | undefined,
): Map<string, string> {
  return new Map(displayNamesByUserId ?? []);
}

function formatResendMessage(lap: number, bossNumber: number): string {
  return `${lap}\u9031\u76ee${bossNumber}\u306e\u9032\u884c\u7528\u30e1\u30c3\u30bb\u30fc\u30b8\u3092\u518d\u9001\u3057\u307e\u3059`;
}

function isMessageMissingError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error && error.code === 10008) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes("Unknown message id") || error.message.includes("Unknown Message");
}

export interface ProgressMessageResponseChannel {
  send(payload: { content?: string }): Promise<void>;
}

export interface ProgressMessageSendPayload {
  content?: string;
  embeds?: readonly EmbedBuilder[];
}

export interface ProgressMessageEditableMessage {
  readonly id: string;
  delete(): Promise<void>;
}

export interface ProgressMessageCreatedMessage extends ProgressMessageEditableMessage {
  addReaction(emoji: string): Promise<void>;
}

export interface ProgressMessageTextChannel {
  readonly id: string;
  fetchMessage(messageId: string): Promise<ProgressMessageEditableMessage>;
  sendMessage(payload: ProgressMessageSendPayload): Promise<ProgressMessageCreatedMessage>;
}

export interface ProgressMessageDiscordGateway {
  getTextChannel(channelId: string): Promise<ProgressMessageTextChannel>;
}

export interface ResendProgressMessageRequest {
  categoryId: string;
  channelId: string;
  lap?: number;
  bossNumber?: number;
  responseChannel: ProgressMessageResponseChannel;
  discordGateway: ProgressMessageDiscordGateway;
  displayNamesByUserId?: ReadonlyMap<string, string>;
}

interface ValidatedResendRequest {
  clanData: ClanData;
  lap: number;
  bossIndex: number;
}

export interface ProgressMessageServiceOptions {
  database: SqliteDatabase;
  runtimeStateService: RuntimeStateService;
  clanRepository?: ClanRepository;
  progressMessageIdRepository?: ProgressMessageIdRepository;
  bossStatusRepository?: BossStatusRepository;
  logger?: Logger;
  clock?: Clock;
}

export class ProgressMessageService {
  private readonly clanRepository: ClanRepository;
  private readonly progressMessageIdRepository: ProgressMessageIdRepository;
  private readonly bossStatusRepository: BossStatusRepository;
  private readonly logger: Logger;
  private readonly clock: Clock;

  constructor(private readonly options: ProgressMessageServiceOptions) {
    this.clanRepository = options.clanRepository ?? new ClanRepository(options.database);
    this.progressMessageIdRepository =
      options.progressMessageIdRepository ?? new ProgressMessageIdRepository(options.database);
    this.bossStatusRepository =
      options.bossStatusRepository ?? new BossStatusRepository(options.database);
    this.logger = options.logger ?? NOOP_LOGGER;
    this.clock = options.clock ?? systemClock;
  }

  async resend(request: ResendProgressMessageRequest): Promise<string | null> {
    return this.options.runtimeStateService.withCategoryLock(request.categoryId, async () => {
      const dayGuardResult = this.options.runtimeStateService.get(request.categoryId)
        ? this.options.runtimeStateService.ensureDateUpToDateLocked(request.categoryId, this.clock)
        : null;
      const clanData = this.options.runtimeStateService.get(request.categoryId);
      await this.ensureCurrentRemainAttackMessage(clanData, dayGuardResult, request);

      const validation = await this.validateRequest(request);
      if (!validation) {
        return null;
      }

      await request.responseChannel.send({
        content: formatResendMessage(validation.lap, validation.bossIndex + 1),
      });

      await this.deleteExistingProgressMessage(validation.clanData, validation.lap, validation.bossIndex, request);
      return this.sendNewProgressMessage(validation.clanData, validation.lap, validation.bossIndex, request);
    });
  }

  private async validateRequest(
    request: ResendProgressMessageRequest,
  ): Promise<ValidatedResendRequest | null> {
    const clanData = this.options.runtimeStateService.get(request.categoryId);
    if (!clanData) {
      await request.responseChannel.send({
        content: USER_MESSAGES.errors.categoryRequired,
      });
      return null;
    }

    const bossIndex = await this.resolveBossIndex(clanData, request);
    if (bossIndex === null) {
      return null;
    }

    let lap: number;
    try {
      lap = clanData.getLatestLap(bossIndex);
    } catch {
      await request.responseChannel.send({
        content: USER_MESSAGES.errors.invalidLap,
      });
      return null;
    }

    if (request.lap !== undefined) {
      if (lap < request.lap || !clanData.progressMessageIdsByLap.has(request.lap)) {
        await request.responseChannel.send({
          content: USER_MESSAGES.errors.invalidLap,
        });
        return null;
      }

      lap = request.lap;
    }

    this.ensureBossStatusRowsForExistingLap(clanData, lap);

    return {
      clanData,
      lap,
      bossIndex,
    };
  }

  private async resolveBossIndex(
    clanData: ClanData,
    request: ResendProgressMessageRequest,
  ): Promise<number | null> {
    if (request.bossNumber === undefined) {
      const bossIndex = clanData.getBossIndexFromChannelId(request.channelId);
      if (bossIndex === undefined) {
        await request.responseChannel.send({
          content: USER_MESSAGES.errors.bossNumberRequired,
        });
        return null;
      }

      return bossIndex;
    }

    if (!(0 < request.bossNumber && request.bossNumber < 6)) {
      await request.responseChannel.send({
        content: USER_MESSAGES.errors.invalidBossNumber,
      });
      return null;
    }

    return request.bossNumber - 1;
  }

  private ensureBossStatusRowsForExistingLap(clanData: ClanData, lap: number): void {
    if (clanData.bossStatusByLap.has(lap)) {
      return;
    }

    clanData.initializeBossStatusData(lap);
    runInTransaction(this.options.database, () => {
      this.bossStatusRepository.insertAllForLap(clanData.categoryId, clanData.bossStatusByLap.get(lap)!);
    });
  }

  private async deleteExistingProgressMessage(
    clanData: ClanData,
    lap: number,
    bossIndex: number,
    request: ResendProgressMessageRequest,
  ): Promise<void> {
    const messageId = clanData.progressMessageIdsByLap.get(lap)?.[bossIndex];
    if (!messageId) {
      return;
    }

    const bossChannel = await request.discordGateway.getTextChannel(clanData.bossChannelIds[bossIndex]!);
    try {
      const progressMessage = await bossChannel.fetchMessage(messageId);
      await progressMessage.delete();
    } catch (error) {
      if (!isMessageMissingError(error)) {
        this.logger.warn("Failed to delete existing progress message", {
          categoryId: clanData.categoryId,
          lap,
          bossIndex,
          messageId,
          error,
        });
      }
    }
  }

  private async sendNewProgressMessage(
    clanData: ClanData,
    lap: number,
    bossIndex: number,
    request: ResendProgressMessageRequest,
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
    });

    for (const emoji of PROGRESS_REACTIONS) {
      await progressMessage.addReaction(emoji);
    }

    const hadProgressRow = clanData.progressMessageIdsByLap.has(lap);
    const progressMessageIds = [...(clanData.progressMessageIdsByLap.get(lap) ?? createBossSlots())];
    progressMessageIds[bossIndex] = progressMessage.id;
    clanData.progressMessageIdsByLap.set(lap, createBossSlots().map((_, index) => progressMessageIds[index] ?? null) as [
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
    ]);

    runInTransaction(this.options.database, () => {
      if (hadProgressRow) {
        this.progressMessageIdRepository.update(clanData.categoryId, lap, progressMessageIds);
      } else {
        this.progressMessageIdRepository.insert(clanData.categoryId, lap, progressMessageIds);
      }
    });

    return progressMessage.id;
  }

  private async ensureCurrentRemainAttackMessage(
    clanData: ClanData | undefined,
    dayGuardResult: ClanBattleDayGuardResult | null,
    request: ResendProgressMessageRequest,
  ): Promise<void> {
    if (
      !clanData ||
      (!dayGuardResult?.shouldCreateRemainAttackMessage && clanData.remainAttackMessageId)
    ) {
      return;
    }

    const remainAttackChannel = await request.discordGateway.getTextChannel(clanData.remainAttackChannelId);
    const remainAttackMessage = await sendRemainAttackMessage(
      remainAttackChannel,
      clanData,
      cloneDisplayNamesMap(request.displayNamesByUserId),
      this.clock,
    );
    clanData.remainAttackMessageId = remainAttackMessage.messageId;
    if (!remainAttackMessage.taskKillReactionAdded) {
      this.logger.warn("Failed to add task-kill reaction to remain-attack message", {
        categoryId: clanData.categoryId,
        messageId: remainAttackMessage.messageId,
        error: remainAttackMessage.taskKillReactionError,
      });
    }
    this.clanRepository.update(clanData);
  }
}
