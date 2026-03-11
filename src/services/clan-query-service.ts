import type { EmbedBuilder } from "discord.js";

import { EMOJIS } from "../constants/emojis.js";
import { USER_MESSAGES } from "../constants/messages.js";
import type { ClanData } from "../domain/clan-data.js";
import { calcCarryOverTime } from "../domain/util/carry-over.js";
import { renderProgressEmbed } from "../renderers/progress-renderer.js";
import { AttackStatusRepository } from "../repositories/sqlite/attack-status-repository.js";
import {
  ProgressMessageIdRepository,
  SummaryMessageIdRepository,
} from "../repositories/sqlite/boss-message-id-repository.js";
import { BossStatusRepository } from "../repositories/sqlite/boss-status-repository.js";
import { ClanRepository } from "../repositories/sqlite/clan-repository.js";
import { runInTransaction, type SqliteDatabase } from "../repositories/sqlite/db.js";
import type { ClanBattleDayGuardResult } from "../shared/date-guard.js";
import type { Logger } from "../shared/logger.js";
import {
  NumericTokenizationError,
  parseNormalizedIntegerToken,
  tokenizeNumericInput,
} from "../shared/numeric-tokenizer.js";
import { type Clock, systemClock } from "../shared/time.js";
import { buildRemainAttackEmbed, sendRemainAttackMessage } from "./remain-attack-message.js";
import type { RuntimeStateService } from "./runtime-state-service.js";

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const DEFAULT_REDRAW_RETRY_COUNT = 3;
const DEFAULT_REDRAW_RETRY_DELAY_MS = 10;
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

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
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

export interface ClanQueryResponseChannel {
  send(payload: { content?: string }): Promise<void>;
}

export interface ClanQuerySendPayload {
  content?: string;
  embeds?: readonly EmbedBuilder[];
}

export interface ClanQueryEditableMessage {
  readonly id: string;
  edit(payload: { embeds?: readonly EmbedBuilder[] }): Promise<void>;
  delete(): Promise<void>;
}

export interface ClanQueryCreatedMessage extends ClanQueryEditableMessage {
  addReaction(emoji: string): Promise<void>;
}

export interface ClanQueryTextChannel {
  readonly id: string;
  fetchMessage(messageId: string): Promise<ClanQueryEditableMessage>;
  sendMessage(payload: ClanQuerySendPayload): Promise<ClanQueryCreatedMessage>;
}

export interface ClanQueryDiscordGateway {
  getTextChannel(channelId: string): Promise<ClanQueryTextChannel>;
}

interface ClanQueryRenderContext {
  responseChannel: ClanQueryResponseChannel;
  discordGateway: ClanQueryDiscordGateway;
  displayNamesByUserId?: ReadonlyMap<string, string>;
}

export interface SetLapRequest extends ClanQueryRenderContext {
  categoryId: string;
  channelId: string;
  lap: number;
  bossNumber?: number;
}

export interface CalcCarryOverRequest {
  values: string;
  responseChannel: ClanQueryResponseChannel;
}

export interface ClanQueryServiceOptions {
  database: SqliteDatabase;
  runtimeStateService: RuntimeStateService;
  clanRepository?: ClanRepository;
  attackStatusRepository?: AttackStatusRepository;
  bossStatusRepository?: BossStatusRepository;
  progressMessageIdRepository?: ProgressMessageIdRepository;
  summaryMessageIdRepository?: SummaryMessageIdRepository;
  clock?: Clock;
  logger?: Logger;
  redrawRetryDelayMs?: number;
}

export class ClanQueryService {
  private readonly clanRepository: ClanRepository;
  private readonly attackStatusRepository: AttackStatusRepository;
  private readonly bossStatusRepository: BossStatusRepository;
  private readonly progressMessageIdRepository: ProgressMessageIdRepository;
  private readonly summaryMessageIdRepository: SummaryMessageIdRepository;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly redrawRetryDelayMs: number;

  constructor(private readonly options: ClanQueryServiceOptions) {
    this.clanRepository = options.clanRepository ?? new ClanRepository(options.database);
    this.attackStatusRepository =
      options.attackStatusRepository ?? new AttackStatusRepository(options.database);
    this.bossStatusRepository =
      options.bossStatusRepository ?? new BossStatusRepository(options.database);
    this.progressMessageIdRepository =
      options.progressMessageIdRepository ?? new ProgressMessageIdRepository(options.database);
    this.summaryMessageIdRepository =
      options.summaryMessageIdRepository ?? new SummaryMessageIdRepository(options.database);
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.redrawRetryDelayMs = options.redrawRetryDelayMs ?? DEFAULT_REDRAW_RETRY_DELAY_MS;
  }

