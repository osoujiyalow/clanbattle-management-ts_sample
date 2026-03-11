import type { EmbedBuilder } from "discord.js";

import { EMOJIS } from "../constants/emojis.js";
import { USER_MESSAGES } from "../constants/messages.js";
import { AttackStatus } from "../domain/attack-status.js";
import { AttackType, parseAttackType } from "../domain/attack-type.js";
import { type BossStatusData } from "../domain/boss-status-data.js";
import { type ClanData } from "../domain/clan-data.js";
import { OPERATION_TYPE_DESCRIPTION, OperationType } from "../domain/operation-type.js";
import { CarryOver, type LogData, type PlayerData } from "../domain/player-data.js";
import type { ReserveData } from "../domain/reserve-data.js";
import { parseDamageMessage } from "../domain/util/damage-parser.js";
import { renderProgressEmbed } from "../renderers/progress-renderer.js";
import { AttackStatusRepository } from "../repositories/sqlite/attack-status-repository.js";
import { BossStatusRepository } from "../repositories/sqlite/boss-status-repository.js";
import {
  ProgressMessageIdRepository,
  SummaryMessageIdRepository,
} from "../repositories/sqlite/boss-message-id-repository.js";
import { CarryOverRepository } from "../repositories/sqlite/carry-over-repository.js";
import { ClanRepository } from "../repositories/sqlite/clan-repository.js";
import { runInTransaction, type SqliteDatabase } from "../repositories/sqlite/db.js";
import { PlayerRepository } from "../repositories/sqlite/player-repository.js";
import { ReserveRepository } from "../repositories/sqlite/reserve-repository.js";
import type { ClanBattleDayGuardResult } from "../shared/date-guard.js";
import type { Logger } from "../shared/logger.js";
import { now, type Clock, systemClock } from "../shared/time.js";
import { buildRemainAttackEmbed, sendRemainAttackMessage } from "./remain-attack-message.js";
import type { RuntimeStateService } from "./runtime-state-service.js";

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const CARRYOVER_DECLARE_BLOCKED_MESSAGE =
  "持ち越しを所持していません。凸宣言をキャンセルします。";
const ATTACK_NOT_DECLARED_MESSAGE = "凸宣言がされていません。処理を中断します。";
const ALREADY_DEFEATED_MESSAGE = "既に討伐済みのボスです";
const UNDO_NOTHING_MESSAGE = "元に戻す内容がありませんでした";
const UNDO_DEFEAT_BLOCKED_BY_NEXT_LAP_MESSAGE = "次周に既に操作があるため自動巻き戻しできません";
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

function mentionUser(userId: string): string {
  return `<@${userId}>`;
}

function formatNotManagedMessage(displayName: string): string {
  return `${displayName}は凸管理対象ではありません。`;
}

function formatDeclareMessage(
  displayName: string,
  attackTypeText: string,
  lap: number,
  bossNumber: number,
): string {
  return `${displayName}の凸を${attackTypeText}で${lap}周目${bossNumber}ボスに宣言します`;
}

function formatAttackFinishMessage(displayName: string, lap: number, bossNumber: number): string {
  return `${displayName}の凸を${lap}周目${bossNumber}ボスに消化します`;
}

function formatDefeatBossMessage(displayName: string, bossNumber: number): string {
  return `${displayName}の凸で${bossNumber}ボスを討伐します`;
}

function formatUndoMemberNotManagedMessage(displayName: string): string {
  return `${displayName}さんは凸管理のメンバーに指定されていません。`;
}

function formatUndoMessage(
  displayName: string,
  bossNumber: number,
  operationType: OperationType,
): string {
  return `${displayName}の${bossNumber}ボスに対する\`${OPERATION_TYPE_DESCRIPTION[operationType]}\`を元に戻します。`;
}

function formatCarryOverMissingMessage(userId: string): string {
  return `${mentionUser(userId)} 持ち越しを所持していません。キャンセルします。`;
}

function formatCarryOverSelectionPrompt(userId: string): string {
  return `${mentionUser(userId)} 持ち越しが二つ以上発生しています。以下から使用した持ち越しを選択してください`;
}

export interface AttackDeclareMember {
  id: string;
  displayName: string;
}

export interface AttackDeclareResponseChannel {
  send(payload: { content?: string }): Promise<void>;
}

export interface AttackEditableMessage {
  readonly id: string;
  edit(payload: { embeds?: readonly EmbedBuilder[] }): Promise<void>;
  delete?(): Promise<void>;
}

