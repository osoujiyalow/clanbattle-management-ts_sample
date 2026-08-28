import { randomUUID } from "node:crypto";

import type { ActionRowBuilder, EmbedBuilder, MessageActionRowComponentBuilder } from "discord.js";

import { USER_MESSAGES } from "../constants/messages.js";
import { AttackEntryKind, AttackEntryStatus } from "../domain/attack-entry.js";
import type { AttackEntry } from "../domain/attack-entry.js";
import { AttackStatus } from "../domain/attack-status.js";
import { AttackType, parseUserFacingAttackType } from "../domain/attack-type.js";
import { type BossStatusData } from "../domain/boss-status-data.js";
import { type ClanData } from "../domain/clan-data.js";
import { OperationLog, OperationLogType } from "../domain/operation-log.js";
import { OperationType } from "../domain/operation-type.js";
import { CarryOver, type LogData, type PlayerData } from "../domain/player-data.js";
import { AttackEntryRepository } from "../repositories/sqlite/attack-entry-repository.js";
import { AttackStatusRepository } from "../repositories/sqlite/attack-status-repository.js";
import { BossStatusRepository } from "../repositories/sqlite/boss-status-repository.js";
import {
  ProgressMessageIdRepository,
  SummaryMessageIdRepository,
} from "../repositories/sqlite/boss-message-id-repository.js";
import { CarryOverRepository } from "../repositories/sqlite/carry-over-repository.js";
import { ClanRepository } from "../repositories/sqlite/clan-repository.js";
import { runInTransaction, type SqliteDatabase } from "../repositories/sqlite/db.js";
import { OperationLogRepository } from "../repositories/sqlite/operation-log-repository.js";
import { PlayerRepository } from "../repositories/sqlite/player-repository.js";
import { ResourceAdjustmentRepository } from "../repositories/sqlite/resource-adjustment-repository.js";
import type { ClanBattleDayGuardResult } from "../shared/date-guard.js";
import type { Logger } from "../shared/logger.js";
import { now, type Clock, systemClock } from "../shared/time.js";
import {
  ALREADY_DEFEATED_MESSAGE,
  CARRYOVER_DECLARE_BLOCKED_MESSAGE,
  CORRECT_ATTACK_KIND_CANCELLED_MESSAGE,
  CORRECT_ATTACK_KIND_INVALID_MESSAGE,
  CORRECT_ATTACK_KIND_NOTHING_MESSAGE,
  DECLARE_RESOURCE_EXHAUSTED_MESSAGE,
  UNDO_BLOCKED_BY_LATER_OPERATIONS_MESSAGE,
  UNDO_DEFEAT_BLOCKED_BY_NEXT_LAP_MESSAGE,
  UNDO_NOTHING_MESSAGE,
  compareCarryOversOldestFirst,
  createBossSlots,
  formatAttackFinishMessage,
  formatCarryOverMissingMessage,
  formatDeclareMessage,
  formatDefeatBossMessage,
  formatNotManagedMessage,
  formatUndoMemberNotManagedMessage,
  formatUndoMessage,
  hasAnyAttackPlayers,
  sendAttackResponse,
} from "./attack-service-support.js";
import {
  findCorrectableAttackEntries as findCorrectableAttackEntriesState,
  findMessageDamageTarget as findMessageDamageTargetState,
  prepareAttackKindCorrection,
} from "./attack-service-correction.js";
import {
  findUndoLogIndexForBoss as findUndoLogIndexForBossState,
  findUndoLogIndexForProgressContext as findUndoLogIndexForProgressContextState,
  findUndoOperationTargetForBoss as findUndoOperationTargetForBossState,
  findUndoOperationTargetForProgressContext as findUndoOperationTargetForProgressContextState,
  hasProjectedUndoState,
  isUndoBlockedByLaterOperations as isUndoBlockedByLaterOperationsState,
  isUndoBlockedByLaterPlayerOperations as isUndoBlockedByLaterPlayerOperationsState,
  resolveUndoBossIndex as resolveUndoBossIndexState,
  toLegacyOperationType as toLegacyOperationTypeState,
  toOperationLogType as toOperationLogTypeState,
  type UndoOperationTarget,
} from "./attack-service-undo.js";
import {
  createAttackEntryFromAttackStatus as createAttackEntryFromAttackStatusRecord,
  findExistingAttackEntry as findExistingAttackEntryRecord,
  normalizeAttackEntryDamage as normalizeAttackEntryDamageValue,
  normalizeAttackEntryMemo as normalizeAttackEntryMemoValue,
  resolveDeclaredAttack as resolveDeclaredAttackState,
  type ValidatedResolutionRequest,
  upsertAttackEntrySnapshot as upsertAttackEntrySnapshotRecord,
} from "./attack-service-resolution.js";
import {
  resolveAttackBossIndex,
  type ValidatedAttackRequest,
  validateAttackRequest as validateAttackRequestState,
} from "./attack-service-validation.js";
import {
  AttackDeferredMessageSyncQueue,
  type DeferredNonProgressSyncJob,
} from "./attack-deferred-message-sync-queue.js";
import { DEFAULT_DISCORD_MESSAGE_RETRY_DELAY_MS } from "./discord-message-retry.js";
import { AttackServiceMessageCoordinator } from "./attack-service-message-coordinator.js";
import type { RuntimeStateService } from "./runtime-state-service.js";

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export interface AttackDeclareMember {
  id: string;
  displayName: string;
}

export interface AttackDeclareResponseChannel {
  send(payload: { content?: string }): Promise<void>;
  sendTransient?(payload: { content?: string }, deleteAfterMs?: number): Promise<void>;
}

export interface AttackEditableMessage {
  readonly id: string;
  edit(payload: {
    embeds?: readonly EmbedBuilder[];
    components?: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[];
  }): Promise<void>;
  delete?(): Promise<void>;
}

export interface AttackCreatedMessage extends AttackEditableMessage {
  addReaction(emoji: string): Promise<void>;
}

export interface AttackSendPayload {
  content?: string;
  embeds?: readonly EmbedBuilder[];
  components?: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

export interface AttackTextChannel {
  readonly id: string;
  fetchMessage(messageId: string): Promise<AttackEditableMessage>;
  sendMessage(payload: AttackSendPayload): Promise<AttackCreatedMessage>;
}

export interface AttackDiscordGateway {
  getTextChannel(channelId: string): Promise<AttackTextChannel>;
}

interface AttackRenderContext {
  member: AttackDeclareMember;
  discordGateway: AttackDiscordGateway;
  displayNamesByUserId?: ReadonlyMap<string, string>;
  resolveDisplayNamesByUserIds?: (
    userIds: Iterable<string>,
  ) => Promise<ReadonlyMap<string, string>>;
  currentProgressMessage?: AttackEditableMessage;
  deferNonProgressMessageUpdates?: boolean;
}

interface AttackServiceBaseRequest extends AttackRenderContext {
  categoryId: string;
  channelId: string;
  lap?: number;
  bossNumber?: number;
  responseChannel: AttackDeclareResponseChannel;
}

export interface AttackDeclareRequest extends AttackServiceBaseRequest {
  attackType: string;
}

export interface AttackCarryOverSelectionInput {
  member: AttackDeclareMember;
  carryOverList: readonly CarryOver[];
  responseChannel: AttackDeclareResponseChannel;
}

export type AttackCarryOverSelector = (
  input: AttackCarryOverSelectionInput,
) => Promise<number | null>;

export interface AttackFinishRequest extends AttackServiceBaseRequest {
  damage?: number;
  selectCarryOver?: AttackCarryOverSelector;
}

export interface DefeatBossRequest extends AttackServiceBaseRequest {
  selectCarryOver?: AttackCarryOverSelector;
}

export interface SetPendingDamageRequest extends AttackServiceBaseRequest {
  damage: number;
}

export interface UndoAttackRequest extends AttackRenderContext {
  categoryId: string;
  channelId?: string;
  lap?: number;
  bossNumber?: number;
  suppressSuccessResponse?: boolean;
  responseChannel: AttackDeclareResponseChannel;
}

export interface AttackEntrySelectionInput {
  member: AttackDeclareMember;
  attackEntries: readonly AttackEntry[];
  responseChannel: AttackDeclareResponseChannel;
}

export type AttackEntrySelector = (
  input: AttackEntrySelectionInput,
) => Promise<string | null>;

export interface CorrectAttackKindRequest extends AttackRenderContext {
  categoryId: string;
  channelId: string;
  lap: number;
  bossNumber: number;
  responseChannel: AttackDeclareResponseChannel;
  selectAttackEntry?: AttackEntrySelector;
}

export interface MessageDamageRequest extends AttackRenderContext {
  categoryId: string;
  channelId: string;
  messageContent: string;
}

export interface AttackServiceOptions {
  database: SqliteDatabase;
  runtimeStateService: RuntimeStateService;
  clanRepository?: ClanRepository;
  attackEntryRepository?: AttackEntryRepository;
  attackStatusRepository?: AttackStatusRepository;
  bossStatusRepository?: BossStatusRepository;
  operationLogRepository?: OperationLogRepository;
  playerRepository?: PlayerRepository;
  carryOverRepository?: CarryOverRepository;
  resourceAdjustmentRepository?: ResourceAdjustmentRepository;
  progressMessageIdRepository?: ProgressMessageIdRepository;
  summaryMessageIdRepository?: SummaryMessageIdRepository;
  clock?: Clock;
  logger?: Logger;
  redrawRetryDelayMs?: number;
}

export class AttackService {
  private readonly attackEntryRepository: AttackEntryRepository;
  private readonly attackStatusRepository: AttackStatusRepository;
  private readonly bossStatusRepository: BossStatusRepository;
  private readonly operationLogRepository: OperationLogRepository;
  private readonly playerRepository: PlayerRepository;
  private readonly carryOverRepository: CarryOverRepository;
  private readonly resourceAdjustmentRepository: ResourceAdjustmentRepository;
  private readonly progressMessageIdRepository: ProgressMessageIdRepository;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly messageCoordinator: AttackServiceMessageCoordinator;
  private readonly deferredNonProgressMessageSyncQueue: AttackDeferredMessageSyncQueue<AttackRenderContext>;