  async setLap(request: SetLapRequest): Promise<boolean> {
    return this.options.runtimeStateService.withCategoryLock(request.categoryId, async () => {
      const dayGuardResult = this.options.runtimeStateService.get(request.categoryId)
        ? this.options.runtimeStateService.ensureDateUpToDateLocked(request.categoryId, this.clock)
        : null;

      const clanData = this.options.runtimeStateService.get(request.categoryId);
      await this.ensureCurrentRemainAttackMessage(clanData, dayGuardResult, request);
      if (!clanData) {
        await request.responseChannel.send({
          content: USER_MESSAGES.errors.categoryRequired,
        });
        return false;
      }

      if (request.bossNumber === undefined) {
        await request.responseChannel.send({
          content: `\u5468\u56de\u6570\u3092${request.lap}\u306b\u8a2d\u5b9a\u3057\u307e\u3059`,
        });

        await this.resetAllBossProgress(clanData, request.lap, request);
        return true;
      }

      if (!(0 < request.bossNumber && request.bossNumber < 6)) {
        await request.responseChannel.send({
          content: USER_MESSAGES.errors.invalidBossNumber,
        });
        return false;
      }

      await request.responseChannel.send({
        content: `${request.bossNumber}\u30dc\u30b9\u306e\u307f\u5468\u56de\u6570\u3092${request.lap}\u306b\u8a2d\u5b9a\u3057\u307e\u3059`,
      });

      await this.resetSingleBossProgress(clanData, request.lap, request.bossNumber - 1, request);
      return true;
    });
  }

  async calcCarryOver(request: CalcCarryOverRequest): Promise<string | null> {
    let tokens: string[];
    try {
      tokens = tokenizeNumericInput(request.values);
    } catch (error) {
      if (!(error instanceof NumericTokenizationError)) {
        throw error;
      }

      await request.responseChannel.send({
        content: USER_MESSAGES.calcCot.nonNumeric,
      });
      return null;
    }

    if (tokens.length < 2) {
      await request.responseChannel.send({
        content: USER_MESSAGES.calcCot.invalidFormat,
      });
      return null;
    }

    const numbers = tokens.map(parseNormalizedIntegerToken);
    if (numbers.some((number) => number === null)) {
      await request.responseChannel.send({
        content: USER_MESSAGES.calcCot.nonNumeric,
      });
      return null;
    }

    const parsedNumbers = numbers as number[];
    if (parsedNumbers.some((number) => number <= 0)) {
      await request.responseChannel.send({
        content: USER_MESSAGES.calcCot.nonPositive,
      });
      return null;
    }

    const bossHp = parsedNumbers[0]!;
    const damages = parsedNumbers.slice(1);
    let remainHp = bossHp;
    let killed = false;
    let killerIndex = 0;
    let killerDamage = 0;
    let hpBeforeKill = 0;

    for (let index = 0; index < damages.length; index += 1) {
      const damage = damages[index]!;
      const hpBeforeHit = remainHp;
      const afterHit = remainHp - damage;
      if (afterHit <= 0) {
        killed = true;
        killerIndex = index + 1;
        killerDamage = damage;
        hpBeforeKill = hpBeforeHit;
        remainHp = afterHit;
        break;
      }
      remainHp = afterHit;
    }

    let content: string;
    if (!killed) {
      content = [
        USER_MESSAGES.calcCot.notKilledPrefix,
        `\u30dc\u30b9HP: ${formatNumber(bossHp)}`,
        `\u5165\u529b\u4eba\u6570: ${damages.length}\u4eba`,
        `\u30c0\u30e1\u30fc\u30b8\u5408\u8a08: ${formatNumber(damages.reduce((sum, damage) => sum + damage, 0))}`,
        `\u6b8bHP: ${formatNumber(remainHp)}`,
      ].join("\n");
      await request.responseChannel.send({ content });
      return content;
    }

    const cot = calcCarryOverTime(hpBeforeKill, killerDamage);
    const overkillDamage = killerDamage - hpBeforeKill;
    const unusedCount = damages.length - killerIndex;
    const messageLines = [
      USER_MESSAGES.calcCot.successHeader,
      `\u30dc\u30b9HP(\u958b\u59cb\u6642): ${formatNumber(bossHp)}`,
      `\u5165\u529b\u4eba\u6570: ${damages.length}\u4eba`,
      `\u6483\u7834\u3057\u305f\u4eba: ${killerIndex}\u4eba\u76ee`,
      `\u6483\u7834\u76f4\u524dHP: ${formatNumber(hpBeforeKill)}`,
      `\u6483\u7834\u30c0\u30e1\u30fc\u30b8: ${formatNumber(killerDamage)}`,
      `\u30aa\u30fc\u30d0\u30fc\u30ad\u30eb\u91cf: ${formatNumber(overkillDamage)}`,
      `\u6301\u8d8a\u3057\u6642\u9593: ${cot}\u79d2`,
    ];

    if (unusedCount > 0) {
      messageLines.push(
        `\u203b ${killerIndex + 1}\u4eba\u76ee\u4ee5\u964d\u306e ${unusedCount} \u4ef6\u306e\u30c0\u30e1\u30fc\u30b8\u5165\u529b\u306f\u672a\u4f7f\u7528\u3067\u3059\uff08${killerIndex}\u4eba\u76ee\u3067\u6483\u7834\u6e08\u307f\uff09\u3002`,
      );
    }

    content = messageLines.join("\n");
    await request.responseChannel.send({ content });
    return content;
  }