export interface AttackCreatedMessage extends AttackEditableMessage {
  addReaction(emoji: string): Promise<void>;
}

export interface AttackSendPayload {
  content?: string;
  embeds?: readonly EmbedBuilder[];
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

export interface UndoAttackRequest extends AttackRenderContext {
  categoryId: string;
  responseChannel: AttackDeclareResponseChannel;
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
  attackStatusRepository?: AttackStatusRepository;
  bossStatusRepository?: BossStatusRepository;
  playerRepository?: PlayerRepository;
  reserveRepository?: ReserveRepository;
  carryOverRepository?: CarryOverRepository;
  progressMessageIdRepository?: ProgressMessageIdRepository;
  summaryMessageIdRepository?: SummaryMessageIdRepository;
  clock?: Clock;
  logger?: Logger;
  redrawRetryDelayMs?: number;
}

function cloneDisplayNamesMap(
  displayNamesByUserId: ReadonlyMap<string, string> | undefined,
): Map<string, string> {
  return new Map(displayNamesByUserId ?? []);
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

interface ValidatedAttackRequest {
  clanData: ClanData;
  playerData: PlayerData;
  lap: number;
  bossIndex: number;
}

interface ValidatedResolutionRequest extends ValidatedAttackRequest {
  bossStatusData: BossStatusData;
  attackStatus: AttackStatus;
}

interface ReserveCleanupResult {
  readonly touchedBossIndexes: ReadonlySet<number>;
  readonly removedByBossIndex: ReadonlyMap<number, readonly ReserveData[]>;
}

interface MessageUpdateResult {
  updated: boolean;
  missing: boolean;
}

function hasAnyAttackPlayers(bossStatusData: BossStatusData | undefined): boolean {
  return (bossStatusData?.attackPlayers.length ?? 0) > 0;
}

function hasAnyMessageIds(messageIds: readonly (string | null)[] | undefined): boolean {
  return messageIds?.some((messageId) => messageId !== null) ?? false;
}

export class AttackService {
  private readonly clanRepository: ClanRepository;
  private readonly attackStatusRepository: AttackStatusRepository;
  private readonly bossStatusRepository: BossStatusRepository;
  private readonly playerRepository: PlayerRepository;
  private readonly reserveRepository: ReserveRepository;
  private readonly carryOverRepository: CarryOverRepository;
  private readonly progressMessageIdRepository: ProgressMessageIdRepository;
  private readonly summaryMessageIdRepository: SummaryMessageIdRepository;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly redrawRetryDelayMs: number;

  constructor(private readonly options: AttackServiceOptions) {
    this.clanRepository = options.clanRepository ?? new ClanRepository(options.database);
    this.attackStatusRepository =
      options.attackStatusRepository ?? new AttackStatusRepository(options.database);
    this.bossStatusRepository =
      options.bossStatusRepository ?? new BossStatusRepository(options.database);
    this.playerRepository = options.playerRepository ?? new PlayerRepository(options.database);
    this.reserveRepository = options.reserveRepository ?? new ReserveRepository(options.database);
    this.carryOverRepository =
      options.carryOverRepository ?? new CarryOverRepository(options.database);
    this.progressMessageIdRepository =
      options.progressMessageIdRepository ?? new ProgressMessageIdRepository(options.database);
    this.summaryMessageIdRepository =
      options.summaryMessageIdRepository ?? new SummaryMessageIdRepository(options.database);
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.redrawRetryDelayMs = options.redrawRetryDelayMs ?? DEFAULT_REDRAW_RETRY_DELAY_MS;
  }

  async declare(request: AttackDeclareRequest): Promise<AttackStatus | null> {
    return this.options.runtimeStateService.withCategoryLock(request.categoryId, async () => {
      const dayGuardResult = this.options.runtimeStateService.get(request.categoryId)
        ? this.options.runtimeStateService.ensureDateUpToDateLocked(request.categoryId, this.clock)
        : null;
      const currentClanData = this.options.runtimeStateService.get(request.categoryId);
      await this.ensureCurrentRemainAttackMessage(currentClanData, dayGuardResult, request);

      const validation = await this.validateAttackRequest(request);
      if (!validation) {
        return null;
      }

      const { clanData, playerData, lap, bossIndex } = validation;

      const parsedAttackType = parseAttackType(request.attackType);
      if (!parsedAttackType) {
        await request.responseChannel.send({
          content: USER_MESSAGES.errors.invalidAttackType,
        });
        return null;
      }

      if (parsedAttackType === AttackType.CARRYOVER && playerData.carryOverList.length === 0) {
        await request.responseChannel.send({
          content: CARRYOVER_DECLARE_BLOCKED_MESSAGE,
        });
        return null;
      }

      await request.responseChannel.send({
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
      });

      await this.updateProgressMessages(clanData, lap, bossIndex, request);

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
          resolution.clanData,
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

      const reserveCleanup = this.cleanupReserveByAttack(
        resolution.clanData,
        resolution.attackStatus,
        resolution.bossIndex,
      );

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

        for (const [bossIndex, reserveList] of reserveCleanup.removedByBossIndex.entries()) {
          for (const reserveData of reserveList) {
            this.reserveRepository.delete(resolution.clanData.categoryId, bossIndex, reserveData);
          }
        }
      });

      await this.updateProgressMessages(resolution.clanData, resolution.lap, resolution.bossIndex, request);
      await this.updateRemainAttackMessage(resolution.clanData, request);
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
          resolution.clanData,
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

      const reserveCleanup = this.cleanupReserveByAttack(
        resolution.clanData,
        resolution.attackStatus,
        resolution.bossIndex,
      );

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

        for (const [bossIndex, reserveList] of reserveCleanup.removedByBossIndex.entries()) {
          for (const reserveData of reserveList) {
            this.reserveRepository.delete(resolution.clanData.categoryId, bossIndex, reserveData);
          }
        }
      });

      await this.updateProgressMessages(resolution.clanData, resolution.lap, resolution.bossIndex, request);
      await this.ensureProgressMessage(resolution.clanData, nextLap, resolution.bossIndex, request);
      await this.updateRemainAttackMessage(resolution.clanData, request);
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

      const logData = playerData.log.at(-1);
      if (!logData) {
        await request.responseChannel.send({
          content: UNDO_NOTHING_MESSAGE,
        });
        return false;
      }

      const bossStatusData = clanData.bossStatusByLap.get(logData.lap)?.[logData.bossIndex];
      if (!bossStatusData) {
        return true;
      }

      if (
        logData.operationType === OperationType.LAST_ATTACK &&
        this.isDefeatUndoBlockedByNextLap(clanData, logData)
      ) {
        await request.responseChannel.send({
          content: UNDO_DEFEAT_BLOCKED_BY_NEXT_LAP_MESSAGE,
        });
        return false;
      }

      await request.responseChannel.send({
        content: formatUndoMessage(
          request.member.displayName,
          logData.bossIndex + 1,
          logData.operationType,
        ),
      });

      if (logData.operationType === OperationType.ATTACK_DECLAR) {
        return this.undoAttackDeclare(clanData, playerData, logData, bossStatusData, request);
      }

      if (
        logData.operationType === OperationType.ATTACK ||
        logData.operationType === OperationType.LAST_ATTACK
      ) {
        return this.undoResolvedAttack(clanData, playerData, logData, bossStatusData, request);
      }

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

      const parsedDamage = parseDamageMessage(request.messageContent);
      if (!parsedDamage) {
        return false;
      }

      const lapList = [...clanData.progressMessageIdsByLap.keys()].sort((left, right) => right - left);
      for (const lap of lapList) {
        const bossStatusData = clanData.bossStatusByLap.get(lap)?.[bossIndex];
        if (!bossStatusData) {
          continue;
        }

        const attackStatusIndex = bossStatusData.getAttackStatusIndex(playerData, false);
        if (attackStatusIndex === undefined) {
          continue;
        }

        const attackStatus = bossStatusData.attackPlayers[attackStatusIndex];
        if (!attackStatus) {
          continue;
        }

        attackStatus.damage = parsedDamage.damage;
        attackStatus.memo = parsedDamage.memo;

        runInTransaction(this.options.database, () => {
          this.attackStatusRepository.update(clanData.categoryId, lap, bossIndex, attackStatus);
        });

        await this.updateProgressMessages(clanData, lap, bossIndex, request);
        return true;
      }

      return false;
    });
  }

  private async validateAttackRequest(
    request: AttackServiceBaseRequest,
  ): Promise<ValidatedAttackRequest | null> {
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

    const playerData = clanData.getPlayerData(request.member.id);
    if (!playerData) {
      await request.responseChannel.send({
        content: formatNotManagedMessage(request.member.displayName),
      });
      return null;
    }

    return {
      clanData,
      playerData,
      lap,
      bossIndex,
    };
  }

  private async resolveDeclaredAttack(
    validation: ValidatedAttackRequest,
    request: AttackServiceBaseRequest,
  ): Promise<ValidatedResolutionRequest | null> {
    const bossStatusData = validation.clanData.bossStatusByLap.get(validation.lap)?.[validation.bossIndex];
    if (!bossStatusData) {
      await request.responseChannel.send({
        content: USER_MESSAGES.errors.invalidLap,
      });
      return null;
    }

    const attackStatusIndex = bossStatusData.getAttackStatusIndex(validation.playerData, false);
    if (attackStatusIndex === undefined) {
      await request.responseChannel.send({
        content: ATTACK_NOT_DECLARED_MESSAGE,
      });
      return null;
    }

    const attackStatus = bossStatusData.attackPlayers[attackStatusIndex];
    if (!attackStatus) {
      await request.responseChannel.send({
        content: ATTACK_NOT_DECLARED_MESSAGE,
      });
      return null;
    }

    return {
      ...validation,
      bossStatusData,
      attackStatus,
    };
  }

  private async resolveBossIndex(
    clanData: ClanData,
    request: AttackServiceBaseRequest,
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

  private async undoAttackDeclare(
    clanData: ClanData,
    playerData: PlayerData,
    logData: LogData,
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

    bossStatusData.attackPlayers.splice(attackStatusIndex, 1);
    playerData.log.pop();

    runInTransaction(this.options.database, () => {
      this.attackStatusRepository.delete(clanData.categoryId, logData.lap, logData.bossIndex, attackStatus);
    });

    await this.updateProgressMessages(clanData, logData.lap, logData.bossIndex, request);
    return true;
  }

  private async undoResolvedAttack(
    clanData: ClanData,
    playerData: PlayerData,
    logData: LogData,
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

    if (logData.playerData) {
      playerData.applySnapshot(logData.playerData);
    }

    attackStatus.attacked = false;

    if (logData.operationType === OperationType.LAST_ATTACK && logData.beated !== undefined) {
      bossStatusData.beated = logData.beated;
    }

    playerData.log.pop();

    runInTransaction(this.options.database, () => {
      this.attackStatusRepository.reverse(clanData.categoryId, logData.lap, logData.bossIndex, attackStatus);

      if (logData.operationType === OperationType.LAST_ATTACK) {
        this.bossStatusRepository.update(clanData.categoryId, bossStatusData);
      }

      this.playerRepository.update(clanData.categoryId, playerData);
      this.carryOverRepository.replaceAll(clanData.categoryId, playerData.userId, playerData.carryOverList);
    });

    if (logData.operationType === OperationType.LAST_ATTACK) {
      await this.cleanupGeneratedNextLapState(clanData, logData, request);
    }

    await this.updateProgressMessages(clanData, logData.lap, logData.bossIndex, request);
    await this.updateRemainAttackMessage(clanData, request);
    return true;
  }

  private isDefeatUndoBlockedByNextLap(clanData: ClanData, logData: LogData): boolean {
    const nextLap = logData.lap + 1;
    return hasAnyAttackPlayers(clanData.bossStatusByLap.get(nextLap)?.[logData.bossIndex]);
  }

  private async cleanupGeneratedNextLapState(
    clanData: ClanData,
    logData: LogData,
    request: UndoAttackRequest,
  ): Promise<void> {
    const nextLap = logData.lap + 1;
    const bossIndex = logData.bossIndex;

    await this.clearProgressMessageSlot(clanData, nextLap, bossIndex, request);

    if (!hasAnyMessageIds(clanData.progressMessageIdsByLap.get(nextLap))) {
      await this.clearSummaryLap(clanData, nextLap, request);
      return;
    }

    await this.clearSummaryMessageSlot(clanData, nextLap, bossIndex, request);
  }

  private async clearProgressMessageSlot(
    clanData: ClanData,
    lap: number,
    bossIndex: number,
    request: UndoAttackRequest,
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
        this.logger.warn("Failed to resolve boss channel for progress cleanup", {
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
      this.progressMessageIdRepository.update(clanData.categoryId, lap, messageIds);
      return;
    }

    clanData.progressMessageIdsByLap.delete(lap);
    this.progressMessageIdRepository.deleteByLap(clanData.categoryId, lap);
  }

  private async clearSummaryMessageSlot(
    clanData: ClanData,
    lap: number,
    bossIndex: number,
    request: UndoAttackRequest,
  ): Promise<void> {
    const summaryMessageIds = clanData.summaryMessageIdsByLap.get(lap);
    const summaryMessageId = summaryMessageIds?.[bossIndex];

    if (summaryMessageId) {
      try {
        const summaryChannel = await request.discordGateway.getTextChannel(clanData.summaryChannelId);
        await this.deleteMessageWithRetry(
          summaryChannel,
          summaryMessageId,
          "summary",
          clanData.categoryId,
          lap,
          bossIndex,
        );
      } catch (error) {
        this.logger.warn("Failed to resolve summary channel for cleanup", {
          categoryId: clanData.categoryId,
          lap,
          bossIndex,
          error,
        });
      }
    }

    if (!summaryMessageIds) {
      return;
    }

    summaryMessageIds[bossIndex] = null;
    if (hasAnyMessageIds(summaryMessageIds)) {
      this.summaryMessageIdRepository.update(clanData.categoryId, lap, summaryMessageIds);
      return;
    }

    clanData.summaryMessageIdsByLap.delete(lap);
    this.summaryMessageIdRepository.deleteByLap(clanData.categoryId, lap);
  }

  private async clearSummaryLap(
    clanData: ClanData,
    lap: number,
    request: UndoAttackRequest,
  ): Promise<void> {
    const summaryMessageIds = clanData.summaryMessageIdsByLap.get(lap);
    if (summaryMessageIds) {
      for (let bossIndex = 0; bossIndex < summaryMessageIds.length; bossIndex += 1) {
        const summaryMessageId = summaryMessageIds[bossIndex];
        if (!summaryMessageId) {
          continue;
        }

        try {
          const summaryChannel = await request.discordGateway.getTextChannel(clanData.summaryChannelId);
          await this.deleteMessageWithRetry(
            summaryChannel,
            summaryMessageId,
            "summary",
            clanData.categoryId,
            lap,
            bossIndex,
          );
        } catch (error) {
          this.logger.warn("Failed to resolve summary channel for lap cleanup", {
            categoryId: clanData.categoryId,
            lap,
            bossIndex,
            error,
          });
          break;
        }
      }
    }

    clanData.summaryMessageIdsByLap.delete(lap);
    this.summaryMessageIdRepository.deleteByLap(clanData.categoryId, lap);
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
    clanData: ClanData,
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

    let carryOverIndex = 0;
    if (carryOverList.length > 1) {
      if (request.selectCarryOver) {
        await request.responseChannel.send({
          content: formatCarryOverSelectionPrompt(request.member.id),
        });

        const selected = await request.selectCarryOver({
          member: request.member,
          carryOverList,
          responseChannel: request.responseChannel,
        });

        if (selected === null) {
          attackStatus.playerData.log.pop();
          return false;
        }

        carryOverIndex = selected;
      } else {
        this.logger.warn("Multiple carryovers exist but no selector was provided; defaulting to first", {
          categoryId: clanData.categoryId,
          userId: attackStatus.playerData.userId,
          carryOverCount: carryOverList.length,
        });
      }
    }

    if (carryOverIndex < 0 || carryOverIndex >= carryOverList.length) {
      attackStatus.playerData.log.pop();
      await request.responseChannel.send({
        content: USER_MESSAGES.errors.commandExecutionFailed,
      });
      return false;
    }

    carryOverList.splice(carryOverIndex, 1);
    return true;
  }

  private cleanupReserveByAttack(
    clanData: ClanData,
    attackStatus: AttackStatus,
    bossIndex: number,
  ): ReserveCleanupResult {
    const removedByBossIndex = new Map<number, ReserveData[]>();
    const touchedBossIndexes = new Set<number>();

    const currentReserveList = [...(clanData.reserveList[bossIndex] ?? [])];
    let matchingReserveIndex = -1;
    for (let index = 0; index < currentReserveList.length; index += 1) {
      const reserveData = currentReserveList[index]!;
      if (
        reserveData.carryOver === attackStatus.carryOver &&
        reserveData.attackType === attackStatus.attackType &&
        reserveData.playerData.userId === attackStatus.playerData.userId
      ) {
        matchingReserveIndex = index;
      }
    }

    if (matchingReserveIndex !== -1) {
      const removedReserve = currentReserveList.splice(matchingReserveIndex, 1);
      clanData.reserveList[bossIndex] = currentReserveList;
      removedByBossIndex.set(bossIndex, removedReserve);
      touchedBossIndexes.add(bossIndex);
    }

    const playerData = attackStatus.playerData;
    const attackCompleted = playerData.magicAttack + playerData.physicsAttack === 3;
    const carryOverCompleted = playerData.carryOverList.length === 0;

    if (!attackCompleted && !carryOverCompleted) {
      return {
        touchedBossIndexes,
        removedByBossIndex,
      };
    }

    for (let targetBossIndex = 0; targetBossIndex < clanData.reserveList.length; targetBossIndex += 1) {
      const reserveList = [...(clanData.reserveList[targetBossIndex] ?? [])];
      const keptReserveList: ReserveData[] = [];
      const additionallyRemoved: ReserveData[] = [];

      for (const reserveData of reserveList) {
        const sameUser = reserveData.playerData.userId === playerData.userId;
        const shouldRemove =
          (attackCompleted && sameUser && !reserveData.carryOver) ||
          (carryOverCompleted && sameUser && reserveData.carryOver);

        if (shouldRemove) {
          additionallyRemoved.push(reserveData);
        } else {
          keptReserveList.push(reserveData);
        }
      }

      if (additionallyRemoved.length === 0) {
        continue;
      }

      clanData.reserveList[targetBossIndex] = keptReserveList;
      removedByBossIndex.set(targetBossIndex, [
        ...(removedByBossIndex.get(targetBossIndex) ?? []),
        ...additionallyRemoved,
      ]);
      touchedBossIndexes.add(targetBossIndex);
    }

    return {
      touchedBossIndexes,
      removedByBossIndex,
    };
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
    const displayNamesByUserId = cloneDisplayNamesMap(request.displayNamesByUserId);
    displayNamesByUserId.set(request.member.id, request.member.displayName);

    const embed = renderProgressEmbed({
      clanData,
      lap,
      bossIndex,
      displayNamesByUserId,
    });

    await this.updateProgressMessage(clanData, lap, bossIndex, embed, request);
    await this.updateSummaryMessage(clanData, lap, bossIndex, embed, request);
  }

  private async updateProgressMessage(
    clanData: ClanData,
    lap: number,
    bossIndex: number,
    embed: EmbedBuilder,
    request: AttackRenderContext,
  ): Promise<void> {
    const progressMessageId = clanData.progressMessageIdsByLap.get(lap)?.[bossIndex];
    if (!progressMessageId) {
      await this.ensureProgressMessage(clanData, lap, bossIndex, request);
      return;
    }

    let bossChannel: AttackTextChannel;
    try {
      bossChannel = await request.discordGateway.getTextChannel(clanData.bossChannelIds[bossIndex]!);
    } catch (error) {
      this.logger.warn("Failed to resolve boss channel for progress redraw", {
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
      "progress",
      clanData.categoryId,
      lap,
      bossIndex,
    );

    if (!result.updated && result.missing) {
      await this.ensureProgressMessage(clanData, lap, bossIndex, request);
    }
  }

  private async updateSummaryMessage(
    clanData: ClanData,
    lap: number,
    bossIndex: number,
    embed: EmbedBuilder,
    request: AttackRenderContext,
  ): Promise<void> {
    const summaryMessageIds = clanData.summaryMessageIdsByLap.get(lap);
    if (!summaryMessageIds) {
      await this.ensureSummaryMessages(
        clanData,
        lap,
        cloneDisplayNamesMap(request.displayNamesByUserId),
        request,
      );
      return;
    }

    const summaryMessageId = summaryMessageIds[bossIndex];
    if (!summaryMessageId) {
      await this.createSummaryMessage(clanData, lap, bossIndex, embed, request, true);
      return;
    }

    let summaryChannel: AttackTextChannel;
    try {
      summaryChannel = await request.discordGateway.getTextChannel(clanData.summaryChannelId);
    } catch (error) {
      this.logger.warn("Failed to resolve summary channel for redraw", {
        categoryId: clanData.categoryId,
        lap,
        bossIndex,
        error,
      });
      return;
    }

    const result = await this.editMessageWithRetry(
      summaryChannel,
      summaryMessageId,
      embed,
      "summary",
      clanData.categoryId,
      lap,
      bossIndex,
    );

    if (!result.updated && result.missing) {
      await this.createSummaryMessage(clanData, lap, bossIndex, embed, request, true);
    }
  }

  private async ensureProgressMessage(
    clanData: ClanData,
    lap: number,
    bossIndex: number,
    request: AttackRenderContext,
  ): Promise<void> {
    const displayNamesByUserId = cloneDisplayNamesMap(request.displayNamesByUserId);
    displayNamesByUserId.set(request.member.id, request.member.displayName);

    let bossChannel: AttackTextChannel;
    try {
      bossChannel = await request.discordGateway.getTextChannel(clanData.bossChannelIds[bossIndex]!);
    } catch (error) {
      this.logger.warn("Failed to resolve boss channel for progress creation", {
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
      });

      for (const emoji of PROGRESS_REACTIONS) {
        await progressMessage.addReaction(emoji);
      }

      const hadProgressRow = clanData.progressMessageIdsByLap.has(lap);
      const progressMessageIds = clanData.progressMessageIdsByLap.get(lap) ?? createBossSlots();
      progressMessageIds[bossIndex] = progressMessage.id;
      clanData.progressMessageIdsByLap.set(lap, progressMessageIds);

      runInTransaction(this.options.database, () => {
        if (hadProgressRow) {
          this.progressMessageIdRepository.update(clanData.categoryId, lap, progressMessageIds);
        } else {
          this.progressMessageIdRepository.insert(clanData.categoryId, lap, progressMessageIds);
        }
      });

      await this.ensureSummaryMessages(clanData, lap, displayNamesByUserId, request);
    } catch (error) {
      this.logger.warn("Failed to create progress message", {
        categoryId: clanData.categoryId,
        lap,
        bossIndex,
        error,
      });
    }
  }

  private async ensureSummaryMessages(
    clanData: ClanData,
    lap: number,
    displayNamesByUserId: ReadonlyMap<string, string>,
    request: AttackRenderContext,
  ): Promise<void> {
    if (clanData.summaryMessageIdsByLap.has(lap)) {
      return;
    }

    let summaryChannel: AttackTextChannel;
    try {
      summaryChannel = await request.discordGateway.getTextChannel(clanData.summaryChannelId);
    } catch (error) {
      this.logger.warn("Failed to resolve summary channel for creation", {
        categoryId: clanData.categoryId,
        lap,
        error,
      });
      return;
    }

    const summaryMessageIds = createBossSlots();
    for (let currentBossIndex = 0; currentBossIndex < clanData.bossChannelIds.length; currentBossIndex += 1) {
      const summaryEmbed = renderProgressEmbed({
        clanData,
        lap,
        bossIndex: currentBossIndex,
        displayNamesByUserId,
      });

      try {
        const summaryMessage = await summaryChannel.sendMessage({
          embeds: [summaryEmbed],
        });
        summaryMessageIds[currentBossIndex] = summaryMessage.id;
      } catch (error) {
        this.logger.warn("Failed to create summary mirror message", {
          categoryId: clanData.categoryId,
          lap,
          bossIndex: currentBossIndex,
          error,
        });
      }
    }

    clanData.summaryMessageIdsByLap.set(lap, summaryMessageIds);
    runInTransaction(this.options.database, () => {
      this.summaryMessageIdRepository.insert(clanData.categoryId, lap, summaryMessageIds);
    });
  }

  private async createSummaryMessage(
    clanData: ClanData,
    lap: number,
    bossIndex: number,
    embed: EmbedBuilder,
    request: AttackRenderContext,
    updateExistingRow: boolean,
  ): Promise<void> {
    let summaryChannel: AttackTextChannel;
    try {
      summaryChannel = await request.discordGateway.getTextChannel(clanData.summaryChannelId);
    } catch (error) {
      this.logger.warn("Failed to resolve summary channel for single-message creation", {
        categoryId: clanData.categoryId,
        lap,
        bossIndex,
        error,
      });
      return;
    }

    try {
      const summaryMessage = await summaryChannel.sendMessage({
        embeds: [embed],
      });

      const hadSummaryRow = clanData.summaryMessageIdsByLap.has(lap);
      const summaryMessageIds = clanData.summaryMessageIdsByLap.get(lap) ?? createBossSlots();
      summaryMessageIds[bossIndex] = summaryMessage.id;
      clanData.summaryMessageIdsByLap.set(lap, summaryMessageIds);

      runInTransaction(this.options.database, () => {
        if (updateExistingRow || hadSummaryRow) {
          this.summaryMessageIdRepository.update(clanData.categoryId, lap, summaryMessageIds);
        } else {
          this.summaryMessageIdRepository.insert(clanData.categoryId, lap, summaryMessageIds);
        }
      });
    } catch (error) {
      this.logger.warn("Failed to create summary message", {
        categoryId: clanData.categoryId,
        lap,
        bossIndex,
        error,
      });
    }
  }

  private async updateRemainAttackMessage(
    clanData: ClanData,
    request: AttackRenderContext,
  ): Promise<void> {
    if (!clanData.remainAttackMessageId) {
      await this.createCurrentRemainAttackMessage(clanData, request);
      return;
    }

    const displayNamesByUserId = cloneDisplayNamesMap(request.displayNamesByUserId);
    displayNamesByUserId.set(request.member.id, request.member.displayName);

    const embed = buildRemainAttackEmbed(clanData, displayNamesByUserId, this.clock);

    let remainAttackChannel: AttackTextChannel;
    try {
      remainAttackChannel = await request.discordGateway.getTextChannel(
        clanData.remainAttackChannelId,
      );
    } catch (error) {
      this.logger.warn("Failed to resolve remain-attack channel for redraw", {
        categoryId: clanData.categoryId,
        error,
      });
      return;
    }

    const result = await this.editMessageWithRetry(
      remainAttackChannel,
      clanData.remainAttackMessageId,
      embed,
      "remain-attack",
      clanData.categoryId,
    );

    if (!result.updated && result.missing) {
      clanData.remainAttackMessageId = null;
      runInTransaction(this.options.database, () => {
        this.clanRepository.update(clanData);
      });
      await this.createCurrentRemainAttackMessage(clanData, request);
    }
  }

  private async ensureCurrentRemainAttackMessage(
    clanData: ClanData | undefined,
    dayGuardResult: ClanBattleDayGuardResult | null,
    request: AttackRenderContext,
  ): Promise<void> {
    if (
      !clanData ||
      (!dayGuardResult?.shouldCreateRemainAttackMessage && clanData.remainAttackMessageId)
    ) {
      return;
    }

    await this.createCurrentRemainAttackMessage(clanData, request);
  }

  private async createCurrentRemainAttackMessage(
    clanData: ClanData,
    request: AttackRenderContext,
  ): Promise<void> {
    const displayNamesByUserId = cloneDisplayNamesMap(request.displayNamesByUserId);
    displayNamesByUserId.set(request.member.id, request.member.displayName);

    let remainAttackChannel: AttackTextChannel;
    try {
      remainAttackChannel = await request.discordGateway.getTextChannel(clanData.remainAttackChannelId);
    } catch (error) {
      this.logger.warn("Failed to resolve remain-attack channel for current message creation", {
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
    } catch (error) {
      this.logger.warn("Failed to create remain-attack message", {
        categoryId: clanData.categoryId,
        error,
      });
      return;
    }

    runInTransaction(this.options.database, () => {
      this.clanRepository.update(clanData);
    });
  }

  private async editMessageWithRetry(
    channel: AttackTextChannel,
    messageId: string,
    embed: EmbedBuilder,
    kind: "progress" | "summary" | "remain-attack",
    categoryId: string,
    lap?: number,
    bossIndex?: number,
  ): Promise<MessageUpdateResult> {
    let lastError: unknown;
    let missing = false;

    for (let attempt = 0; attempt < DEFAULT_REDRAW_RETRY_COUNT; attempt += 1) {
      try {
        const message = await channel.fetchMessage(messageId);
        await message.edit({
          embeds: [embed],
        });
        return {
          updated: true,
          missing: false,
        };
      } catch (error) {
        lastError = error;
        missing = isMessageMissingError(error);

        if (attempt < DEFAULT_REDRAW_RETRY_COUNT - 1) {
          await sleep(this.redrawRetryDelayMs);
        }
      }
    }

    this.logger.warn("Failed to redraw Discord message", {
      categoryId,
      kind,
      lap,
      bossIndex,
      messageId,
      missing,
      error: lastError,
    });

    return {
      updated: false,
      missing,
    };
  }

  private async deleteMessageWithRetry(
    channel: AttackTextChannel,
    messageId: string,
    kind: "progress" | "summary",
    categoryId: string,
    lap: number,
    bossIndex: number,
  ): Promise<void> {
    let lastError: unknown;
    let missing = false;

    for (let attempt = 0; attempt < DEFAULT_REDRAW_RETRY_COUNT; attempt += 1) {
      try {
        const message = await channel.fetchMessage(messageId);
        if (typeof message.delete !== "function") {
          this.logger.warn("Fetched Discord message does not support deletion", {
            categoryId,
            kind,
            lap,
            bossIndex,
            messageId,
          });
          return;
        }

        await message.delete();
        return;
      } catch (error) {
        lastError = error;
        missing = isMessageMissingError(error);

        if (attempt < DEFAULT_REDRAW_RETRY_COUNT - 1) {
          await sleep(this.redrawRetryDelayMs);
        }
      }
    }

    this.logger.warn("Failed to delete Discord message", {
      categoryId,
      kind,
      lap,
      bossIndex,
      messageId,
      missing,
      error: lastError,
    });
  }
}