  constructor(private readonly options: AttackServiceOptions) {
    const clanRepository = options.clanRepository ?? new ClanRepository(options.database);
    this.attackEntryRepository =
      options.attackEntryRepository ?? new AttackEntryRepository(options.database);
    this.attackStatusRepository =
      options.attackStatusRepository ?? new AttackStatusRepository(options.database);
    this.bossStatusRepository =
      options.bossStatusRepository ?? new BossStatusRepository(options.database);
    this.operationLogRepository =
      options.operationLogRepository ?? new OperationLogRepository(options.database);
    this.playerRepository = options.playerRepository ?? new PlayerRepository(options.database);
    this.carryOverRepository =
      options.carryOverRepository ?? new CarryOverRepository(options.database);
    this.resourceAdjustmentRepository =
      options.resourceAdjustmentRepository ?? new ResourceAdjustmentRepository(options.database);
    this.progressMessageIdRepository =
      options.progressMessageIdRepository ?? new ProgressMessageIdRepository(options.database);
    const summaryMessageIdRepository =
      options.summaryMessageIdRepository ?? new SummaryMessageIdRepository(options.database);
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? NOOP_LOGGER;
    const redrawRetryDelayMs =
      options.redrawRetryDelayMs ?? DEFAULT_DISCORD_MESSAGE_RETRY_DELAY_MS;
    this.messageCoordinator = new AttackServiceMessageCoordinator({
      database: options.database,
      clanRepository,
      progressMessageIdRepository: this.progressMessageIdRepository,
      summaryMessageIdRepository,
      clock: this.clock,
      logger: this.logger,
      redrawRetryDelayMs,
    });
    this.deferredNonProgressMessageSyncQueue = new AttackDeferredMessageSyncQueue({
      logger: this.logger,
      run: async (categoryId, job) => {
        const clanData = this.options.runtimeStateService.get(categoryId);
        if (!clanData) {
          return;
        }

        await this.runNonProgressMessageUpdates(clanData, job);
      },
    });
  }

  async declare(request: AttackDeclareRequest): Promise<AttackStatus | null> {
    return this.options.runtimeStateService.withCategoryLock(request.categoryId, async () => {
      const dayGuardResult = this.options.runtimeStateService.get(request.categoryId)
        ? this.options.runtimeStateService.ensureDateUpToDateLocked(request.categoryId, this.clock)
        : null;
      const currentClanData = this.options.runtimeStateService.get(request.categoryId);
      await this.ensureCurrentRemainAttackMessage(currentClanData, dayGuardResult, request);
      await this.ensureCurrentSummaryMessage(currentClanData, dayGuardResult, request);

      const validation = await this.validateAttackRequest(request);
      if (!validation) {
        return null;
      }

      const { clanData, playerData, lap, bossIndex } = validation;

      const parsedAttackType = parseUserFacingAttackType(request.attackType);
      if (!parsedAttackType) {
        await sendAttackResponse(request.responseChannel, {
          content: USER_MESSAGES.errors.invalidAttackType,
        });
        return null;
      }

      const playerResourceState = this.options.runtimeStateService.getPlayerResourceState(
        clanData.categoryId,
        playerData.userId,
        clanData.date,
      );
      const occupiedBattleCount =
        (playerResourceState?.battleReservedCount ?? 0) +
        (playerResourceState?.battleConsumedCount ?? playerData.battleAttackCount);
      const carryAvailableCount =
        playerResourceState?.carryAvailableCount ?? playerData.carryOverList.length;

      if (
        parsedAttackType === AttackType.BATTLE &&
        occupiedBattleCount >= playerData.battleAttackLimit
      ) {
        await sendAttackResponse(
          request.responseChannel,
          {
            content: DECLARE_RESOURCE_EXHAUSTED_MESSAGE,
          },
          { transient: true },
        );
        return null;
      }

      if (parsedAttackType === AttackType.CARRYOVER && carryAvailableCount <= 0) {
        await sendAttackResponse(
          request.responseChannel,
          {
            content:
              playerData.carryOverList.length === 0
                ? CARRYOVER_DECLARE_BLOCKED_MESSAGE
                : DECLARE_RESOURCE_EXHAUSTED_MESSAGE,
          },
          { transient: true },
        );
        return null;
      }

      await sendAttackResponse(request.responseChannel, {
        content: formatDeclareMessage(
          request.member.displayName,
          parsedAttackType,
          lap,
          bossIndex + 1,
        ),
      });

      let initializedBossStatus = false;
      if (!clanData.bossStatusByLap.has(lap)) {
        clanData.initializeBossStatusData(lap);
        initializedBossStatus = true;
      }

      const attackStatus = new AttackStatus({
        playerData,
        attackType: parsedAttackType,
        carryOver: parsedAttackType === AttackType.CARRYOVER,
        created: now(this.clock),
      });
      const transitionAt = attackStatus.created;
      clanData.bossStatusByLap.get(lap)![bossIndex]!.attackPlayers.push(attackStatus);
      playerData.log.push({
        operationType: OperationType.ATTACK_DECLAR,
        lap,
        bossIndex,
      });

      runInTransaction(this.options.database, () => {
        if (initializedBossStatus) {
          this.bossStatusRepository.insertAllForLap(clanData.categoryId, clanData.bossStatusByLap.get(lap)!);
        }

        this.attackStatusRepository.insert(clanData.categoryId, lap, bossIndex, attackStatus);
        const attackEntry = this.upsertAttackEntrySnapshot(
          clanData.categoryId,
          clanData.date,
          lap,
          bossIndex,
          attackStatus,
        );
        this.insertOperationLog({
          categoryId: clanData.categoryId,
          userId: playerData.userId,
          dayKey: clanData.date,
          lap,
          bossIndex,
          targetAttackEntryId: attackEntry.attackEntryId,
          operationType: OperationLogType.DECLARE,
          afterKind: attackEntry.kind,
          afterStatus: AttackEntryStatus.DECLARED,
          occurredAt: transitionAt,
        });
        this.syncProjectedStateForCategory(clanData.categoryId, clanData.date, transitionAt);
      });

      await this.updateProgressMessages(clanData, lap, bossIndex, request);
      await this.syncNonProgressMessages(clanData, request, {
        updateSummary: true,
      });

      return attackStatus;
    });
  }