  private async resetAllBossProgress(
    clanData: ClanData,
    lap: number,
    request: ClanQueryRenderContext,
  ): Promise<void> {
    clanData.initializeProgressData();

    runInTransaction(this.options.database, () => {
      this.bossStatusRepository.deleteAllByCategory(clanData.categoryId);
      this.attackStatusRepository.deleteAllByCategory(clanData.categoryId);
      this.progressMessageIdRepository.deleteAllByCategory(clanData.categoryId);
      this.summaryMessageIdRepository.deleteAllByCategory(clanData.categoryId);
    });

    clanData.progressMessageIdsByLap.set(lap, createBossSlots());
    clanData.initializeBossStatusData(lap);

    runInTransaction(this.options.database, () => {
      this.progressMessageIdRepository.insert(
        clanData.categoryId,
        lap,
        clanData.progressMessageIdsByLap.get(lap)!,
      );
      this.bossStatusRepository.insertAllForLap(clanData.categoryId, clanData.bossStatusByLap.get(lap)!);
    });

    for (let bossIndex = 0; bossIndex < clanData.bossChannelIds.length; bossIndex += 1) {
      await this.sendNewProgressMessage(clanData, lap, bossIndex, request, true);
    }

    await this.updateRemainAttackMessage(clanData, request);
    this.clanRepository.update(clanData);
  }

  private async resetSingleBossProgress(
    clanData: ClanData,
    lap: number,
    bossIndex: number,
    request: ClanQueryRenderContext,
  ): Promise<void> {
    let oldLap: number | null = null;
    if (clanData.progressMessageIdsByLap.size > 0) {
      try {
        oldLap = clanData.getLatestLap(bossIndex);
      } catch {
        oldLap = null;
      }
    }

    if (oldLap !== null && clanData.progressMessageIdsByLap.has(oldLap)) {
      const oldMessageId = clanData.progressMessageIdsByLap.get(oldLap)?.[bossIndex];
      if (oldMessageId) {
        await this.deleteProgressMessage(clanData, oldLap, bossIndex, request);
        clanData.progressMessageIdsByLap.get(oldLap)![bossIndex] = null;
        this.progressMessageIdRepository.update(
          clanData.categoryId,
          oldLap,
          clanData.progressMessageIdsByLap.get(oldLap)!,
        );
      }
    }

    const initializedProgressRow = this.ensureProgressRow(clanData, lap);
    const initializedBossStatusLap = this.ensureBossStatusLap(clanData, lap);

    runInTransaction(this.options.database, () => {
      if (initializedProgressRow) {
        this.progressMessageIdRepository.insert(
          clanData.categoryId,
          lap,
          clanData.progressMessageIdsByLap.get(lap)!,
        );
      }

      if (initializedBossStatusLap) {
        this.bossStatusRepository.insertAllForLap(clanData.categoryId, clanData.bossStatusByLap.get(lap)!);
      }
    });

    const targetMessageId = clanData.progressMessageIdsByLap.get(lap)?.[bossIndex];
    if (targetMessageId) {
      await this.deleteProgressMessage(clanData, lap, bossIndex, request);
      clanData.progressMessageIdsByLap.get(lap)![bossIndex] = null;
      this.progressMessageIdRepository.update(
        clanData.categoryId,
        lap,
        clanData.progressMessageIdsByLap.get(lap)!,
      );
    }

    await this.sendNewProgressMessage(clanData, lap, bossIndex, request, true);
    await this.updateRemainAttackMessage(clanData, request);
    this.clanRepository.update(clanData);
  }

  private ensureProgressRow(clanData: ClanData, lap: number): boolean {
    if (clanData.progressMessageIdsByLap.has(lap)) {
      return false;
    }

    clanData.progressMessageIdsByLap.set(lap, createBossSlots());
    return true;
  }

