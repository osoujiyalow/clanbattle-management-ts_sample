import type { EmbedBuilder } from "discord.js";

import { EMOJIS } from "../constants/emojis.js";
import { USER_MESSAGES } from "../constants/messages.js";
import { type ClanData } from "../domain/clan-data.js";
import { PlayerData } from "../domain/player-data.js";
import { renderProgressEmbed } from "../renderers/progress-renderer.js";
import {
  ProgressMessageIdRepository,
  SummaryMessageIdRepository,
} from "../repositories/sqlite/boss-message-id-repository.js";
import { ClanRepository } from "../repositories/sqlite/clan-repository.js";
import { runInTransaction, type SqliteDatabase } from "../repositories/sqlite/db.js";
import { PlayerRepository } from "../repositories/sqlite/player-repository.js";
import type { Logger } from "../shared/logger.js";
import { type Clock, systemClock } from "../shared/time.js";
import { buildRemainAttackEmbed, sendRemainAttackMessage } from "./remain-attack-message.js";
import type { RuntimeStateService } from "./runtime-state-service.js";

const REMOVE_COMPLETED_MESSAGE = "削除が完了しました。";
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

function createBossSlots(): [string | null, string | null, string | null, string | null, string | null] {
  return [null, null, null, null, null];
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

function isMessageMissingError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error && error.code === 10008) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes("Unknown message id") || error.message.includes("Unknown Message");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
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
  edit(payload: { embeds?: readonly EmbedBuilder[] }): Promise<void>;
}

export interface MemberCreatedMessage {
  readonly id: string;
  addReaction(emoji: string): Promise<void>;
}

export interface MemberTextChannel {
  readonly id: string;
  fetchMessage(messageId: string): Promise<MemberEditableMessage>;
  sendMessage(payload: { content?: string; embeds?: readonly EmbedBuilder[] }): Promise<MemberCreatedMessage>;
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

interface MessageUpdateResult {
  updated: boolean;
  missing: boolean;
}

export interface AddMembersRequest extends MemberServiceBaseRequest {
  role?: MemberRole;
  member?: MemberIdentity;
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

export interface MemberServiceOptions {
  database: SqliteDatabase;
  runtimeStateService: RuntimeStateService;
  playerRepository?: PlayerRepository;
  clanRepository?: ClanRepository;
  progressMessageIdRepository?: ProgressMessageIdRepository;
  summaryMessageIdRepository?: SummaryMessageIdRepository;
  clock?: Clock;
  logger?: Logger;
  redrawRetryDelayMs?: number;
}

export class MemberService {
  private readonly clanRepository: ClanRepository;
  private readonly playerRepository: PlayerRepository;
  private readonly progressMessageIdRepository: ProgressMessageIdRepository;
  private readonly summaryMessageIdRepository: SummaryMessageIdRepository;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly redrawRetryDelayMs: number;

  constructor(private readonly options: MemberServiceOptions) {
    this.clanRepository = options.clanRepository ?? new ClanRepository(options.database);
    this.playerRepository = options.playerRepository ?? new PlayerRepository(options.database);
    this.progressMessageIdRepository =
      options.progressMessageIdRepository ?? new ProgressMessageIdRepository(options.database);
    this.summaryMessageIdRepository =
      options.summaryMessageIdRepository ?? new SummaryMessageIdRepository(options.database);
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.redrawRetryDelayMs = options.redrawRetryDelayMs ?? DEFAULT_REDRAW_RETRY_DELAY_MS;
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
        return clanData.remainAttackMessageId;
      }

      return this.createCurrentRemainAttackMessage(
        clanData,
        createMemberRenderContext(
          request.member,
          request.discordGateway,
          request.displayNamesByUserId,
        ),
      );
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
      }

      await this.updateRemainAttackMessage(
        refreshedClanData,
        {
          ...request,
          displayNamesByUserId,
        },
      );

      return playerDataList.length;
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
          refreshedClanData.reserveList = refreshedClanData.reserveList.map((reserveList) =>
            reserveList.filter((reserveData) => reserveData.playerData.userId !== playerData.userId),
          );
          this.playerRepository.delete(refreshedClanData.categoryId, playerData.userId);
          refreshedClanData.playerDataMap.delete(playerData.userId);
        }
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
        const keptAttackStatuses = bossStatusData.attackPlayers.filter(
          (attackStatus) => !removedUserIds.has(attackStatus.playerData.userId),
        );

        if (keptAttackStatuses.length === bossStatusData.attackPlayers.length) {
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
    for (const target of targets) {
      await this.updateProgressMessage(clanData, target.lap, target.bossIndex, {
        actor: {
          id: "system",
          displayName: "system",
        },
        discordGateway,
        displayNamesByUserId,
      });
      await this.updateSummaryMessage(clanData, target.lap, target.bossIndex, {
        actor: {
          id: "system",
          displayName: "system",
        },
        discordGateway,
        displayNamesByUserId,
      });
    }
  }

