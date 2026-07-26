import { randomUUID } from "node:crypto";

import type {
  ActionRowBuilder,
  EmbedBuilder,
  MessageActionRowComponentBuilder,
} from "discord.js";

import { USER_MESSAGES } from "../constants/messages.js";
import { type ClanData } from "../domain/clan-data.js";
import { PlayerData } from "../domain/player-data.js";
import {
  ResourceAdjustment,
  ResourceAdjustmentType,
} from "../domain/resource-adjustment.js";
import { AttackEntryRepository } from "../repositories/sqlite/attack-entry-repository.js";
import {
  ProgressMessageIdRepository,
  SummaryMessageIdRepository,
} from "../repositories/sqlite/boss-message-id-repository.js";
import { ClanRepository } from "../repositories/sqlite/clan-repository.js";
import { runInTransaction, type SqliteDatabase } from "../repositories/sqlite/db.js";
import { OperationLogRepository } from "../repositories/sqlite/operation-log-repository.js";
import { PlayerRepository } from "../repositories/sqlite/player-repository.js";
import { ResourceAdjustmentRepository } from "../repositories/sqlite/resource-adjustment-repository.js";
import type { Logger } from "../shared/logger.js";
import { type Clock, now, systemClock } from "../shared/time.js";
import { DEFAULT_DISCORD_MESSAGE_RETRY_DELAY_MS } from "./discord-message-retry.js";
import { MemberServiceMessageCoordinator } from "./member-service-message-coordinator.js";
import type { RuntimeStateService } from "./runtime-state-service.js";

const REMOVE_COMPLETED_MESSAGE = "削除が完了しました。";
const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function formatAddedMessage(count: number, skippedCount = 0): string {
  if (skippedCount === 0) {
    return `${count}名追加します。`;
  }

  if (count === 0) {
    return `追加対象はありませんでした。${skippedCount}名は既存または重複のためスキップしました。`;
  }

  return `${count}名追加します。${skippedCount}名は既存または重複のためスキップしました。`;
}

function formatRemovingMessage(count: number): string {
  return `${count}件のデータを削除します。`;
}

function formatNotManagedMessage(displayName: string): string {
  return `${displayName}さんは凸管理対象ではありません。`;
}

function cloneDisplayNamesMap(
  displayNamesByUserId: ReadonlyMap<string, string> | undefined,
): Map<string, string> {
  return new Map(displayNamesByUserId ?? []);
}

function mergeDisplayName(displayNamesByUserId: Map<string, string>, member: MemberIdentity | undefined): void {
  if (!member) {
    return;
  }

  displayNamesByUserId.set(member.id, member.displayName);
}

function collectUniqueCandidateMember(
  candidateMembers: Map<string, MemberIdentity>,
  member: MemberIdentity,
): boolean {
  if (candidateMembers.has(member.id)) {
    return false;
  }

  candidateMembers.set(member.id, member);
  return true;
}

function createMemberRenderContext(
  actor: MemberIdentity,
  discordGateway: MemberDiscordGateway,
  displayNamesByUserId?: ReadonlyMap<string, string>,
): MemberRenderContext {
  return displayNamesByUserId
    ? {
        actor,
        discordGateway,
        displayNamesByUserId,
      }
    : {
        actor,
        discordGateway,
      };
}

export interface MemberIdentity {
  id: string;
  displayName: string;
}

export interface MemberRole {
  members: readonly MemberIdentity[];
}

export interface MemberResponseChannel {
  send(payload: { content?: string }): Promise<void>;
}

export interface MemberEditableMessage {
  readonly id: string;
  edit(payload: {
    embeds?: readonly EmbedBuilder[];
    components?: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[];
  }): Promise<void>;
  delete?(): Promise<void>;
}

export interface MemberCreatedMessage {
  readonly id: string;
  addReaction(emoji: string): Promise<void>;
}

export interface MemberTextChannel {
  readonly id: string;
  fetchMessage(messageId: string): Promise<MemberEditableMessage>;
  sendMessage(payload: {
    content?: string;
    embeds?: readonly EmbedBuilder[];
    components?: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[];
  }): Promise<MemberCreatedMessage>;
}

