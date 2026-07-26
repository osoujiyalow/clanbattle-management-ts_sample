import { randomUUID } from "node:crypto";

import type {
  ActionRowBuilder,
  EmbedBuilder,
  MessageActionRowComponentBuilder,
} from "discord.js";

import { AttackEntryKind, AttackEntryStatus } from "../domain/attack-entry.js";
import type { AttackEntry } from "../domain/attack-entry.js";
import { USER_MESSAGES } from "../constants/messages.js";
import type { ClanData } from "../domain/clan-data.js";
import { CarryOver } from "../domain/player-data.js";
import type { PlayerData } from "../domain/player-data.js";
import { PlayerResourceState } from "../domain/player-resource-state.js";
import { ResourceAdjustment, ResourceAdjustmentType } from "../domain/resource-adjustment.js";
import { AttackType } from "../domain/attack-type.js";
import { OperationLog, OperationLogType } from "../domain/operation-log.js";
import { OperationType } from "../domain/operation-type.js";
import { calcCarryOverTime } from "../domain/util/carry-over.js";
import { AttackEntryRepository } from "../repositories/sqlite/attack-entry-repository.js";
import { AttackStatusRepository } from "../repositories/sqlite/attack-status-repository.js";
import {
  ProgressMessageIdRepository,
  SummaryMessageIdRepository,
} from "../repositories/sqlite/boss-message-id-repository.js";
import { BossStatusRepository } from "../repositories/sqlite/boss-status-repository.js";
import { CarryOverRepository } from "../repositories/sqlite/carry-over-repository.js";
import { ClanRepository } from "../repositories/sqlite/clan-repository.js";
import { runInTransaction, type SqliteDatabase } from "../repositories/sqlite/db.js";
import { OperationLogRepository } from "../repositories/sqlite/operation-log-repository.js";
import { PlayerRepository } from "../repositories/sqlite/player-repository.js";
import { ResourceAdjustmentRepository } from "../repositories/sqlite/resource-adjustment-repository.js";
import type { ClanBattleDayGuardResult } from "../shared/date-guard.js";
import type { Logger } from "../shared/logger.js";
import {
  NumericTokenizationError,
  parseNormalizedIntegerToken,
  tokenizeNumericInput,
} from "../shared/numeric-tokenizer.js";
import { type Clock, systemClock } from "../shared/time.js";
import { DEFAULT_DISCORD_MESSAGE_RETRY_DELAY_MS } from "./discord-message-retry.js";
import { ClanQueryMessageCoordinator } from "./clan-query-message-coordinator.js";
import type { RuntimeStateService } from "./runtime-state-service.js";
import {
  createSummaryOverviewMessageIds,
  findCurrentSummaryOverviewMessage,
  resolveSummaryOverviewStorageLap,
} from "./summary-overview-tracking.js";

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function createBossSlots(): [string | null, string | null, string | null, string | null, string | null] {
  return [null, null, null, null, null];
}

function formatCarryOverAttackLine(index: number, damage: number, label: "削り" | "討伐"): string {
  return `${index}人目 ${damage} ${label}`;
}

export interface ClanQueryResponseChannel {
  send(payload: { content?: string }): Promise<void>;
}