  private ensureBossStatusLap(clanData: ClanData, lap: number): boolean {
    if (clanData.bossStatusByLap.has(lap)) {
      return false;
    }

    clanData.initializeBossStatusData(lap);
    return true;
  }

  private async deleteProgressMessage(
    clanData: ClanData,
    lap: number,
    bossIndex: number,
    request: ClanQueryRenderContext,
  ): Promise<void> {
    const progressMessageId = clanData.progressMessageIdsByLap.get(lap)?.[bossIndex];
    if (!progressMessageId) {
      return;
    }

    const bossChannel = await request.discordGateway.getTextChannel(clanData.bossChannelIds[bossIndex]!);
    try {
      const progressMessage = await bossChannel.fetchMessage(progressMessageId);
      await progressMessage.delete();
    } catch (error) {
      if (!isMessageMissingError(error)) {
        this.logger.warn("Failed to delete progress message during lap reset", {
          categoryId: clanData.categoryId,
          lap,
          bossIndex,
          messageId: progressMessageId,
          error,
        });
      }
    }
  }

  private async sendNewProgressMessage(
    clanData: ClanData,
    lap: number,
    bossIndex: number,
    request: ClanQueryRenderContext,
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
    });

    for (const emoji of PROGRESS_REACTIONS) {
      await progressMessage.addReaction(emoji);
    }

    const progressMessageIds = clanData.progressMessageIdsByLap.get(lap) ?? createBossSlots();
    progressMessageIds[bossIndex] = progressMessage.id;
    clanData.progressMessageIdsByLap.set(lap, progressMessageIds);
    this.progressMessageIdRepository.update(clanData.categoryId, lap, progressMessageIds);

    if (createSummaryIfMissing) {
      await this.ensureSummaryMessages(clanData, lap, displayNamesByUserId, request);
    }

    return progressMessage.id;
  }

  private async ensureSummaryMessages(
    clanData: ClanData,
    lap: number,
    displayNamesByUserId: ReadonlyMap<string, string>,
    request: ClanQueryRenderContext,
  ): Promise<void> {
    if (clanData.summaryMessageIdsByLap.has(lap)) {
      return;
    }

    const summaryChannel = await request.discordGateway.getTextChannel(clanData.summaryChannelId);
    const summaryMessageIds = createBossSlots();

    for (let bossIndex = 0; bossIndex < clanData.bossChannelIds.length; bossIndex += 1) {
      const summaryEmbed = renderProgressEmbed({
        clanData,
        lap,
        bossIndex,
        displayNamesByUserId,
      });
      const summaryMessage = await summaryChannel.sendMessage({
        embeds: [summaryEmbed],
      });
      summaryMessageIds[bossIndex] = summaryMessage.id;
    }

    clanData.summaryMessageIdsByLap.set(lap, summaryMessageIds);
    this.summaryMessageIdRepository.insert(clanData.categoryId, lap, summaryMessageIds);
  }

  private async updateRemainAttackMessage(
    clanData: ClanData,
    request: ClanQueryRenderContext,
  ): Promise<void> {
    if (!clanData.remainAttackMessageId) {
      return;
    }

    const remainAttackChannel = await request.discordGateway.getTextChannel(
      clanData.remainAttackChannelId,
    );
    const displayNamesByUserId = cloneDisplayNamesMap(request.displayNamesByUserId);
    const embed = buildRemainAttackEmbed(clanData, displayNamesByUserId, this.clock);

    await this.editMessageWithRetry(
      remainAttackChannel,
      clanData.remainAttackMessageId,
      embed,
      clanData.categoryId,
    );
  }

  private async editMessageWithRetry(
    channel: ClanQueryTextChannel,
    messageId: string,
    embed: EmbedBuilder,
    categoryId: string,
  ): Promise<void> {
    let lastError: unknown;
    let missing = false;

    for (let attempt = 0; attempt < DEFAULT_REDRAW_RETRY_COUNT; attempt += 1) {
      try {
        const message = await channel.fetchMessage(messageId);
        await message.edit({
          embeds: [embed],
        });
        return;
      } catch (error) {
        lastError = error;
        missing = isMessageMissingError(error);

        if (attempt < DEFAULT_REDRAW_RETRY_COUNT - 1) {
          await sleep(this.redrawRetryDelayMs);
        }
      }
    }

    this.logger.warn("Failed to redraw remain-attack message", {
      categoryId,
      messageId,
      missing,
      error: lastError,
    });
  }

  private async ensureCurrentRemainAttackMessage(
    clanData: ClanData | undefined,
    dayGuardResult: ClanBattleDayGuardResult | null,
    request: ClanQueryRenderContext,
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