export interface MemberDiscordGateway {
  getTextChannel(channelId: string): Promise<MemberTextChannel>;
}

interface MemberServiceBaseRequest {
  categoryId: string;
  actor: MemberIdentity;
  responseChannel: MemberResponseChannel;
  discordGateway: MemberDiscordGateway;
  displayNamesByUserId?: ReadonlyMap<string, string>;
}

interface MemberRenderContext {
  actor: MemberIdentity;
  discordGateway: MemberDiscordGateway;
  displayNamesByUserId?: ReadonlyMap<string, string>;
}

interface ProgressTarget {
  lap: number;
  bossIndex: number;
}

export interface AddMembersRequest extends MemberServiceBaseRequest {
  role?: MemberRole;
  member?: MemberIdentity;
}

export interface IncreaseBattleAttackLimitRequest extends MemberServiceBaseRequest {
  member: MemberIdentity;
}

export interface RemoveMembersRequest extends MemberServiceBaseRequest {
  member?: MemberIdentity;
  all?: boolean;
}

export interface SetTaskKillRequest {
  categoryId: string;
  member: MemberIdentity;
  taskKill: boolean;
  discordGateway: MemberDiscordGateway;
  displayNamesByUserId?: ReadonlyMap<string, string>;
}

export interface EnsureCurrentRemainAttackMessageRequest {
  categoryId: string;
  member: MemberIdentity;
  discordGateway: MemberDiscordGateway;
  displayNamesByUserId?: ReadonlyMap<string, string>;
}

export interface ResyncCurrentMessageSurfacesRequest {
  categoryId: string;
  member: MemberIdentity;
  discordGateway: MemberDiscordGateway;
  displayNamesByUserId?: ReadonlyMap<string, string>;
}

export interface MemberServiceOptions {
  database: SqliteDatabase;
  runtimeStateService: RuntimeStateService;
  attackEntryRepository?: AttackEntryRepository;
  operationLogRepository?: OperationLogRepository;
  playerRepository?: PlayerRepository;
  resourceAdjustmentRepository?: ResourceAdjustmentRepository;
  clanRepository?: ClanRepository;
  progressMessageIdRepository?: ProgressMessageIdRepository;
  summaryMessageIdRepository?: SummaryMessageIdRepository;
  clock?: Clock;
  logger?: Logger;
  redrawRetryDelayMs?: number;
}

export class MemberService {
  private readonly attackEntryRepository: AttackEntryRepository;
  private readonly operationLogRepository: OperationLogRepository;
  private readonly playerRepository: PlayerRepository;
  private readonly resourceAdjustmentRepository: ResourceAdjustmentRepository;
  private readonly clock: Clock;
  private readonly messageCoordinator: MemberServiceMessageCoordinator;

  constructor(private readonly options: MemberServiceOptions) {
    this.attackEntryRepository =
      options.attackEntryRepository ?? new AttackEntryRepository(options.database);
    const clanRepository = options.clanRepository ?? new ClanRepository(options.database);
    this.operationLogRepository =
      options.operationLogRepository ?? new OperationLogRepository(options.database);
    this.playerRepository = options.playerRepository ?? new PlayerRepository(options.database);
    this.resourceAdjustmentRepository =
      options.resourceAdjustmentRepository ?? new ResourceAdjustmentRepository(options.database);
    const progressMessageIdRepository =
      options.progressMessageIdRepository ?? new ProgressMessageIdRepository(options.database);
    const summaryMessageIdRepository =
      options.summaryMessageIdRepository ?? new SummaryMessageIdRepository(options.database);
    this.clock = options.clock ?? systemClock;
    const logger = options.logger ?? NOOP_LOGGER;
    const redrawRetryDelayMs =
      options.redrawRetryDelayMs ?? DEFAULT_DISCORD_MESSAGE_RETRY_DELAY_MS;
    this.messageCoordinator = new MemberServiceMessageCoordinator({
      database: options.database,
      clanRepository,
      progressMessageIdRepository,
      summaryMessageIdRepository,
      clock: this.clock,
      logger,
      redrawRetryDelayMs,
    });
  }