  async finish(request: AttackFinishRequest): Promise<AttackStatus | null> {
    return this.options.runtimeStateService.withCategoryLock(request.categoryId, async () => {
      const dayGuardResult = this.options.runtimeStateService.get(request.categoryId)
        ? this.options.runtimeStateService.ensureDateUpToDateLocked(request.categoryId, this.clock)
        : null;
      const currentClanData = this.options.runtimeStateService.get(request.categoryId);
      await this.ensureCurrentRemainAttackMessage(currentClanData, dayGuardResult, request);
      await this.ensureCurrentSummaryMessage(currentClanData, dayGuardResult, request);

      const validation = await this.validateAttackRequest(request);
      if (!validation) {
        return null;
      }

      await request.responseChannel.send({
        content: formatAttackFinishMessage(
          request.member.displayName,
          validation.lap,
          validation.bossIndex + 1,
        ),
      });

      const resolution = await this.resolveDeclaredAttack(validation, request);
      if (!resolution) {
        return null;
      }

      if (request.damage) {
        resolution.attackStatus.damage = request.damage;
      }

      resolution.attackStatus.playerData.log.push({
        operationType: OperationType.ATTACK,
        lap: resolution.lap,
        bossIndex: resolution.bossIndex,
        playerData: resolution.attackStatus.playerData.toSnapshot(),
      });

      if (resolution.attackStatus.attackType === AttackType.CARRYOVER) {
        const carryOverConsumed = await this.consumeCarryOver(
          resolution.attackStatus,
          request,
        );
        if (!carryOverConsumed) {
          return null;
        }
      } else {
        resolution.attackStatus.updateAttackLog();
      }

      resolution.attackStatus.attacked = true;
      const transitionAt = now(this.clock);

      runInTransaction(this.options.database, () => {
        this.attackStatusRepository.update(
          resolution.clanData.categoryId,
          resolution.lap,
          resolution.bossIndex,
          resolution.attackStatus,
        );
        this.playerRepository.update(resolution.clanData.categoryId, resolution.playerData);
        this.carryOverRepository.replaceAll(
          resolution.clanData.categoryId,
          resolution.playerData.userId,
          resolution.playerData.carryOverList,
        );
        const attackEntry = this.upsertAttackEntrySnapshot(
          resolution.clanData.categoryId,
          resolution.clanData.date,
          resolution.lap,
          resolution.bossIndex,
          resolution.attackStatus,
        );
        const beforeStatus =
          this.findExistingAttackEntry(
            resolution.clanData.categoryId,
            resolution.playerData.userId,
            resolution.lap,
            resolution.bossIndex,
            resolution.attackStatus,
          )?.status ?? AttackEntryStatus.DECLARED;
        attackEntry.status = AttackEntryStatus.FINISHED;
        attackEntry.resolvedAt = transitionAt;
        attackEntry.damage = this.normalizeAttackEntryDamage(resolution.attackStatus.damage);
        attackEntry.memo = this.normalizeAttackEntryMemo(resolution.attackStatus.memo);
        this.attackEntryRepository.update(attackEntry);
        this.insertOperationLog({
          categoryId: resolution.clanData.categoryId,
          userId: resolution.playerData.userId,
          dayKey: resolution.clanData.date,
          lap: resolution.lap,
          bossIndex: resolution.bossIndex,
          targetAttackEntryId: attackEntry.attackEntryId,
          operationType: OperationLogType.FINISH,
          beforeKind: attackEntry.kind,
          afterKind: attackEntry.kind,
          beforeStatus,
          afterStatus: AttackEntryStatus.FINISHED,
          occurredAt: transitionAt,
        });
        this.syncProjectedStateForCategory(
          resolution.clanData.categoryId,
          resolution.clanData.date,
          transitionAt,
        );
      });

      await this.updateProgressMessages(resolution.clanData, resolution.lap, resolution.bossIndex, request);
      await this.syncNonProgressMessages(resolution.clanData, request, {
        updateSummary: true,
        updateRemainAttack: true,
      });
      return resolution.attackStatus;
    });
  }

  async defeatBoss(request: DefeatBossRequest): Promise<AttackStatus | null> {
    return this.options.runtimeStateService.withCategoryLock(request.categoryId, async () => {
      const dayGuardResult = this.options.runtimeStateService.get(request.categoryId)
        ? this.options.runtimeStateService.ensureDateUpToDateLocked(request.categoryId, this.clock)
        : null;
      const currentClanData = this.options.runtimeStateService.get(request.categoryId);
      await this.ensureCurrentRemainAttackMessage(currentClanData, dayGuardResult, request);
      await this.ensureCurrentSummaryMessage(currentClanData, dayGuardResult, request);

      const validation = await this.validateAttackRequest(request);
      if (!validation) {
        return null;
      }

      await request.responseChannel.send({
        content: formatDefeatBossMessage(request.member.displayName, validation.bossIndex + 1),
      });

      const resolution = await this.resolveDeclaredAttack(validation, request);
      if (!resolution) {
        return null;
      }

      if (resolution.bossStatusData.beated) {
        await request.responseChannel.send({
          content: ALREADY_DEFEATED_MESSAGE,
        });
        return null;
      }

      resolution.attackStatus.playerData.log.push({
        operationType: OperationType.LAST_ATTACK,
        lap: resolution.lap,
        bossIndex: resolution.bossIndex,
        playerData: resolution.attackStatus.playerData.toSnapshot(),
        beated: resolution.bossStatusData.beated,
      });

      if (resolution.attackStatus.attackType === AttackType.CARRYOVER) {
        const carryOverConsumed = await this.consumeCarryOver(
          resolution.attackStatus,
          request,
        );
        if (!carryOverConsumed) {
          return null;
        }
      } else {
        resolution.attackStatus.updateAttackLog();

        if (resolution.attackStatus.playerData.carryOverList.length < 3) {
          resolution.attackStatus.playerData.carryOverList.push(
            new CarryOver({
              attackType: resolution.attackStatus.attackType,
              bossIndex: resolution.bossIndex,
              created: now(this.clock),
            }),
          );
        }
      }

      resolution.attackStatus.attacked = true;
      resolution.bossStatusData.beated = true;
      const transitionAt = now(this.clock);

      const nextLap = resolution.lap + 1;
      const initializedNextLapProgressRow = this.ensureProgressRow(resolution.clanData, nextLap);
      const initializedNextLapBossStatus = this.ensureBossStatusLap(resolution.clanData, nextLap);

      runInTransaction(this.options.database, () => {
        this.attackStatusRepository.update(
          resolution.clanData.categoryId,
          resolution.lap,
          resolution.bossIndex,
          resolution.attackStatus,
        );
        this.bossStatusRepository.update(resolution.clanData.categoryId, resolution.bossStatusData);
        this.playerRepository.update(resolution.clanData.categoryId, resolution.playerData);
        this.carryOverRepository.replaceAll(
          resolution.clanData.categoryId,
          resolution.playerData.userId,
          resolution.playerData.carryOverList,
        );
        const attackEntry = this.upsertAttackEntrySnapshot(
          resolution.clanData.categoryId,
          resolution.clanData.date,
          resolution.lap,
          resolution.bossIndex,
          resolution.attackStatus,
        );
        const beforeStatus =
          this.findExistingAttackEntry(
            resolution.clanData.categoryId,
            resolution.playerData.userId,
            resolution.lap,
            resolution.bossIndex,
            resolution.attackStatus,
          )?.status ?? AttackEntryStatus.DECLARED;
        attackEntry.status = AttackEntryStatus.DEFEATED;
        attackEntry.resolvedAt = transitionAt;
        attackEntry.damage = this.normalizeAttackEntryDamage(resolution.attackStatus.damage);
        attackEntry.memo = this.normalizeAttackEntryMemo(resolution.attackStatus.memo);
        this.attackEntryRepository.update(attackEntry);
        this.insertOperationLog({
          categoryId: resolution.clanData.categoryId,
          userId: resolution.playerData.userId,
          dayKey: resolution.clanData.date,
          lap: resolution.lap,
          bossIndex: resolution.bossIndex,
          targetAttackEntryId: attackEntry.attackEntryId,
          operationType: OperationLogType.DEFEAT,
          beforeKind: attackEntry.kind,
          afterKind: attackEntry.kind,
          beforeStatus,
          afterStatus: AttackEntryStatus.DEFEATED,
          occurredAt: transitionAt,
        });
        this.expirePendingAttackEntriesAfterDefeat(
          resolution.clanData,
          resolution.bossStatusData,
          resolution.lap,
          resolution.bossIndex,
          resolution.attackStatus,
          transitionAt,
        );

        if (initializedNextLapProgressRow) {
          this.progressMessageIdRepository.insert(
            resolution.clanData.categoryId,
            nextLap,
            resolution.clanData.progressMessageIdsByLap.get(nextLap)!,
          );
        }

        if (initializedNextLapBossStatus) {
          this.bossStatusRepository.insertAllForLap(
            resolution.clanData.categoryId,
            resolution.clanData.bossStatusByLap.get(nextLap)!,
          );
        }
        this.syncProjectedStateForCategory(
          resolution.clanData.categoryId,
          resolution.clanData.date,
          transitionAt,
        );
      });

      await this.updateProgressMessages(resolution.clanData, resolution.lap, resolution.bossIndex, request);
      await this.ensureProgressMessage(resolution.clanData, nextLap, resolution.bossIndex, request);
      await this.syncNonProgressMessages(resolution.clanData, request, {
        updateSummary: true,
        updateRemainAttack: true,
      });
      return resolution.attackStatus;
    });
  }

  async setPendingDamage(request: SetPendingDamageRequest): Promise<AttackStatus | null> {
    return this.options.runtimeStateService.withCategoryLock(request.categoryId, async () => {
      const dayGuardResult = this.options.runtimeStateService.get(request.categoryId)
        ? this.options.runtimeStateService.ensureDateUpToDateLocked(request.categoryId, this.clock)
        : null;
      const currentClanData = this.options.runtimeStateService.get(request.categoryId);
      await this.ensureCurrentRemainAttackMessage(currentClanData, dayGuardResult, request);
      await this.ensureCurrentSummaryMessage(currentClanData, dayGuardResult, request);

      if (!Number.isInteger(request.damage) || request.damage <= 0) {
        await request.responseChannel.send({
          content: "ダメージは1以上の整数で入力してください。",
        });
        return null;
      }

      const validation = await this.validateAttackRequest(request);
      if (!validation) {
        return null;
      }

      const resolution = await this.resolveDeclaredAttack(validation, request);
      if (!resolution) {
        return null;
      }

      resolution.attackStatus.damage = request.damage;
      const transitionAt = now(this.clock);

      runInTransaction(this.options.database, () => {
        this.attackStatusRepository.update(
          resolution.clanData.categoryId,
          resolution.lap,
          resolution.bossIndex,
          resolution.attackStatus,
        );
        this.upsertAttackEntrySnapshot(
          resolution.clanData.categoryId,
          resolution.clanData.date,
          resolution.lap,
          resolution.bossIndex,
          resolution.attackStatus,
        );
        this.syncProjectedStateForCategory(
          resolution.clanData.categoryId,
          resolution.clanData.date,
          transitionAt,
        );
      });

      await request.responseChannel.send({
        content: `${request.member.displayName}の${resolution.lap}周目${resolution.bossIndex + 1}ボスのダメージを${request.damage.toLocaleString("en-US")}に設定しました。`,
      });
      await this.updateProgressMessages(resolution.clanData, resolution.lap, resolution.bossIndex, request);
      await this.syncNonProgressMessages(resolution.clanData, request, {
        updateSummary: true,
      });
      return resolution.attackStatus;
    });
  }