export interface ClanQuerySendPayload {
  content?: string;
  embeds?: readonly EmbedBuilder[];
  components?: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

export interface ClanQueryEditableMessage {
  readonly id: string;
  edit(payload: {
    embeds?: readonly EmbedBuilder[];
    components?: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[];
  }): Promise<void>;
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

export interface ClanQueryMember {
  id: string;
  displayName: string;
}

export interface AdjustRemainAttackCountRequest extends ClanQueryRenderContext {
  categoryId: string;
  channelId: string;
  actor: ClanQueryMember;
  member: ClanQueryMember;
  type: ResourceAdjustmentType;
  remaining: number;
}

export interface ClanQueryServiceOptions {
  database: SqliteDatabase;
  runtimeStateService: RuntimeStateService;
  clanRepository?: ClanRepository;
  playerRepository?: PlayerRepository;
  attackEntryRepository?: AttackEntryRepository;
  operationLogRepository?: OperationLogRepository;
  resourceAdjustmentRepository?: ResourceAdjustmentRepository;
  attackStatusRepository?: AttackStatusRepository;
  bossStatusRepository?: BossStatusRepository;
  carryOverRepository?: CarryOverRepository;
  progressMessageIdRepository?: ProgressMessageIdRepository;
  summaryMessageIdRepository?: SummaryMessageIdRepository;
  clock?: Clock;
  logger?: Logger;
  redrawRetryDelayMs?: number;
}

export class ClanQueryService {
  private readonly clanRepository: ClanRepository;
  private readonly playerRepository: PlayerRepository;
  private readonly attackEntryRepository: AttackEntryRepository;
  private readonly operationLogRepository: OperationLogRepository;
  private readonly resourceAdjustmentRepository: ResourceAdjustmentRepository;
  private readonly attackStatusRepository: AttackStatusRepository;
  private readonly bossStatusRepository: BossStatusRepository;
  private readonly carryOverRepository: CarryOverRepository;
  private readonly progressMessageIdRepository: ProgressMessageIdRepository;
  private readonly summaryMessageIdRepository: SummaryMessageIdRepository;
  private readonly clock: Clock;
  private readonly messageCoordinator: ClanQueryMessageCoordinator;

  constructor(private readonly options: ClanQueryServiceOptions) {
    this.clanRepository = options.clanRepository ?? new ClanRepository(options.database);
    this.playerRepository = options.playerRepository ?? new PlayerRepository(options.database);
    this.attackEntryRepository =
      options.attackEntryRepository ?? new AttackEntryRepository(options.database);
    this.operationLogRepository =
      options.operationLogRepository ?? new OperationLogRepository(options.database);
    this.resourceAdjustmentRepository =
      options.resourceAdjustmentRepository ?? new ResourceAdjustmentRepository(options.database);
    this.attackStatusRepository =
      options.attackStatusRepository ?? new AttackStatusRepository(options.database);
    this.bossStatusRepository =
      options.bossStatusRepository ?? new BossStatusRepository(options.database);
    this.carryOverRepository =
      options.carryOverRepository ?? new CarryOverRepository(options.database);
    this.progressMessageIdRepository =
      options.progressMessageIdRepository ?? new ProgressMessageIdRepository(options.database);
    this.summaryMessageIdRepository =
      options.summaryMessageIdRepository ?? new SummaryMessageIdRepository(options.database);
    this.clock = options.clock ?? systemClock;
    const logger = options.logger ?? NOOP_LOGGER;
    const redrawRetryDelayMs =
      options.redrawRetryDelayMs ?? DEFAULT_DISCORD_MESSAGE_RETRY_DELAY_MS;
    this.messageCoordinator = new ClanQueryMessageCoordinator({
      clanRepository: this.clanRepository,
      progressMessageIdRepository: this.progressMessageIdRepository,
      summaryMessageIdRepository: this.summaryMessageIdRepository,
      clock: this.clock,
      logger,
      redrawRetryDelayMs,
    });
  }