  async ensureCurrentRemainAttackMessage(
    request: EnsureCurrentRemainAttackMessageRequest,
  ): Promise<string | null> {
    return this.options.runtimeStateService.withCategoryLock(request.categoryId, async () => {
      const clanData = this.options.runtimeStateService.get(request.categoryId);
      if (!clanData) {
        return null;
      }

      if (clanData.remainAttackMessageId) {
        await this.ensureCurrentSummaryMessage(
          clanData,
          createMemberRenderContext(
            request.member,
            request.discordGateway,
            request.displayNamesByUserId,
          ),
        );
        return clanData.remainAttackMessageId;
      }

      const remainAttackMessageId = await this.createCurrentRemainAttackMessage(
        clanData,
        createMemberRenderContext(
          request.member,
          request.discordGateway,
          request.displayNamesByUserId,
        ),
      );
      await this.ensureCurrentSummaryMessage(
        clanData,
        createMemberRenderContext(
          request.member,
          request.discordGateway,
          request.displayNamesByUserId,
        ),
      );
      return remainAttackMessageId;
    });
  }

  async resyncCurrentMessageSurfaces(
    request: ResyncCurrentMessageSurfacesRequest,
  ): Promise<boolean> {
    return this.options.runtimeStateService.withCategoryLock(request.categoryId, async () => {
      const currentClanData = this.options.runtimeStateService.get(request.categoryId);
      if (currentClanData) {
        this.options.runtimeStateService.ensureDateUpToDateLocked(request.categoryId, this.clock);
      }

      const clanData = this.options.runtimeStateService.get(request.categoryId);
      if (!clanData) {
        return false;
      }

      const renderContext = createMemberRenderContext(
        request.member,
        request.discordGateway,
        request.displayNamesByUserId,
      );
      await this.updateRemainAttackMessage(clanData, renderContext);
      await this.updateSummaryMessage(clanData, renderContext);
      return true;
    });
  }

  async add(request: AddMembersRequest): Promise<number | null> {
    return this.options.runtimeStateService.withCategoryLock(request.categoryId, async () => {
      const clanData = this.options.runtimeStateService.get(request.categoryId);
      const dayGuardResult = clanData
        ? this.options.runtimeStateService.ensureDateUpToDateLocked(request.categoryId, this.clock)
        : null;
      const currentClanData = this.options.runtimeStateService.get(request.categoryId);
      if (
        currentClanData &&
        (dayGuardResult?.shouldCreateRemainAttackMessage || !currentClanData.remainAttackMessageId)
      ) {
        await this.createCurrentRemainAttackMessage(currentClanData, request);
      }
      await this.ensureCurrentSummaryMessage(currentClanData, request);

      const refreshedClanData = this.options.runtimeStateService.get(request.categoryId);
      if (!refreshedClanData) {
        await request.responseChannel.send({
          content: USER_MESSAGES.errors.categoryRequired,
        });
        return null;
      }

      const candidateMembers = new Map<string, MemberIdentity>();
      const displayNamesByUserId = cloneDisplayNamesMap(request.displayNamesByUserId);
      let skippedCount = 0;

      if (!request.role && !request.member) {
        collectUniqueCandidateMember(candidateMembers, request.actor);
      }

      if (request.member) {
        if (!collectUniqueCandidateMember(candidateMembers, request.member)) {
          skippedCount += 1;
        }
      }

      if (request.role) {
        for (const roleMember of request.role.members) {
          if (!collectUniqueCandidateMember(candidateMembers, roleMember)) {
            skippedCount += 1;
          }
        }
      }

      const playerDataList: PlayerData[] = [];
      for (const member of candidateMembers.values()) {
        mergeDisplayName(displayNamesByUserId, member);

        if (refreshedClanData.getPlayerData(member.id)) {
          skippedCount += 1;
          continue;
        }

        const playerData = new PlayerData({ userId: member.id });
        refreshedClanData.addPlayerData(playerData);
        playerDataList.push(playerData);
      }

      await request.responseChannel.send({
        content: formatAddedMessage(playerDataList.length, skippedCount),
      });

      if (playerDataList.length > 0) {
        runInTransaction(this.options.database, () => {
          this.playerRepository.insertMany(refreshedClanData.categoryId, playerDataList);
        });
        this.options.runtimeStateService.notifyCategoryStateChanged(refreshedClanData.categoryId);
      }

      await this.updateRemainAttackMessage(
        refreshedClanData,
        {
          ...request,
          displayNamesByUserId,
        },
      );
      await this.updateSummaryMessage(
        refreshedClanData,
        {
          ...request,
          displayNamesByUserId,
        },
      );

      return playerDataList.length;
    });
  }