  private async updateRemainAttackMessage(
    clanData: ClanData,
    request: MemberRenderContext,
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

    let remainAttackChannel: MemberTextChannel;
    try {
      remainAttackChannel = await request.discordGateway.getTextChannel(clanData.remainAttackChannelId);
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
      buildRemainAttackEmbed(clanData, displayNamesByUserId, this.clock),
      "remain-attack",
      clanData.categoryId,
    );

    if (!result.updated && result.missing) {
      clanData.remainAttackMessageId = null;
      runInTransaction(this.options.database, () => {
        this.clanRepository.update(clanData);
      });
      await this.createCurrentRemainAttackMessage(clanData, {
        ...request,
        displayNamesByUserId,
      });
    }
  }

  private async createCurrentRemainAttackMessage(
    clanData: ClanData,
    request: MemberRenderContext,
  ): Promise<string | null> {
    let remainAttackChannel: MemberTextChannel;
    try {
      remainAttackChannel = await request.discordGateway.getTextChannel(clanData.remainAttackChannelId);
    } catch (error) {
      this.logger.warn("Failed to resolve remain-attack channel", {
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
        this.clock,
      );
      clanData.remainAttackMessageId = result.messageId;
      runInTransaction(this.options.database, () => {
        this.clanRepository.update(clanData);
      });

      if (!result.taskKillReactionAdded) {
        this.logger.warn("Failed to add task-kill reaction to remain-attack message", {
          categoryId: clanData.categoryId,
          messageId: result.messageId,
          error: result.taskKillReactionError,
        });
      }

      return result.messageId;
    } catch (error) {
      this.logger.warn("Failed to create remain-attack message", {
        categoryId: clanData.categoryId,
        error,
      });
      return null;
    }
  }

  private async updateProgressMessage(
    clanData: ClanData,
    lap: number,
    bossIndex: number,
    request: MemberRenderContext,
  ): Promise<void> {
    const progressMessageId = clanData.progressMessageIdsByLap.get(lap)?.[bossIndex];
    if (!progressMessageId) {
      await this.ensureProgressMessage(clanData, lap, bossIndex, request);
      return;
    }

    let bossChannel: MemberTextChannel;
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
    request: MemberRenderContext,
  ): Promise<void> {
    const summaryMessageIds = clanData.summaryMessageIdsByLap.get(lap);
    if (!summaryMessageIds) {
      await this.ensureSummaryMessages(clanData, lap, request);
      return;
    }

    const summaryMessageId = summaryMessageIds[bossIndex];
    if (!summaryMessageId) {
      await this.createSummaryMessage(clanData, lap, bossIndex, request, true);
      return;
    }

    let summaryChannel: MemberTextChannel;
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

    const embed = renderProgressEmbed({
      clanData,
      lap,
      bossIndex,
      displayNamesByUserId: cloneDisplayNamesMap(request.displayNamesByUserId),
    });

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
      await this.createSummaryMessage(clanData, lap, bossIndex, request, true);
    }
  }

  private async ensureProgressMessage(
    clanData: ClanData,
    lap: number,
    bossIndex: number,
    request: MemberRenderContext,
  ): Promise<void> {
    let bossChannel: MemberTextChannel;
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

    const embed = renderProgressEmbed({
      clanData,
      lap,
      bossIndex,
      displayNamesByUserId: cloneDisplayNamesMap(request.displayNamesByUserId),
    });

    try {
      const progressMessage = await bossChannel.sendMessage({
        embeds: [embed],
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

      if (!clanData.summaryMessageIdsByLap.has(lap)) {
        await this.ensureSummaryMessages(clanData, lap, request);
      }
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
    request: MemberRenderContext,
  ): Promise<void> {
    if (clanData.summaryMessageIdsByLap.has(lap)) {
      return;
    }

    let summaryChannel: MemberTextChannel;
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
    for (let bossIndex = 0; bossIndex < clanData.bossChannelIds.length; bossIndex += 1) {
      const embed = renderProgressEmbed({
        clanData,
        lap,
        bossIndex,
        displayNamesByUserId: cloneDisplayNamesMap(request.displayNamesByUserId),
      });

      try {
        const summaryMessage = await summaryChannel.sendMessage({
          embeds: [embed],
        });
        summaryMessageIds[bossIndex] = summaryMessage.id;
      } catch (error) {
        this.logger.warn("Failed to create summary mirror message", {
          categoryId: clanData.categoryId,
          lap,
          bossIndex,
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
    request: MemberRenderContext,
    updateExistingRow: boolean,
  ): Promise<void> {
    let summaryChannel: MemberTextChannel;
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

    const embed = renderProgressEmbed({
      clanData,
      lap,
      bossIndex,
      displayNamesByUserId: cloneDisplayNamesMap(request.displayNamesByUserId),
    });

    try {
      const summaryMessage = await summaryChannel.sendMessage({
        embeds: [embed],
      });

      const summaryMessageIds = clanData.summaryMessageIdsByLap.get(lap) ?? createBossSlots();
      summaryMessageIds[bossIndex] = summaryMessage.id;
      clanData.summaryMessageIdsByLap.set(lap, summaryMessageIds);

      runInTransaction(this.options.database, () => {
        if (updateExistingRow || clanData.summaryMessageIdsByLap.has(lap)) {
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

  private async editMessageWithRetry(
    channel: MemberTextChannel,
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
}