  async setLap(request: SetLapRequest): Promise<boolean> {
    return this.options.runtimeStateService.withCategoryLock(request.categoryId, async () => {
      const dayGuardResult = this.options.runtimeStateService.get(request.categoryId)
        ? this.options.runtimeStateService.ensureDateUpToDateLocked(request.categoryId, this.clock)
        : null;

      const clanData = this.options.runtimeStateService.get(request.categoryId);
      await this.ensureCurrentRemainAttackMessage(clanData, dayGuardResult, request);
      await this.ensureCurrentSummaryMessage(clanData, dayGuardResult, request);
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
    let killerDamage = 0;
    let hpBeforeKill = 0;
    const attackLines: string[] = [];

    for (let index = 0; index < damages.length; index += 1) {
      const damage = damages[index]!;
      const hpBeforeHit = remainHp;
      const afterHit = remainHp - damage;
      if (afterHit <= 0) {
        killed = true;
        killerDamage = damage;
        hpBeforeKill = hpBeforeHit;
        attackLines.push(formatCarryOverAttackLine(index + 1, damage, "討伐"));
        break;
      }
      attackLines.push(formatCarryOverAttackLine(index + 1, damage, "削り"));
      remainHp = afterHit;
    }

    let content: string;
    if (!killed) {
      content = attackLines.join("　");
      await request.responseChannel.send({ content });
      return content;
    }

    const cot = calcCarryOverTime(hpBeforeKill, killerDamage);
    content = `${attackLines.join("　")}\n持越し ${cot}秒`;
    await request.responseChannel.send({ content });
    return content;
  }

  async adjustRemainAttackCount(request: AdjustRemainAttackCountRequest): Promise<boolean> {
    return this.options.runtimeStateService.withCategoryLock(request.categoryId, async () => {
      const dayGuardResult = this.options.runtimeStateService.get(request.categoryId)
        ? this.options.runtimeStateService.ensureDateUpToDateLocked(request.categoryId, this.clock)
        : null;

      const clanData = this.options.runtimeStateService.get(request.categoryId);
      await this.ensureCurrentRemainAttackMessage(clanData, dayGuardResult, request);
      await this.ensureCurrentSummaryMessage(clanData, dayGuardResult, request);
      if (!clanData) {
        await request.responseChannel.send({
          content: USER_MESSAGES.errors.categoryRequired,
        });
        return false;
      }

      const playerData = clanData.getPlayerData(request.member.id);
      if (!playerData) {
        await request.responseChannel.send({
          content: `${request.member.displayName}は管理対象メンバーに含まれていません。`,
        });
        return false;
      }

      const currentState =
        this.options.runtimeStateService.getPlayerResourceState(
          clanData.categoryId,
          request.member.id,
          clanData.date,
        ) ??
        new PlayerResourceState({
          categoryId: clanData.categoryId,
          userId: request.member.id,
          dayKey: clanData.date,
        });

      if (
        request.type === ResourceAdjustmentType.BATTLE &&
        currentState.battleReservedCount > playerData.battleAttackLimit - request.remaining
      ) {
        await request.responseChannel.send({
          content: "未確定の本戦宣言があるため、その残数にはできません。",
        });
        return false;
      }

      if (
        request.type === ResourceAdjustmentType.CARRYOVER &&
        currentState.carryReservedCount + request.remaining > 3
      ) {
        await request.responseChannel.send({
          content: "未確定の持越宣言があるため、その残数にはできません。",
        });
        return false;
      }

      const transitionAt = new Date();
      runInTransaction(this.options.database, () => {
        this.resourceAdjustmentRepository.insert(
          new ResourceAdjustment({
            adjustmentId: randomUUID(),
            categoryId: clanData.categoryId,
            userId: request.member.id,
            actorUserId: request.actor.id,
            dayKey: clanData.date,
            resourceType: request.type,
            remaining: request.remaining,
            occurredAt: transitionAt,
          }),
        );
        this.options.runtimeStateService.syncProjectedStateForCategory(
          clanData.categoryId,
          clanData.date,
          transitionAt,
        );
        this.applyProjectedStateToLegacyPlayerData(clanData, playerData);
        this.playerRepository.update(clanData.categoryId, playerData);
        this.carryOverRepository.replaceAll(
          clanData.categoryId,
          playerData.userId,
          playerData.carryOverList,
        );
      });

      await request.responseChannel.send({
        content: `${request.member.displayName}の${request.type === ResourceAdjustmentType.BATTLE ? "本戦凸" : "持越凸"}残数を${request.remaining}に修正します`,
      });
      await this.updateRemainAttackMessage(clanData, request);
      await this.updateSummaryMessage(clanData, request);
      return true;
    });
  }

  private async resetAllBossProgress(
    clanData: ClanData,
    lap: number,
    request: ClanQueryRenderContext,
  ): Promise<void> {
    const preservedSummaryMessageId = this.captureCurrentSummaryMessageId(clanData);
    clanData.initializeProgressData();
    const transitionAt = new Date();

    runInTransaction(this.options.database, () => {
      this.bossStatusRepository.deleteAllByCategory(clanData.categoryId);
      this.attackStatusRepository.deleteAllByCategory(clanData.categoryId);
      this.expireDeclaredAttackEntries(clanData, transitionAt);
      this.progressMessageIdRepository.deleteAllByCategory(clanData.categoryId);
      this.summaryMessageIdRepository.deleteAllByCategory(clanData.categoryId);
    });

    clanData.progressMessageIdsByLap.set(lap, createBossSlots());
    clanData.initializeBossStatusData(lap);
    this.rebindCurrentSummaryTracking(clanData, preservedSummaryMessageId);

    runInTransaction(this.options.database, () => {
      this.progressMessageIdRepository.insert(
        clanData.categoryId,
        lap,
        clanData.progressMessageIdsByLap.get(lap)!,
      );
      this.bossStatusRepository.insertAllForLap(clanData.categoryId, clanData.bossStatusByLap.get(lap)!);
      this.persistCurrentSummaryTracking(clanData);
    });
    this.options.runtimeStateService.syncProjectedStateForCategory(
      clanData.categoryId,
      clanData.date,
      transitionAt,
    );
    this.removeLegacyDeclarationLogs(clanData);
    this.reconcileLegacyPlayerStateAfterProjectionReset(clanData);
    this.persistPlayerState(clanData);

    for (let bossIndex = 0; bossIndex < clanData.bossChannelIds.length; bossIndex += 1) {
      await this.sendNewProgressMessage(clanData, lap, bossIndex, request, false);
    }

    await this.updateRemainAttackMessage(clanData, request);
    await this.updateSummaryMessage(clanData, request);
    this.clanRepository.update(clanData);
  }

  private async resetSingleBossProgress(
    clanData: ClanData,
    lap: number,
    bossIndex: number,
    request: ClanQueryRenderContext,
  ): Promise<void> {
    const preservedSummaryMessageId = this.captureCurrentSummaryMessageId(clanData);
    const transitionAt = new Date();
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
    this.clearProgressTrackingAboveLap(clanData, lap, bossIndex);

    const initializedProgressRow = this.ensureProgressRow(clanData, lap);
    const initializedBossStatusLap = this.ensureBossStatusLap(clanData, lap);
    this.removeBossStatusFromRuntime(clanData, bossIndex);

    runInTransaction(this.options.database, () => {
      this.bossStatusRepository.deleteByBossIndex(clanData.categoryId, bossIndex);
      this.attackStatusRepository.deleteByBossIndex(clanData.categoryId, bossIndex);
      this.expireDeclaredAttackEntries(clanData, transitionAt, bossIndex);
      if (initializedProgressRow) {
        this.progressMessageIdRepository.insert(
          clanData.categoryId,
          lap,
          clanData.progressMessageIdsByLap.get(lap)!,
        );
      }

      if (initializedBossStatusLap) {
        this.bossStatusRepository.insertAllForLap(clanData.categoryId, clanData.bossStatusByLap.get(lap)!);
      } else {
        this.bossStatusRepository.insert(
          clanData.categoryId,
          clanData.bossStatusByLap.get(lap)![bossIndex]!,
        );
      }
    });
    this.options.runtimeStateService.syncProjectedStateForCategory(
      clanData.categoryId,
      clanData.date,
      transitionAt,
    );
    this.removeLegacyDeclarationLogs(clanData, bossIndex);
    this.reconcileLegacyPlayerStateAfterProjectionReset(clanData);
    this.persistPlayerState(clanData);

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

    this.rebindCurrentSummaryTracking(clanData, preservedSummaryMessageId);
    runInTransaction(this.options.database, () => {
      this.persistCurrentSummaryTracking(clanData);
    });

    await this.sendNewProgressMessage(clanData, lap, bossIndex, request, false);
    await this.updateRemainAttackMessage(clanData, request);
    await this.updateSummaryMessage(clanData, request);
    this.clanRepository.update(clanData);
  }

  private removeBossStatusFromRuntime(clanData: ClanData, bossIndex: number): void {
    for (const bossStatusList of clanData.bossStatusByLap.values()) {
      const bossStatusData = bossStatusList[bossIndex];
      if (!bossStatusData) {
        continue;
      }

      bossStatusData.attackPlayers = [];
      bossStatusData.beated = false;
    }
  }

  private removeLegacyDeclarationLogs(clanData: ClanData, bossIndex?: number): void {
    for (const playerData of clanData.playerDataMap.values()) {
      playerData.log = playerData.log.filter(
        (logData) =>
          logData.operationType !== OperationType.ATTACK_DECLAR ||
          (bossIndex !== undefined && logData.bossIndex !== bossIndex),
      );
    }
  }

  private clearProgressTrackingAboveLap(
    clanData: ClanData,
    targetLap: number,
    bossIndex: number,
  ): void {
    for (const [trackedLap, progressMessageIds] of clanData.progressMessageIdsByLap.entries()) {
      if (trackedLap <= targetLap || !progressMessageIds[bossIndex]) {
        continue;
      }

      progressMessageIds[bossIndex] = null;
      this.progressMessageIdRepository.update(
        clanData.categoryId,
        trackedLap,
        progressMessageIds,
      );
    }
  }

  private expireDeclaredAttackEntries(
    clanData: ClanData,
    transitionAt: Date,
    bossIndex?: number,
  ): void {
    const declaredAttackEntries = this.attackEntryRepository
      .findAllByCategory(clanData.categoryId)
      .filter(
        (attackEntry) =>
          attackEntry.dayKey === clanData.date &&
          attackEntry.status === AttackEntryStatus.DECLARED &&
          (bossIndex === undefined || attackEntry.bossIndex === bossIndex),
      );

    for (const attackEntry of declaredAttackEntries) {
      attackEntry.status = AttackEntryStatus.EXPIRED;
      attackEntry.resolvedAt = transitionAt;
      this.attackEntryRepository.update(attackEntry);
      this.operationLogRepository.insert(
        new OperationLog({
          operationId: randomUUID(),
          categoryId: attackEntry.categoryId,
          userId: attackEntry.userId,
          dayKey: attackEntry.dayKey,
          lap: attackEntry.lap,
          bossIndex: attackEntry.bossIndex,
          targetAttackEntryId: attackEntry.attackEntryId,
          operationType: OperationLogType.EXPIRE,
          beforeKind: attackEntry.kind,
          afterKind: attackEntry.kind,
          beforeStatus: AttackEntryStatus.DECLARED,
          afterStatus: AttackEntryStatus.EXPIRED,
          occurredAt: transitionAt,
        }),
      );
    }
  }

  private persistPlayerState(clanData: ClanData): void {
    for (const playerData of clanData.playerDataMap.values()) {
      this.playerRepository.update(clanData.categoryId, playerData);
      this.carryOverRepository.replaceAll(
        clanData.categoryId,
        playerData.userId,
        playerData.carryOverList,
      );
    }
  }

  private reconcileLegacyPlayerStateAfterProjectionReset(clanData: ClanData): void {
    for (const playerData of clanData.playerDataMap.values()) {
      this.applyProjectedStateToLegacyPlayerData(clanData, playerData);
    }
  }

  private applyProjectedStateToLegacyPlayerData(clanData: ClanData, playerData: PlayerData): void {
    const playerResourceState =
      this.options.runtimeStateService.getPlayerResourceState(
        clanData.categoryId,
        playerData.userId,
        clanData.date,
      ) ??
      new PlayerResourceState({
        categoryId: clanData.categoryId,
        userId: playerData.userId,
        dayKey: clanData.date,
      });
    const attackEntries = this.options.runtimeStateService
      .getAttackEntries(clanData.categoryId)
      .filter(
        (attackEntry) =>
          attackEntry.userId === playerData.userId && attackEntry.dayKey === clanData.date,
      );

    playerData.battleAttackCount = playerResourceState.battleConsumedCount;
    playerData.carryOverList = this.alignCarryOverListToRemaining(
      this.buildBaseAvailableCarryOvers(attackEntries),
      playerResourceState.carryAvailableCount,
      clanData.date,
    );
  }

  private buildBaseAvailableCarryOvers(attackEntries: readonly AttackEntry[]): CarryOver[] {
    const committedCarryAttackCount = attackEntries.filter(
      (attackEntry) =>
        attackEntry.kind === AttackEntryKind.CARRYOVER &&
        (attackEntry.status === AttackEntryStatus.DECLARED ||
          attackEntry.status === AttackEntryStatus.FINISHED ||
          attackEntry.status === AttackEntryStatus.DEFEATED),
    ).length;
    const producedCarryOvers = attackEntries
      .filter(
        (attackEntry) =>
          attackEntry.kind === AttackEntryKind.BATTLE &&
          attackEntry.status === AttackEntryStatus.DEFEATED,
      )
      .map(
        (attackEntry) =>
          new CarryOver({
            attackType: AttackType.BATTLE,
            bossIndex: attackEntry.bossIndex,
            created: attackEntry.resolvedAt ?? attackEntry.declaredAt,
          }),
      )
      .sort((left, right) => {
        const createdDiff = left.created.getTime() - right.created.getTime();
        if (createdDiff !== 0) {
          return createdDiff;
        }

        const bossIndexDiff = left.bossIndex - right.bossIndex;
        if (bossIndexDiff !== 0) {
          return bossIndexDiff;
        }

        return left.attackType.localeCompare(right.attackType);
      });

    return producedCarryOvers.slice(
      Math.min(committedCarryAttackCount, producedCarryOvers.length),
    );
  }

  private alignCarryOverListToRemaining(
    baseCarryOvers: readonly CarryOver[],
    desiredCount: number,
    dayKey: string,
  ): CarryOver[] {
    const alignedCarryOvers = baseCarryOvers
      .map((carryOver) => CarryOver.fromRecord(carryOver.toRecord()))
      .slice(0, desiredCount);

    while (alignedCarryOvers.length < desiredCount) {
      alignedCarryOvers.push(
        new CarryOver({
          attackType: AttackType.BATTLE,
          bossIndex: -1,
          created: this.createSyntheticCarryOverTimestamp(dayKey, alignedCarryOvers.length),
        }),
      );
    }

    return alignedCarryOvers;
  }

  private createSyntheticCarryOverTimestamp(dayKey: string, offset: number): Date {
    const baseDate = new Date(`${dayKey}T23:50:00+09:00`);
    return new Date(baseDate.getTime() + offset * 1_000);
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
    await this.messageCoordinator.deleteProgressMessage(clanData, lap, bossIndex, request);
  }

  private async sendNewProgressMessage(
    clanData: ClanData,
    lap: number,
    bossIndex: number,
    request: ClanQueryRenderContext,
    createSummaryIfMissing: boolean,
  ): Promise<string> {
    return this.messageCoordinator.sendNewProgressMessage(
      clanData,
      lap,
      bossIndex,
      request,
      createSummaryIfMissing,
    );
  }

  private async updateRemainAttackMessage(
    clanData: ClanData,
    request: ClanQueryRenderContext,
  ): Promise<void> {
    await this.messageCoordinator.updateRemainAttackMessage(clanData, request);
  }

  private async updateSummaryMessage(
    clanData: ClanData,
    request: ClanQueryRenderContext,
  ): Promise<void> {
    await this.messageCoordinator.updateSummaryMessage(clanData, request);
  }

  private async ensureCurrentRemainAttackMessage(
    clanData: ClanData | undefined,
    dayGuardResult: ClanBattleDayGuardResult | null,
    request: ClanQueryRenderContext,
  ): Promise<void> {
    await this.messageCoordinator.ensureCurrentRemainAttackMessage(
      clanData,
      dayGuardResult,
      request,
    );
  }

  private async ensureCurrentSummaryMessage(
    clanData: ClanData | undefined,
    dayGuardResult: ClanBattleDayGuardResult | null,
    request: ClanQueryRenderContext,
  ): Promise<void> {
    await this.messageCoordinator.ensureCurrentSummaryMessage(
      clanData,
      dayGuardResult,
      request,
    );
  }

  private captureCurrentSummaryMessageId(clanData: ClanData): string | null {
    return findCurrentSummaryOverviewMessage(clanData)?.messageId ?? null;
  }

  private rebindCurrentSummaryTracking(clanData: ClanData, messageId: string | null): void {
    clanData.summaryMessageIdsByLap = new Map();
    if (!messageId) {
      return;
    }

    const storageLap = resolveSummaryOverviewStorageLap(clanData);
    clanData.summaryMessageIdsByLap.set(storageLap, createSummaryOverviewMessageIds(messageId));
  }

  private persistCurrentSummaryTracking(clanData: ClanData): void {
    this.summaryMessageIdRepository.deleteAllByCategory(clanData.categoryId);

    const trackedSummary = findCurrentSummaryOverviewMessage(clanData);
    if (!trackedSummary) {
      return;
    }

    this.summaryMessageIdRepository.insert(
      clanData.categoryId,
      trackedSummary.lap,
      createSummaryOverviewMessageIds(trackedSummary.messageId),
    );
  }
}