  async increaseBattleAttackLimit(
    request: IncreaseBattleAttackLimitRequest,
  ): Promise<number | null> {
    return this.changeBattleAttackLimit(request, 3);
  }

  async decreaseBattleAttackLimit(
    request: IncreaseBattleAttackLimitRequest,
  ): Promise<number | null> {
    return this.changeBattleAttackLimit(request, -3);
  }

  private async changeBattleAttackLimit(
    request: IncreaseBattleAttackLimitRequest,
    delta: 3 | -3,
  ): Promise<number | null> {
    return this.options.runtimeStateService.withCategoryLock(request.categoryId, async () => {
      const clanData = this.options.runtimeStateService.get(request.categoryId);
      const dayGuardResult = clanData
        ? this.options.runtimeStateService.ensureDateUpToDateLocked(request.categoryId, this.clock)
        : null;
      const currentClanData = this.options.runtimeStateService.get(request.categoryId);
      if (
        currentClanData &&
        (dayGuardResult?.shouldCreateRemainAttackMessage || !currentClanData.remainAttackMessageId)
      ) {
        await this.createCurrentRemainAttackMessage(currentClanData, request);
      }
      await this.ensureCurrentSummaryMessage(currentClanData, request);

      const refreshedClanData = this.options.runtimeStateService.get(request.categoryId);
      const playerData = refreshedClanData?.getPlayerData(request.member.id);
      if (!refreshedClanData || !playerData) {
        return null;
      }

      const playerResourceState = this.options.runtimeStateService.getPlayerResourceState(
        refreshedClanData.categoryId,
        playerData.userId,
        refreshedClanData.date,
      );
      const occupiedBattleAttackCount =
        (playerResourceState?.battleReservedCount ?? 0) +
        (playerResourceState?.battleConsumedCount ?? playerData.battleAttackCount);
      const nextBattleAttackLimit = playerData.battleAttackLimit + delta;
      if (nextBattleAttackLimit < 3 || occupiedBattleAttackCount > nextBattleAttackLimit) {
        return null;
      }

      const latestBattleAdjustment = this.resourceAdjustmentRepository
        .findAllByCategory(refreshedClanData.categoryId)
        .filter(
          (adjustment) =>
            adjustment.userId === playerData.userId &&
            adjustment.dayKey === refreshedClanData.date &&
            adjustment.resourceType === ResourceAdjustmentType.BATTLE,
        )
        .at(-1);
      if (latestBattleAdjustment && latestBattleAdjustment.remaining + delta < 0) {
        return null;
      }
      const transitionAt = now(this.clock);
      playerData.battleAttackLimit = nextBattleAttackLimit;
      runInTransaction(this.options.database, () => {
        this.playerRepository.update(refreshedClanData.categoryId, playerData);
        if (latestBattleAdjustment) {
          this.resourceAdjustmentRepository.insert(
            new ResourceAdjustment({
              adjustmentId: randomUUID(),
              categoryId: refreshedClanData.categoryId,
              userId: playerData.userId,
              actorUserId: request.actor.id,
              dayKey: refreshedClanData.date,
              resourceType: ResourceAdjustmentType.BATTLE,
              remaining: latestBattleAdjustment.remaining + delta,
              occurredAt: transitionAt,
            }),
          );
        }
        this.options.runtimeStateService.syncProjectedStateForCategory(
          refreshedClanData.categoryId,
          refreshedClanData.date,
          transitionAt,
        );
      });

      const displayNamesByUserId = cloneDisplayNamesMap(request.displayNamesByUserId);
      mergeDisplayName(displayNamesByUserId, request.member);
      const renderContext = {
        ...request,
        displayNamesByUserId,
      };
      await this.updateRemainAttackMessage(refreshedClanData, renderContext);
      await this.updateSummaryMessage(refreshedClanData, renderContext);

      return playerData.battleAttackLimit;
    });
  }