  async undo(request: UndoAttackRequest): Promise<boolean> {
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
          content: formatUndoMemberNotManagedMessage(request.member.displayName),
        });
        return false;
      }

      const bossIndex = await resolveUndoBossIndexState(clanData, request);
      if (bossIndex === null) {
        return false;
      }

      const operationLogs = this.options.runtimeStateService.getOperationLogs(clanData.categoryId);
      const operationTarget =
        request.lap !== undefined
          ? findUndoOperationTargetForProgressContextState({
              operationLogs,
              findAttackEntryById: (attackEntryId) =>
                this.attackEntryRepository.findById(attackEntryId),
              userId: playerData.userId,
              dayKey: clanData.date,
              bossIndex,
              lap: request.lap,
            })
          : findUndoOperationTargetForBossState({
              operationLogs,
              findAttackEntryById: (attackEntryId) =>
                this.attackEntryRepository.findById(attackEntryId),
              userId: playerData.userId,
              dayKey: clanData.date,
              bossIndex,
            });
      if (operationTarget) {
        if (
          isUndoBlockedByLaterOperationsState({
            targetOperationLog: operationTarget.operationLog,
            targetAttackEntry: operationTarget.attackEntry,
            attackEntries: this.findAttackEntriesForUserDay(
              clanData.categoryId,
              playerData.userId,
              clanData.date,
            ),
            resourceAdjustments: this.findResourceAdjustmentsForUserDay(
              clanData.categoryId,
              playerData.userId,
              clanData.date,
            ),
            operationLogs,
            battleAttackLimit: playerData.battleAttackLimit,
          })
        ) {
          await sendAttackResponse(
            request.responseChannel,
            {
              content: UNDO_BLOCKED_BY_LATER_OPERATIONS_MESSAGE,
            },
            { transient: true },
          );
          return false;
        }

        if (
          operationTarget.operationLog.operationType === OperationLogType.DEFEAT &&
          this.isDefeatUndoBlockedByNextLap(clanData, operationTarget.operationLog)
        ) {
          await sendAttackResponse(
            request.responseChannel,
            {
              content: UNDO_DEFEAT_BLOCKED_BY_NEXT_LAP_MESSAGE,
            },
            { transient: true },
          );
          return false;
        }

        if (!request.suppressSuccessResponse) {
          await sendAttackResponse(request.responseChannel, {
            content: formatUndoMessage(
              request.member.displayName,
              operationTarget.attackEntry.bossIndex + 1,
              toLegacyOperationTypeState(operationTarget.operationLog.operationType),
            ),
          });
        }

        if (operationTarget.operationLog.operationType === OperationLogType.DECLARE) {
          return this.undoAttackDeclareFromOperation(clanData, operationTarget, request);
        }

        return this.undoResolvedAttackFromOperation(clanData, operationTarget, request);
      }

      if (
        hasProjectedUndoState({
          attackEntries: this.options.runtimeStateService.getAttackEntries(clanData.categoryId),
          operationLogs,
        })
      ) {
        await sendAttackResponse(request.responseChannel, {
          content: UNDO_NOTHING_MESSAGE,
        });
        return false;
      }

      const logIndex =
        request.lap !== undefined
          ? findUndoLogIndexForProgressContextState(playerData.log, bossIndex, request.lap)
          : findUndoLogIndexForBossState(playerData.log, bossIndex);
      if (logIndex === undefined) {
        await sendAttackResponse(request.responseChannel, {
          content: UNDO_NOTHING_MESSAGE,
        });
        return false;
      }

      const logData = playerData.log[logIndex];
      if (!logData) {
        await sendAttackResponse(request.responseChannel, {
          content: UNDO_NOTHING_MESSAGE,
        });
        return false;
      }

      const bossStatusData = clanData.bossStatusByLap.get(logData.lap)?.[logData.bossIndex];
      if (!bossStatusData) {
        return true;
      }

      if (isUndoBlockedByLaterPlayerOperationsState(playerData.log, logIndex, logData)) {
        await sendAttackResponse(
          request.responseChannel,
          {
            content: UNDO_BLOCKED_BY_LATER_OPERATIONS_MESSAGE,
          },
          { transient: true },
        );
        return false;
      }

      if (
        logData.operationType === OperationType.LAST_ATTACK &&
        this.isDefeatUndoBlockedByNextLap(clanData, logData)
      ) {
        await sendAttackResponse(
          request.responseChannel,
          {
            content: UNDO_DEFEAT_BLOCKED_BY_NEXT_LAP_MESSAGE,
          },
          { transient: true },
        );
        return false;
      }

      if (!request.suppressSuccessResponse) {
        await sendAttackResponse(request.responseChannel, {
          content: formatUndoMessage(
            request.member.displayName,
            logData.bossIndex + 1,
            logData.operationType,
          ),
        });
      }

      if (logData.operationType === OperationType.ATTACK_DECLAR) {
        return this.undoAttackDeclare(
          clanData,
          playerData,
          logData,
          logIndex,
          bossStatusData,
          request,
        );
      }

      if (
        logData.operationType === OperationType.ATTACK ||
        logData.operationType === OperationType.LAST_ATTACK
      ) {
        return this.undoResolvedAttack(
          clanData,
          playerData,
          logData,
          logIndex,
          bossStatusData,
          request,
        );
      }

      return true;
    });
  }

  async correctAttackKind(request: CorrectAttackKindRequest): Promise<boolean> {
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
          content: formatNotManagedMessage(request.member.displayName),
        });
        return false;
      }

      const bossIndex = await this.resolveBossIndex(clanData, request);
      if (bossIndex === null) {
        return false;
      }

      const bossStatusData = clanData.bossStatusByLap.get(request.lap)?.[bossIndex];
      if (!bossStatusData) {
        await request.responseChannel.send({
          content: USER_MESSAGES.errors.invalidLap,
        });
        return false;
      }

      const sameDayAttackEntries = this.findAttackEntriesForUserDay(
        clanData.categoryId,
        playerData.userId,
        clanData.date,
      );
      const candidates = findCorrectableAttackEntriesState(
        sameDayAttackEntries,
        request.lap,
        bossIndex,
      );
      if (candidates.length === 0) {
        await request.responseChannel.send({
          content: CORRECT_ATTACK_KIND_NOTHING_MESSAGE,
        });
        return false;
      }

      const selectedAttackEntryId =
        candidates.length === 1
          ? candidates[0]?.attackEntryId ?? null
          : await request.selectAttackEntry?.({
              member: request.member,
              attackEntries: candidates,
              responseChannel: request.responseChannel,
            });
      if (!selectedAttackEntryId) {
        await request.responseChannel.send({
          content: CORRECT_ATTACK_KIND_CANCELLED_MESSAGE,
        });
        return false;
      }

      const targetAttackEntry = candidates.find(
        (attackEntry) => attackEntry.attackEntryId === selectedAttackEntryId,
      );
      if (!targetAttackEntry) {
        await request.responseChannel.send({
          content: CORRECT_ATTACK_KIND_NOTHING_MESSAGE,
        });
        return false;
      }

      const sameDayResourceAdjustments = this.findResourceAdjustmentsForUserDay(
        clanData.categoryId,
        playerData.userId,
        clanData.date,
      );
      const correctionPreparation = prepareAttackKindCorrection({
        sameDayAttackEntries,
        sameDayResourceAdjustments,
        targetAttackEntryId: targetAttackEntry.attackEntryId,
        battleAttackLimit: playerData.battleAttackLimit,
      });
      if (correctionPreparation.kind === "target-not-found") {
        await request.responseChannel.send({
          content: CORRECT_ATTACK_KIND_NOTHING_MESSAGE,
        });
        return false;
      }

      if (correctionPreparation.kind === "invalid-resource-progression") {
        await request.responseChannel.send({
          content: CORRECT_ATTACK_KIND_INVALID_MESSAGE,
        });
        return false;
      }

      const { nextKind, nextAttackType, simulatedAttackEntries } = correctionPreparation;
      const runtimeAttackStatus = this.findRuntimeAttackStatus(clanData, targetAttackEntry);
      if (!runtimeAttackStatus) {
        await request.responseChannel.send({
          content: CORRECT_ATTACK_KIND_NOTHING_MESSAGE,
        });
        return false;
      }

      const transitionAt = now(this.clock);

      runInTransaction(this.options.database, () => {
        targetAttackEntry.kind = nextKind;
        this.attackEntryRepository.update(targetAttackEntry);
        runtimeAttackStatus.setAttackType(nextAttackType);
        this.attackStatusRepository.update(
          clanData.categoryId,
          targetAttackEntry.lap,
          targetAttackEntry.bossIndex,
          runtimeAttackStatus,
        );
        this.rebuildLegacyPlayerStateFromAttackEntries(playerData, simulatedAttackEntries);
        this.playerRepository.update(clanData.categoryId, playerData);
        this.carryOverRepository.replaceAll(clanData.categoryId, playerData.userId, playerData.carryOverList);
        this.insertOperationLog({
          categoryId: clanData.categoryId,
          userId: playerData.userId,
          dayKey: clanData.date,
          lap: targetAttackEntry.lap,
          bossIndex: targetAttackEntry.bossIndex,
          targetAttackEntryId: targetAttackEntry.attackEntryId,
          operationType: OperationLogType.CORRECT_KIND,
          beforeKind:
            nextKind === AttackEntryKind.BATTLE ? AttackEntryKind.CARRYOVER : AttackEntryKind.BATTLE,
          afterKind: nextKind,
          beforeStatus: targetAttackEntry.status,
          afterStatus: targetAttackEntry.status,
          occurredAt: transitionAt,
        });
        this.syncProjectedStateForCategory(clanData.categoryId, clanData.date, transitionAt);
      });

      await request.responseChannel.send({
        content: `${request.member.displayName}の${request.lap}周目${bossIndex + 1}ボスの攻撃を\`${nextAttackType}\`に入替えます。`,
      });
      await this.updateProgressMessages(clanData, targetAttackEntry.lap, targetAttackEntry.bossIndex, request);
      await this.syncNonProgressMessages(clanData, request, {
        updateSummary: true,
        updateRemainAttack: true,
      });
      return true;
    });
  }

  async applyMessageDamage(request: MessageDamageRequest): Promise<boolean> {
    return this.options.runtimeStateService.withCategoryLock(request.categoryId, async () => {
      const dayGuardResult = this.options.runtimeStateService.get(request.categoryId)
        ? this.options.runtimeStateService.ensureDateUpToDateLocked(request.categoryId, this.clock)
        : null;

      const clanData = this.options.runtimeStateService.get(request.categoryId);
      await this.ensureCurrentRemainAttackMessage(clanData, dayGuardResult, request);
      await this.ensureCurrentSummaryMessage(clanData, dayGuardResult, request);
      if (!clanData) {
        return false;
      }

      const bossIndex = clanData.getBossIndexFromChannelId(request.channelId);
      if (bossIndex === undefined) {
        return false;
      }

      const playerData = clanData.getPlayerData(request.member.id);
      if (!playerData) {
        return false;
      }

      const messageDamageTarget = findMessageDamageTargetState({
        clanData,
        bossIndex,
        playerData,
        messageContent: request.messageContent,
      });
      if (!messageDamageTarget) {
        return false;
      }

      messageDamageTarget.attackStatus.damage = messageDamageTarget.parsedDamage.damage;
      messageDamageTarget.attackStatus.memo = messageDamageTarget.parsedDamage.memo;
      const transitionAt = now(this.clock);

      runInTransaction(this.options.database, () => {
        this.attackStatusRepository.update(
          clanData.categoryId,
          messageDamageTarget.lap,
          bossIndex,
          messageDamageTarget.attackStatus,
        );
        this.upsertAttackEntrySnapshot(
          clanData.categoryId,
          clanData.date,
          messageDamageTarget.lap,
          bossIndex,
          messageDamageTarget.attackStatus,
        );
        this.syncProjectedStateForCategory(clanData.categoryId, clanData.date, transitionAt);
      });

      await this.updateProgressMessages(clanData, messageDamageTarget.lap, bossIndex, request);
      await this.syncNonProgressMessages(clanData, request, {
        updateSummary: true,
      });
      return true;
    });
  }

  private async validateAttackRequest(
    request: AttackServiceBaseRequest,
  ): Promise<ValidatedAttackRequest | null> {
    return validateAttackRequestState(request, {
      getClanData: (categoryId) => this.options.runtimeStateService.get(categoryId),
      ensureBossStatusRowsForExistingLap: (clanData, lap) =>
        this.ensureBossStatusRowsForExistingLap(clanData, lap),
    });
  }

  private async resolveDeclaredAttack(
    validation: ValidatedAttackRequest,
    request: AttackServiceBaseRequest,
  ): Promise<ValidatedResolutionRequest | null> {
    return resolveDeclaredAttackState(validation, request);
  }

  private normalizeAttackEntryDamage(damage: number): number | null {
    return normalizeAttackEntryDamageValue(damage);
  }

  private normalizeAttackEntryMemo(memo: string): string | null {
    return normalizeAttackEntryMemoValue(memo);
  }

  private findExistingAttackEntry(
    categoryId: string,
    userId: string,
    lap: number,
    bossIndex: number,
    attackStatus: AttackStatus,
  ): AttackEntry | null {
    return findExistingAttackEntryRecord({
      attackEntryRepository: this.attackEntryRepository,
      categoryId,
      userId,
      lap,
      bossIndex,
      attackStatus,
    });
  }

  private createAttackEntryFromAttackStatus(
    categoryId: string,
    dayKey: string,
    lap: number,
    bossIndex: number,
    attackStatus: AttackStatus,
  ): AttackEntry {
    return createAttackEntryFromAttackStatusRecord({
      categoryId,
      dayKey,
      lap,
      bossIndex,
      attackStatus,
    });
  }

  private upsertAttackEntrySnapshot(
    categoryId: string,
    dayKey: string,
    lap: number,
    bossIndex: number,
    attackStatus: AttackStatus,
  ): AttackEntry {
    return upsertAttackEntrySnapshotRecord({
      attackEntryRepository: this.attackEntryRepository,
      categoryId,
      dayKey,
      lap,
      bossIndex,
      attackStatus,
    });
  }

  private insertOperationLog(params: {
    categoryId: string;
    userId: string;
    dayKey: string;
    lap: number;
    bossIndex: number;
    targetAttackEntryId: string;
    operationType: OperationLogType;
    beforeKind?: AttackEntryKind | null;
    afterKind?: AttackEntryKind | null;
    beforeStatus?: AttackEntryStatus | null;
    afterStatus?: AttackEntryStatus | null;
    occurredAt: Date;
  }): void {
    this.operationLogRepository.insert(
      new OperationLog({
        operationId: randomUUID(),
        categoryId: params.categoryId,
        userId: params.userId,
        dayKey: params.dayKey,
        lap: params.lap,
        bossIndex: params.bossIndex,
        targetAttackEntryId: params.targetAttackEntryId,
        operationType: params.operationType,
        beforeKind: params.beforeKind ?? null,
        afterKind: params.afterKind ?? null,
        beforeStatus: params.beforeStatus ?? null,
        afterStatus: params.afterStatus ?? null,
        occurredAt: params.occurredAt,
      }),
    );
  }

  private expirePendingAttackEntriesAfterDefeat(
    clanData: ClanData,
    bossStatusData: BossStatusData,
    lap: number,
    bossIndex: number,
    resolvedAttackStatus: AttackStatus,
    transitionAt: Date,
  ): void {
    for (const attackStatus of bossStatusData.attackPlayers) {
      if (attackStatus === resolvedAttackStatus || attackStatus.attacked) {
        continue;
      }

      const existing = this.findExistingAttackEntry(
        clanData.categoryId,
        attackStatus.playerData.userId,
        lap,
        bossIndex,
        attackStatus,
      );
      const attackEntry =
        existing ??
        this.createAttackEntryFromAttackStatus(
          clanData.categoryId,
          clanData.date,
          lap,
          bossIndex,
          attackStatus,
        );

      if (attackEntry.status === AttackEntryStatus.EXPIRED) {
        continue;
      }

      const beforeStatus = attackEntry.status;
      attackEntry.status = AttackEntryStatus.EXPIRED;
      attackEntry.resolvedAt = transitionAt;
      attackEntry.damage = this.normalizeAttackEntryDamage(attackStatus.damage);
      attackEntry.memo = this.normalizeAttackEntryMemo(attackStatus.memo);

      if (existing) {
        this.attackEntryRepository.update(attackEntry);
      } else {
        this.attackEntryRepository.insert(attackEntry);
      }

      this.insertOperationLog({
        categoryId: clanData.categoryId,
        userId: attackEntry.userId,
        dayKey: attackEntry.dayKey,
        lap,
        bossIndex,
        targetAttackEntryId: attackEntry.attackEntryId,
        operationType: OperationLogType.EXPIRE,
        beforeKind: attackEntry.kind,
        afterKind: attackEntry.kind,
        beforeStatus,
        afterStatus: AttackEntryStatus.EXPIRED,
        occurredAt: transitionAt,
      });
    }
  }

  private syncProjectedStateForCategory(
    categoryId: string,
    dayKey: string,
    transitionAt: Date,
  ): void {
    this.options.runtimeStateService.syncProjectedStateForCategory(categoryId, dayKey, transitionAt);
  }

  private findAttackEntriesForUserDay(
    categoryId: string,
    userId: string,
    dayKey: string,
  ): AttackEntry[] {
    return this.options.runtimeStateService
      .getAttackEntries(categoryId)
      .filter((attackEntry) => attackEntry.userId === userId && attackEntry.dayKey === dayKey)
      .sort((left, right) => {
        const declaredDiff = left.declaredAt.getTime() - right.declaredAt.getTime();
        if (declaredDiff !== 0) {
          return declaredDiff;
        }

        return left.attackEntryId.localeCompare(right.attackEntryId);
      });
  }

  private findResourceAdjustmentsForUserDay(
    categoryId: string,
    userId: string,
    dayKey: string,
  ) {
    return this.resourceAdjustmentRepository
      .findAllByCategory(categoryId)
      .filter(
        (resourceAdjustment) =>
          resourceAdjustment.userId === userId && resourceAdjustment.dayKey === dayKey,
      );
  }

  private isProjectedLegacyStateInSync(
    categoryId: string,
    playerData: PlayerData,
    dayKey: string,
  ): boolean {
    const projectedState = this.options.runtimeStateService.getPlayerResourceState(
      categoryId,
      playerData.userId,
      dayKey,
    );

    if (!projectedState) {
      return false;
    }

    return (
      playerData.battleAttackCount === projectedState.battleConsumedCount &&
      playerData.carryOverList.length === projectedState.totalCarryCount
    );
  }

  private findMatchingLegacyLogIndex(
    logList: readonly LogData[],
    operationLog: OperationLog,
  ): number | undefined {
    const targetOperationType = toLegacyOperationTypeState(operationLog.operationType);

    for (let index = logList.length - 1; index >= 0; index -= 1) {
      const logData = logList[index];
      if (!logData) {
        continue;
      }

      if (
        logData.operationType === targetOperationType &&
        logData.lap === operationLog.lap &&
        logData.bossIndex === operationLog.bossIndex
      ) {
        return index;
      }
    }

    return undefined;
  }

  private findRuntimeAttackStatus(
    clanData: ClanData,
    attackEntry: AttackEntry,
  ): AttackStatus | null {
    const attackPlayers =
      clanData.bossStatusByLap.get(attackEntry.lap)?.[attackEntry.bossIndex]?.attackPlayers ?? [];

    return (
      attackPlayers.find(
        (attackStatus) =>
          attackStatus.playerData.userId === attackEntry.userId &&
          attackStatus.created.getTime() === attackEntry.declaredAt.getTime(),
      ) ?? null
    );
  }

  private createRuntimeAttackStatusFromAttackEntry(
    playerData: PlayerData,
    attackEntry: AttackEntry,
  ): AttackStatus {
    return new AttackStatus({
      playerData,
      attackType:
        attackEntry.kind === AttackEntryKind.CARRYOVER
          ? AttackType.CARRYOVER
          : AttackType.BATTLE,
      carryOver: attackEntry.kind === AttackEntryKind.CARRYOVER,
      attacked:
        attackEntry.status === AttackEntryStatus.FINISHED ||
        attackEntry.status === AttackEntryStatus.DEFEATED,
      damage: attackEntry.damage ?? 0,
      memo: attackEntry.memo ?? "",
      created: attackEntry.declaredAt,
    });
  }

  private persistLegacyProjectionState(clanData: ClanData): void {
    for (const playerData of clanData.playerDataMap.values()) {
      this.playerRepository.update(clanData.categoryId, playerData);
      this.carryOverRepository.replaceAll(
        clanData.categoryId,
        playerData.userId,
        playerData.carryOverList,
      );
    }
  }

  private rebuildLegacyPlayerStateFromAttackEntries(
    playerData: PlayerData,
    attackEntries: readonly AttackEntry[],
  ): void {
    const consumedCarryAttackEntries = attackEntries.filter(
      (attackEntry) =>
        attackEntry.kind === AttackEntryKind.CARRYOVER &&
        (attackEntry.status === AttackEntryStatus.FINISHED ||
          attackEntry.status === AttackEntryStatus.DEFEATED),
    );
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
      .sort(compareCarryOversOldestFirst);

    playerData.battleAttackCount = attackEntries.filter(
      (attackEntry) =>
        attackEntry.kind === AttackEntryKind.BATTLE &&
        (attackEntry.status === AttackEntryStatus.FINISHED ||
          attackEntry.status === AttackEntryStatus.DEFEATED),
    ).length;
    playerData.carryOverList = producedCarryOvers.slice(
      Math.min(consumedCarryAttackEntries.length, producedCarryOvers.length),
    );
  }

  private invalidateLatestOperationLog(params: {
    categoryId: string;
    userId: string;
    lap: number;
    bossIndex: number;
    targetAttackEntryId: string;
    operationType: OperationLogType;
    transitionAt: Date;
  }): OperationLog | null {
    const targetOperationLog = this.operationLogRepository
      .findAllByCategory(params.categoryId)
      .filter(
        (operationLog) =>
          operationLog.userId === params.userId &&
          operationLog.lap === params.lap &&
          operationLog.bossIndex === params.bossIndex &&
          operationLog.targetAttackEntryId === params.targetAttackEntryId &&
          operationLog.operationType === params.operationType &&
          operationLog.invalidatedAt === null,
      )
      .sort((left, right) => {
        const occurredAtDiff = right.occurredAt.getTime() - left.occurredAt.getTime();
        if (occurredAtDiff !== 0) {
          return occurredAtDiff;
        }

        return right.operationId.localeCompare(left.operationId);
      })[0] ?? null;

    if (!targetOperationLog) {
      return null;
    }

    targetOperationLog.invalidatedAt = params.transitionAt;
    this.operationLogRepository.update(targetOperationLog);
    return targetOperationLog;
  }

  private restoreExpiredAttackEntriesAfterDefeatUndo(params: {
    categoryId: string;
    lap: number;
    bossIndex: number;
    defeatOccurredAt: Date | null;
    transitionAt: Date;
  }): void {
    if (!params.defeatOccurredAt) {
      return;
    }

    const defeatOccurredAtTime = params.defeatOccurredAt.getTime();

    const expireOperationLogs = this.operationLogRepository
      .findAllByCategory(params.categoryId)
      .filter(
        (operationLog) =>
          operationLog.operationType === OperationLogType.EXPIRE &&
          operationLog.lap === params.lap &&
          operationLog.bossIndex === params.bossIndex &&
          operationLog.invalidatedAt === null &&
          operationLog.occurredAt.getTime() === defeatOccurredAtTime,
      );

    for (const expireOperationLog of expireOperationLogs) {
      const attackEntry = this.attackEntryRepository.findById(expireOperationLog.targetAttackEntryId);
      if (!attackEntry || attackEntry.status !== AttackEntryStatus.EXPIRED) {
        expireOperationLog.invalidatedAt = params.transitionAt;
        this.operationLogRepository.update(expireOperationLog);
        continue;
      }

      attackEntry.status = AttackEntryStatus.DECLARED;
      attackEntry.resolvedAt = null;
      this.attackEntryRepository.update(attackEntry);

      expireOperationLog.invalidatedAt = params.transitionAt;
      this.operationLogRepository.update(expireOperationLog);
    }
  }

  private async undoAttackDeclareFromOperation(
    clanData: ClanData,
    operationTarget: UndoOperationTarget,
    request: UndoAttackRequest,
  ): Promise<boolean> {
    const playerData = clanData.getPlayerData(operationTarget.attackEntry.userId);
    if (!playerData) {
      return false;
    }

    const bossStatusData =
      clanData.bossStatusByLap.get(operationTarget.attackEntry.lap)?.[
        operationTarget.attackEntry.bossIndex
      ];
    if (!bossStatusData) {
      return true;
    }

    const runtimeAttackStatus =
      this.findRuntimeAttackStatus(clanData, operationTarget.attackEntry) ??
      this.createRuntimeAttackStatusFromAttackEntry(playerData, operationTarget.attackEntry);
    const attackStatusIndex = bossStatusData.attackPlayers.findIndex(
      (attackStatus) =>
        attackStatus.playerData.userId === runtimeAttackStatus.playerData.userId &&
        attackStatus.created.getTime() === runtimeAttackStatus.created.getTime(),
    );
    const transitionAt = now(this.clock);
    const isProjectedLegacyStateInSync = this.isProjectedLegacyStateInSync(
      clanData.categoryId,
      playerData,
      clanData.date,
    );
    const matchingLegacyLogIndex = this.findMatchingLegacyLogIndex(
      playerData.log,
      operationTarget.operationLog,
    );

    if (attackStatusIndex !== -1) {
      bossStatusData.attackPlayers.splice(attackStatusIndex, 1);
    }

    if (matchingLegacyLogIndex !== undefined) {
      playerData.log.splice(matchingLegacyLogIndex, 1);
    }

    runInTransaction(this.options.database, () => {
      this.attackStatusRepository.delete(
        clanData.categoryId,
        operationTarget.attackEntry.lap,
        operationTarget.attackEntry.bossIndex,
        runtimeAttackStatus,
      );
      operationTarget.attackEntry.status = AttackEntryStatus.UNDONE;
      operationTarget.attackEntry.resolvedAt = transitionAt;
      this.attackEntryRepository.update(operationTarget.attackEntry);
      this.invalidateLatestOperationLog({
        categoryId: clanData.categoryId,
        userId: operationTarget.attackEntry.userId,
        lap: operationTarget.attackEntry.lap,
        bossIndex: operationTarget.attackEntry.bossIndex,
        targetAttackEntryId: operationTarget.attackEntry.attackEntryId,
        operationType: operationTarget.operationLog.operationType,
        transitionAt,
      });
      this.insertOperationLog({
        categoryId: clanData.categoryId,
        userId: operationTarget.attackEntry.userId,
        dayKey: clanData.date,
        lap: operationTarget.attackEntry.lap,
        bossIndex: operationTarget.attackEntry.bossIndex,
        targetAttackEntryId: operationTarget.attackEntry.attackEntryId,
        operationType: OperationLogType.UNDO,
        beforeKind: operationTarget.attackEntry.kind,
        afterKind: operationTarget.attackEntry.kind,
        beforeStatus: AttackEntryStatus.DECLARED,
        afterStatus: AttackEntryStatus.UNDONE,
        occurredAt: transitionAt,
      });
      this.syncProjectedStateForCategory(clanData.categoryId, clanData.date, transitionAt);
      if (isProjectedLegacyStateInSync) {
        this.rebuildLegacyPlayerStateFromAttackEntries(
          playerData,
          this.findAttackEntriesForUserDay(
            clanData.categoryId,
            playerData.userId,
            clanData.date,
          ),
        );
      }
      this.persistLegacyProjectionState(clanData);
    });

    await this.updateProgressMessages(
      clanData,
      operationTarget.attackEntry.lap,
      operationTarget.attackEntry.bossIndex,
      request,
    );
    await this.syncNonProgressMessages(clanData, request, {
      updateSummary: true,
      updateRemainAttack: true,
    });
    return true;
  }

  private async undoResolvedAttackFromOperation(
    clanData: ClanData,
    operationTarget: UndoOperationTarget,
    request: UndoAttackRequest,
  ): Promise<boolean> {
    const playerData = clanData.getPlayerData(operationTarget.attackEntry.userId);
    if (!playerData) {
      return false;
    }

    const bossStatusData =
      clanData.bossStatusByLap.get(operationTarget.attackEntry.lap)?.[
        operationTarget.attackEntry.bossIndex
      ];
    if (!bossStatusData) {
      return true;
    }

    const runtimeAttackStatus =
      this.findRuntimeAttackStatus(clanData, operationTarget.attackEntry) ??
      this.createRuntimeAttackStatusFromAttackEntry(playerData, operationTarget.attackEntry);
    const transitionAt = now(this.clock);
    const defeatOccurredAt =
      operationTarget.operationLog.operationType === OperationLogType.DEFEAT
        ? operationTarget.attackEntry.resolvedAt
        : null;
    const isProjectedLegacyStateInSync = this.isProjectedLegacyStateInSync(
      clanData.categoryId,
      playerData,
      clanData.date,
    );
    const matchingLegacyLogIndex = this.findMatchingLegacyLogIndex(
      playerData.log,
      operationTarget.operationLog,
    );
    const matchingLegacyLog =
      matchingLegacyLogIndex === undefined ? null : playerData.log[matchingLegacyLogIndex] ?? null;

    runtimeAttackStatus.attacked = false;
    if (operationTarget.operationLog.operationType === OperationLogType.DEFEAT) {
      bossStatusData.beated = false;
    }

    if (!isProjectedLegacyStateInSync && matchingLegacyLog?.playerData) {
      playerData.applySnapshot(matchingLegacyLog.playerData);
    }
    if (matchingLegacyLogIndex !== undefined) {
      playerData.log.splice(matchingLegacyLogIndex, 1);
    }

    runInTransaction(this.options.database, () => {
      this.attackStatusRepository.reverse(
        clanData.categoryId,
        operationTarget.attackEntry.lap,
        operationTarget.attackEntry.bossIndex,
        runtimeAttackStatus,
      );
      if (operationTarget.operationLog.operationType === OperationLogType.DEFEAT) {
        this.bossStatusRepository.update(clanData.categoryId, bossStatusData);
      }

      operationTarget.attackEntry.status = AttackEntryStatus.DECLARED;
      operationTarget.attackEntry.resolvedAt = null;
      this.attackEntryRepository.update(operationTarget.attackEntry);
      this.invalidateLatestOperationLog({
        categoryId: clanData.categoryId,
        userId: operationTarget.attackEntry.userId,
        lap: operationTarget.attackEntry.lap,
        bossIndex: operationTarget.attackEntry.bossIndex,
        targetAttackEntryId: operationTarget.attackEntry.attackEntryId,
        operationType: operationTarget.operationLog.operationType,
        transitionAt,
      });

      if (operationTarget.operationLog.operationType === OperationLogType.DEFEAT) {
        this.restoreExpiredAttackEntriesAfterDefeatUndo({
          categoryId: clanData.categoryId,
          lap: operationTarget.attackEntry.lap,
          bossIndex: operationTarget.attackEntry.bossIndex,
          defeatOccurredAt,
          transitionAt,
        });
      }

      this.insertOperationLog({
        categoryId: clanData.categoryId,
        userId: operationTarget.attackEntry.userId,
        dayKey: clanData.date,
        lap: operationTarget.attackEntry.lap,
        bossIndex: operationTarget.attackEntry.bossIndex,
        targetAttackEntryId: operationTarget.attackEntry.attackEntryId,
        operationType: OperationLogType.UNDO,
        beforeKind: operationTarget.attackEntry.kind,
        afterKind: operationTarget.attackEntry.kind,
        beforeStatus:
          operationTarget.operationLog.operationType === OperationLogType.DEFEAT
            ? AttackEntryStatus.DEFEATED
            : AttackEntryStatus.FINISHED,
        afterStatus: AttackEntryStatus.DECLARED,
        occurredAt: transitionAt,
      });
      this.syncProjectedStateForCategory(clanData.categoryId, clanData.date, transitionAt);
      if (isProjectedLegacyStateInSync) {
        this.rebuildLegacyPlayerStateFromAttackEntries(
          playerData,
          this.findAttackEntriesForUserDay(
            clanData.categoryId,
            playerData.userId,
            clanData.date,
          ),
        );
      }
      this.persistLegacyProjectionState(clanData);
    });

    if (operationTarget.operationLog.operationType === OperationLogType.DEFEAT) {
      await this.cleanupGeneratedNextLapState(
        clanData,
        {
          lap: operationTarget.attackEntry.lap,
          bossIndex: operationTarget.attackEntry.bossIndex,
        },
        request,
      );
    }

    await this.updateProgressMessages(
      clanData,
      operationTarget.attackEntry.lap,
      operationTarget.attackEntry.bossIndex,
      request,
    );
    await this.syncNonProgressMessages(clanData, request, {
      updateSummary: true,
      updateRemainAttack: true,
    });
    return true;
  }

  private async resolveBossIndex(
    clanData: ClanData,
    request: AttackServiceBaseRequest,
  ): Promise<number | null> {
    return resolveAttackBossIndex(clanData, request);
  }

  private async undoAttackDeclare(
    clanData: ClanData,
    playerData: PlayerData,
    logData: LogData,
    logIndex: number,
    bossStatusData: BossStatusData,
    request: UndoAttackRequest,
  ): Promise<boolean> {
    const attackStatusIndex = bossStatusData.getAttackStatusIndex(playerData, false);
    if (attackStatusIndex === undefined) {
      return true;
    }

    const attackStatus = bossStatusData.attackPlayers[attackStatusIndex];
    if (!attackStatus) {
      return true;
    }

    const transitionAt = now(this.clock);
    const existingAttackEntry = this.findExistingAttackEntry(
      clanData.categoryId,
      playerData.userId,
      logData.lap,
      logData.bossIndex,
      attackStatus,
    );
    const attackEntry =
      existingAttackEntry ??
      this.createAttackEntryFromAttackStatus(
        clanData.categoryId,
        clanData.date,
        logData.lap,
        logData.bossIndex,
        attackStatus,
      );
    const beforeStatus = attackEntry.status;

    bossStatusData.attackPlayers.splice(attackStatusIndex, 1);
    playerData.log.splice(logIndex, 1);

    runInTransaction(this.options.database, () => {
      this.attackStatusRepository.delete(clanData.categoryId, logData.lap, logData.bossIndex, attackStatus);
      attackEntry.status = AttackEntryStatus.UNDONE;
      attackEntry.resolvedAt = transitionAt;
      attackEntry.damage = this.normalizeAttackEntryDamage(attackStatus.damage);
      attackEntry.memo = this.normalizeAttackEntryMemo(attackStatus.memo);
      if (existingAttackEntry) {
        this.attackEntryRepository.update(attackEntry);
      } else {
        this.attackEntryRepository.insert(attackEntry);
      }

      this.invalidateLatestOperationLog({
        categoryId: clanData.categoryId,
        userId: playerData.userId,
        lap: logData.lap,
        bossIndex: logData.bossIndex,
        targetAttackEntryId: attackEntry.attackEntryId,
        operationType: toOperationLogTypeState(logData.operationType),
        transitionAt,
      });
      this.insertOperationLog({
        categoryId: clanData.categoryId,
        userId: playerData.userId,
        dayKey: clanData.date,
        lap: logData.lap,
        bossIndex: logData.bossIndex,
        targetAttackEntryId: attackEntry.attackEntryId,
        operationType: OperationLogType.UNDO,
        beforeKind: attackEntry.kind,
        afterKind: attackEntry.kind,
        beforeStatus,
        afterStatus: AttackEntryStatus.UNDONE,
        occurredAt: transitionAt,
      });
      this.syncProjectedStateForCategory(clanData.categoryId, clanData.date, transitionAt);
    });

    await this.updateProgressMessages(clanData, logData.lap, logData.bossIndex, request);
    await this.syncNonProgressMessages(clanData, request, {
      updateSummary: true,
    });
    return true;
  }

  private async undoResolvedAttack(
    clanData: ClanData,
    playerData: PlayerData,
    logData: LogData,
    logIndex: number,
    bossStatusData: BossStatusData,
    request: UndoAttackRequest,
  ): Promise<boolean> {
    const attackStatusIndex = bossStatusData.getAttackStatusIndex(playerData, true);
    if (attackStatusIndex === undefined) {
      return true;
    }

    const attackStatus = bossStatusData.attackPlayers[attackStatusIndex];
    if (!attackStatus) {
      return true;
    }

    const transitionAt = now(this.clock);
    const existingAttackEntry = this.findExistingAttackEntry(
      clanData.categoryId,
      playerData.userId,
      logData.lap,
      logData.bossIndex,
      attackStatus,
    );
    const attackEntry =
      existingAttackEntry ??
      this.createAttackEntryFromAttackStatus(
        clanData.categoryId,
        clanData.date,
        logData.lap,
        logData.bossIndex,
        attackStatus,
      );
    const beforeStatus = attackEntry.status;
    const defeatOccurredAt = logData.operationType === OperationType.LAST_ATTACK ? attackEntry.resolvedAt : null;

    if (logData.playerData) {
      playerData.applySnapshot(logData.playerData);
    }

    attackStatus.attacked = false;

    if (logData.operationType === OperationType.LAST_ATTACK && logData.beated !== undefined) {
      bossStatusData.beated = logData.beated;
    }

    playerData.log.splice(logIndex, 1);

    runInTransaction(this.options.database, () => {
      this.attackStatusRepository.reverse(clanData.categoryId, logData.lap, logData.bossIndex, attackStatus);

      if (logData.operationType === OperationType.LAST_ATTACK) {
        this.bossStatusRepository.update(clanData.categoryId, bossStatusData);
      }

      this.playerRepository.update(clanData.categoryId, playerData);
      this.carryOverRepository.replaceAll(clanData.categoryId, playerData.userId, playerData.carryOverList);

      attackEntry.status = AttackEntryStatus.DECLARED;
      attackEntry.resolvedAt = null;
      attackEntry.damage = this.normalizeAttackEntryDamage(attackStatus.damage);
      attackEntry.memo = this.normalizeAttackEntryMemo(attackStatus.memo);
      if (existingAttackEntry) {
        this.attackEntryRepository.update(attackEntry);
      } else {
        this.attackEntryRepository.insert(attackEntry);
      }

      this.invalidateLatestOperationLog({
        categoryId: clanData.categoryId,
        userId: playerData.userId,
        lap: logData.lap,
        bossIndex: logData.bossIndex,
        targetAttackEntryId: attackEntry.attackEntryId,
        operationType: toOperationLogTypeState(logData.operationType),
        transitionAt,
      });

      if (logData.operationType === OperationType.LAST_ATTACK) {
        this.restoreExpiredAttackEntriesAfterDefeatUndo({
          categoryId: clanData.categoryId,
          lap: logData.lap,
          bossIndex: logData.bossIndex,
          defeatOccurredAt,
          transitionAt,
        });
      }

      this.insertOperationLog({
        categoryId: clanData.categoryId,
        userId: playerData.userId,
        dayKey: clanData.date,
        lap: logData.lap,
        bossIndex: logData.bossIndex,
        targetAttackEntryId: attackEntry.attackEntryId,
        operationType: OperationLogType.UNDO,
        beforeKind: attackEntry.kind,
        afterKind: attackEntry.kind,
        beforeStatus,
        afterStatus: AttackEntryStatus.DECLARED,
        occurredAt: transitionAt,
      });
      this.syncProjectedStateForCategory(clanData.categoryId, clanData.date, transitionAt);
    });

    if (logData.operationType === OperationType.LAST_ATTACK) {
      await this.cleanupGeneratedNextLapState(clanData, logData, request);
    }

    await this.updateProgressMessages(clanData, logData.lap, logData.bossIndex, request);
    await this.syncNonProgressMessages(clanData, request, {
      updateSummary: true,
      updateRemainAttack: true,
    });
    return true;
  }

  private isDefeatUndoBlockedByNextLap(
    clanData: ClanData,
    context: { lap: number; bossIndex: number },
  ): boolean {
    const nextLap = context.lap + 1;
    return hasAnyAttackPlayers(clanData.bossStatusByLap.get(nextLap)?.[context.bossIndex]);
  }

  private async cleanupGeneratedNextLapState(
    clanData: ClanData,
    context: { lap: number; bossIndex: number },
    request: UndoAttackRequest,
  ): Promise<void> {
    await this.messageCoordinator.cleanupGeneratedNextLapState(clanData, context, request);
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

  private async consumeCarryOver(
    attackStatus: AttackStatus,
    request: AttackFinishRequest | DefeatBossRequest,
  ): Promise<boolean> {
    const carryOverList = attackStatus.playerData.carryOverList;
    if (carryOverList.length === 0) {
      attackStatus.playerData.log.pop();
      await request.responseChannel.send({
        content: formatCarryOverMissingMessage(request.member.id),
      });
      return false;
    }

    carryOverList.sort(compareCarryOversOldestFirst);
    carryOverList.splice(0, 1);
    return true;
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

  private async updateProgressMessages(
    clanData: ClanData,
    lap: number,
    bossIndex: number,
    request: AttackRenderContext,
  ): Promise<void> {
    await this.messageCoordinator.updateProgressMessages(clanData, lap, bossIndex, request);
  }

  private async ensureProgressMessage(
    clanData: ClanData,
    lap: number,
    bossIndex: number,
    request: AttackRenderContext,
  ): Promise<void> {
    await this.messageCoordinator.ensureProgressMessage(clanData, lap, bossIndex, request);
  }

  private async updateRemainAttackMessage(
    clanData: ClanData,
    request: AttackRenderContext,
  ): Promise<void> {
    await this.messageCoordinator.updateRemainAttackMessage(clanData, request);
  }

  private async updateSummaryMessage(
    clanData: ClanData,
    request: AttackRenderContext,
  ): Promise<void> {
    await this.messageCoordinator.updateSummaryMessage(clanData, request);
  }

  private async syncNonProgressMessages(
    clanData: ClanData,
    request: AttackRenderContext,
    options: {
      updateSummary?: boolean;
      updateRemainAttack?: boolean;
    },
  ): Promise<void> {
    const job: DeferredNonProgressSyncJob<AttackRenderContext> = {
      request,
      updateSummary: options.updateSummary ?? false,
      updateRemainAttack: options.updateRemainAttack ?? false,
    };

    if (!request.deferNonProgressMessageUpdates) {
      await this.runNonProgressMessageUpdates(clanData, job);
      return;
    }

    this.deferredNonProgressMessageSyncQueue.schedule(clanData.categoryId, job);
  }

  private async runNonProgressMessageUpdates(
    clanData: ClanData,
    job: DeferredNonProgressSyncJob<AttackRenderContext>,
  ): Promise<void> {
    if (job.updateSummary) {
      await this.updateSummaryMessage(clanData, job.request);
    }

    if (job.updateRemainAttack) {
      await this.updateRemainAttackMessage(clanData, job.request);
    }
  }

  private async ensureCurrentRemainAttackMessage(
    clanData: ClanData | undefined,
    dayGuardResult: ClanBattleDayGuardResult | null,
    request: AttackRenderContext,
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
    request: AttackRenderContext,
  ): Promise<void> {
    await this.messageCoordinator.ensureCurrentSummaryMessage(
      clanData,
      dayGuardResult,
      request,
    );
  }
}