  async remove(request: RemoveMembersRequest): Promise<number | null> {
    return this.options.runtimeStateService.withCategoryLock(request.categoryId, async () => {
      const clanData = this.options.runtimeStateService.get(request.categoryId);
      const dayGuardResult = clanData
        ? this.options.runtimeStateService.ensureDateUpToDateLocked(request.categoryId, this.clock)
        : null;
      const currentClanData = this.options.runtimeStateService.get(request.categoryId);
      if (
        currentClanData &&
        (dayGuardResult?.shouldCreateRemainAttackMessage || !currentClanData.remainAttackMessageId)
      ) {
        await this.createCurrentRemainAttackMessage(currentClanData, request);
      }
      await this.ensureCurrentSummaryMessage(currentClanData, request);

      const refreshedClanData = this.options.runtimeStateService.get(request.categoryId);
      if (!refreshedClanData) {
        await request.responseChannel.send({
          content: USER_MESSAGES.errors.categoryRequired,
        });
        return null;
      }

      const playerDataList: PlayerData[] = [];
      const displayNamesByUserId = cloneDisplayNamesMap(request.displayNamesByUserId);
      mergeDisplayName(displayNamesByUserId, request.actor);

      if (!request.member && !request.all) {
        const actorPlayerData = refreshedClanData.getPlayerData(request.actor.id);
        if (!actorPlayerData) {
          await request.responseChannel.send({
            content: formatNotManagedMessage(request.actor.displayName),
          });
          return null;
        }

        playerDataList.push(actorPlayerData);
      }

      if (request.member) {
        const targetPlayerData = refreshedClanData.getPlayerData(request.member.id);
        if (!targetPlayerData) {
          await request.responseChannel.send({
            content: formatNotManagedMessage(request.member.displayName),
          });
          return null;
        }

        playerDataList.push(targetPlayerData);
        mergeDisplayName(displayNamesByUserId, request.member);
      }

      if (request.all) {
        playerDataList.push(...refreshedClanData.playerDataMap.values());
      }

      await request.responseChannel.send({
        content: formatRemovingMessage(playerDataList.length),
      });

      const uniquePlayerDataMap = new Map<string, PlayerData>();
      for (const playerData of playerDataList) {
        uniquePlayerDataMap.set(playerData.userId, playerData);
      }

      const removedUserIds = new Set(uniquePlayerDataMap.keys());
      const touchedProgressTargets = this.removePlayerAttackStatuses(refreshedClanData, removedUserIds);

      runInTransaction(this.options.database, () => {
        for (const playerData of uniquePlayerDataMap.values()) {
          this.operationLogRepository.deleteAllByUser(
            refreshedClanData.categoryId,
            playerData.userId,
          );
          this.attackEntryRepository.deleteAllByUser(
            refreshedClanData.categoryId,
            playerData.userId,
          );
          this.resourceAdjustmentRepository.deleteAllByUser(
            refreshedClanData.categoryId,
            playerData.userId,
          );
          this.playerRepository.delete(refreshedClanData.categoryId, playerData.userId, {
            preserveResolvedAttackStatuses: true,
          });
          refreshedClanData.playerDataMap.delete(playerData.userId);
        }
        this.options.runtimeStateService.syncProjectedStateForCategory(
          refreshedClanData.categoryId,
          refreshedClanData.date,
        );
      });

      await this.redrawProgressTargets(
        refreshedClanData,
        touchedProgressTargets,
        displayNamesByUserId,
        request.discordGateway,
      );

      await this.updateRemainAttackMessage(
        refreshedClanData,
        {
          ...request,
          displayNamesByUserId,
        },
      );
      await this.updateSummaryMessage(
        refreshedClanData,
        {
          ...request,
          displayNamesByUserId,
        },
      );

      await request.responseChannel.send({
        content: REMOVE_COMPLETED_MESSAGE,
      });

      return playerDataList.length;
    });
  }

  async setTaskKill(request: SetTaskKillRequest): Promise<boolean> {
    return this.options.runtimeStateService.withCategoryLock(request.categoryId, async () => {
      const clanData = this.options.runtimeStateService.get(request.categoryId);
      const dayGuardResult = clanData
        ? this.options.runtimeStateService.ensureDateUpToDateLocked(request.categoryId, this.clock)
        : null;
      const currentClanData = this.options.runtimeStateService.get(request.categoryId);
      if (
        currentClanData &&
        (dayGuardResult?.shouldCreateRemainAttackMessage || !currentClanData.remainAttackMessageId)
      ) {
        await this.createCurrentRemainAttackMessage(
          currentClanData,
          createMemberRenderContext(
            request.member,
            request.discordGateway,
            request.displayNamesByUserId,
          ),
        );
      }
      await this.ensureCurrentSummaryMessage(
        currentClanData,
        createMemberRenderContext(
          request.member,
          request.discordGateway,
          request.displayNamesByUserId,
        ),
      );

      const refreshedClanData = this.options.runtimeStateService.get(request.categoryId);
      if (!refreshedClanData) {
        return false;
      }

      const playerData = refreshedClanData.getPlayerData(request.member.id);
      if (!playerData) {
        return false;
      }

      playerData.taskKill = request.taskKill;

      runInTransaction(this.options.database, () => {
        this.playerRepository.update(refreshedClanData.categoryId, playerData);
      });

      await this.updateRemainAttackMessage(
        refreshedClanData,
        request.displayNamesByUserId
          ? {
              actor: request.member,
              discordGateway: request.discordGateway,
              displayNamesByUserId: request.displayNamesByUserId,
            }
          : {
              actor: request.member,
              discordGateway: request.discordGateway,
            },
      );

      return true;
    });
  }

  private removePlayerAttackStatuses(
    clanData: ClanData,
    removedUserIds: ReadonlySet<string>,
  ): ProgressTarget[] {
    const targets = new Map<string, ProgressTarget>();

    for (const [lap, bossStatusList] of clanData.bossStatusByLap.entries()) {
      bossStatusList.forEach((bossStatusData, bossIndex) => {
        const hadRemovedUserAttackStatus = bossStatusData.attackPlayers.some((attackStatus) =>
          removedUserIds.has(attackStatus.playerData.userId),
        );
        const keptAttackStatuses = bossStatusData.attackPlayers.filter(
          (attackStatus) =>
            !removedUserIds.has(attackStatus.playerData.userId) || attackStatus.attacked,
        );

        if (!hadRemovedUserAttackStatus) {
          return;
        }

        bossStatusData.attackPlayers = keptAttackStatuses;
        targets.set(`${lap}:${bossIndex}`, {
          lap,
          bossIndex,
        });
      });
    }

    return [...targets.values()].sort((left, right) => {
      if (left.lap !== right.lap) {
        return left.lap - right.lap;
      }

      return left.bossIndex - right.bossIndex;
    });
  }

  private async redrawProgressTargets(
    clanData: ClanData,
    targets: readonly ProgressTarget[],
    displayNamesByUserId: ReadonlyMap<string, string>,
    discordGateway: MemberDiscordGateway,
  ): Promise<void> {
    await this.messageCoordinator.redrawProgressTargets(
      clanData,
      targets,
      displayNamesByUserId,
      discordGateway,
    );
  }

  private async updateRemainAttackMessage(
    clanData: ClanData,
    request: MemberRenderContext,
  ): Promise<void> {
    await this.messageCoordinator.updateRemainAttackMessage(clanData, request);
  }

  private async updateSummaryMessage(
    clanData: ClanData,
    request: MemberRenderContext,
  ): Promise<void> {
    await this.messageCoordinator.updateSummaryMessage(clanData, request);
  }

  private async createCurrentRemainAttackMessage(
    clanData: ClanData,
    request: MemberRenderContext,
  ): Promise<string | null> {
    return this.messageCoordinator.createCurrentRemainAttackMessage(clanData, request);
  }

  private async ensureCurrentSummaryMessage(
    clanData: ClanData | undefined,
    request: MemberRenderContext,
  ): Promise<void> {
    await this.messageCoordinator.ensureCurrentSummaryMessage(clanData, request);
  }
}
