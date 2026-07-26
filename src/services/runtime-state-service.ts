import type { AttackEntry } from "../domain/attack-entry.js";
import { BossStatusData } from "../domain/boss-status-data.js";
import { ClanBattleData } from "../domain/clan-battle-data.js";
import { type ClanData } from "../domain/clan-data.js";
import type { OperationLog } from "../domain/operation-log.js";
import type { PlayerResourceState } from "../domain/player-resource-state.js";
import type { AttackStatus } from "../domain/attack-status.js";
import { CarryOver } from "../domain/player-data.js";
import { InternalError } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import { CategoryLock } from "../shared/category-lock.js";
import { ensureClanBattleDay, type ClanBattleDayGuardResult } from "../shared/date-guard.js";
import { getClanBattleDayKeyFromClock, now, type Clock, systemClock } from "../shared/time.js";
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
import { GuildBossInfoRepository } from "../repositories/sqlite/guild-bossinfo-repository.js";
import { OperationLogRepository } from "../repositories/sqlite/operation-log-repository.js";
import { PlayerRepository } from "../repositories/sqlite/player-repository.js";
import { PlayerResourceStateRepository } from "../repositories/sqlite/player-resource-state-repository.js";
import { ResourceAdjustmentRepository } from "../repositories/sqlite/resource-adjustment-repository.js";
import { ensureCoreSchema } from "../repositories/sqlite/core-schema.js";
import { encodeSnowflake } from "../repositories/sqlite/sqlite-codec.js";
import { ensureRuntimeBossStatusList } from "./runtime-state-legacy-compatibility.js";
import {
  RuntimeStateProjectionCoordinator,
  type ProjectedStateRefreshResult,
} from "./runtime-state-projection-coordinator.js";

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export type OrphanedCategoryScanStatus = "active" | "orphaned" | "scan-deferred";

export interface OrphanedCategoryScanClassification {
  status: OrphanedCategoryScanStatus;
  reason: string;
  details?: Readonly<Record<string, unknown>>;
}

export interface OrphanedCategoryScanClassifier {
  classify(clanData: ClanData): Promise<OrphanedCategoryScanClassification>;
}

export interface OrphanedCategoryScanRecord {
  guildId: string;
  categoryId: string;
  status: OrphanedCategoryScanStatus;
  reason: string;
  day: string;
  commandChannelId: string;
  remainAttackChannelId: string;
  bossChannelIds: readonly string[];
  details?: Readonly<Record<string, unknown>>;
}

export interface OrphanedCategoryScanReport {
  scannedAt: string;
  scannedCount: number;
  activeCount: number;
  orphanedCount: number;
  scanDeferredCount: number;
  records: readonly OrphanedCategoryScanRecord[];
}

export interface OrphanedCategoryCleanupResult {
  categoryId: string;
  guildId: string;
  deletedCounts: Readonly<Record<string, number>>;
  remainingGuildCategoryCount: number;
  guildConfigDeleted: false;
}

export interface RuntimeStateServiceOptions {
  database: SqliteDatabase;
  clanRepository?: ClanRepository;
  playerRepository?: PlayerRepository;
  attackEntryRepository?: AttackEntryRepository;
  playerResourceStateRepository?: PlayerResourceStateRepository;
  operationLogRepository?: OperationLogRepository;
  resourceAdjustmentRepository?: ResourceAdjustmentRepository;
  attackStatusRepository?: AttackStatusRepository;
  bossStatusRepository?: BossStatusRepository;
  carryOverRepository?: CarryOverRepository;
  guildBossInfoRepository?: GuildBossInfoRepository;
  categoryLock?: CategoryLock;
  logger?: Logger;
  clock?: Clock;
}

interface PendingAttackStatusDeletion {
  lap: number;
  bossIndex: number;
  attackStatus: AttackStatus;
}

export type CategoryStateChangeListener = (categoryId: string) => void;

export class RuntimeStateService {
  private readonly clanRepository: ClanRepository;
  private readonly playerRepository: PlayerRepository;
  private readonly attackEntryRepository: AttackEntryRepository;
  private readonly playerResourceStateRepository: PlayerResourceStateRepository;
  private readonly operationLogRepository: OperationLogRepository;
  private readonly resourceAdjustmentRepository: ResourceAdjustmentRepository;
  private readonly attackStatusRepository: AttackStatusRepository;
  private readonly bossStatusRepository: BossStatusRepository;
  private readonly carryOverRepository: CarryOverRepository;
  private readonly progressMessageIdRepository: ProgressMessageIdRepository;
  private readonly summaryMessageIdRepository: SummaryMessageIdRepository;
  private readonly guildBossInfoRepository: GuildBossInfoRepository;
  private readonly categoryLock: CategoryLock;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly database: SqliteDatabase;
  private readonly projectionCoordinator: RuntimeStateProjectionCoordinator;
  private clanDataByCategory = new Map<string, ClanData>();
  private attackEntriesByCategory = new Map<string, AttackEntry[]>();
  private playerResourceStateByCategory = new Map<
    string,
    Map<string, Map<string, PlayerResourceState>>
  >();
  private operationLogsByCategory = new Map<string, OperationLog[]>();
  private lastOrphanedCategoryScanReport: OrphanedCategoryScanReport | null = null;
  private readonly categoryStateChangeListeners = new Set<CategoryStateChangeListener>();

  constructor(options: RuntimeStateServiceOptions) {
    this.database = options.database;
    this.clanRepository = options.clanRepository ?? new ClanRepository(options.database);
    this.playerRepository = options.playerRepository ?? new PlayerRepository(options.database);
    this.attackEntryRepository =
      options.attackEntryRepository ?? new AttackEntryRepository(options.database);
    this.playerResourceStateRepository =
      options.playerResourceStateRepository ?? new PlayerResourceStateRepository(options.database);
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
    this.progressMessageIdRepository = new ProgressMessageIdRepository(options.database);
    this.summaryMessageIdRepository = new SummaryMessageIdRepository(options.database);
    this.guildBossInfoRepository =
      options.guildBossInfoRepository ?? new GuildBossInfoRepository(options.database);
    this.categoryLock = options.categoryLock ?? new CategoryLock();
    this.logger = options.logger ?? NOOP_LOGGER;
    this.clock = options.clock ?? systemClock;
    this.projectionCoordinator = new RuntimeStateProjectionCoordinator({
      attackEntryRepository: this.attackEntryRepository,
      playerResourceStateRepository: this.playerResourceStateRepository,
      operationLogRepository: this.operationLogRepository,
      resourceAdjustmentRepository: this.resourceAdjustmentRepository,
      playerRepository: this.playerRepository,
    });
  }

  restoreFromDatabase(): ReadonlyMap<string, ClanData> {
    ensureCoreSchema(this.database);

    const guildConfigMap = this.guildBossInfoRepository.loadAll();
    ClanBattleData.loadGuildConfigMap(guildConfigMap);

    const clanMap = this.clanRepository.findAll();
    const playerMapByCategory = this.playerRepository.findAllGroupedByCategory();
    const bossStatusMapByCategory = this.bossStatusRepository.findAllGroupedByCategory(clanMap);
    const attackStatusMapByCategory =
      this.attackStatusRepository.findAllGroupedByCategory(playerMapByCategory);
    const carryOverMapByCategory =
      this.carryOverRepository.findAllGroupedByCategory(playerMapByCategory);
    const progressMessageIdsByCategory = this.progressMessageIdRepository.findAllGroupedByCategory();
    const summaryMessageIdsByCategory = this.summaryMessageIdRepository.findAllGroupedByCategory();

    for (const [categoryId, clanData] of clanMap.entries()) {
      const playerMap = playerMapByCategory.get(categoryId);
      playerMap?.forEach((playerData) => clanData.addPlayerData(playerData));

      clanData.bossStatusByLap = bossStatusMapByCategory.get(categoryId) ?? new Map();
      clanData.progressMessageIdsByLap = progressMessageIdsByCategory.get(categoryId) ?? new Map();
      clanData.summaryMessageIdsByLap = summaryMessageIdsByCategory.get(categoryId) ?? new Map();

      const carryOverMap = carryOverMapByCategory.get(categoryId);
      carryOverMap?.forEach((carryOverList, userId) => {
        const playerData = clanData.getPlayerData(userId);
        if (!playerData) {
          return;
        }

        playerData.carryOverList = carryOverList.map((carryOver) =>
          CarryOver.fromRecord(carryOver.toRecord()),
        );
      });

      const attackStatusByLap = attackStatusMapByCategory.get(categoryId);
      attackStatusByLap?.forEach((attackStatusByBoss, lap) => {
        const bossStatusList = ensureRuntimeBossStatusList(clanData, lap);
        attackStatusByBoss.forEach((attackStatusList, bossIndex) => {
          const bossStatusData =
            bossStatusList[bossIndex] ??
            new BossStatusData({
              lap,
              bossIndex,
              guildId: clanData.guildId,
            });
          bossStatusData.attackPlayers = [...attackStatusList];
          bossStatusList[bossIndex] = bossStatusData;
        });
      });
    }

    this.clanDataByCategory = clanMap;
    for (const categoryId of clanMap.keys()) {
      this.ensureDateUpToDateLocked(categoryId, this.clock);
    }

    this.refreshProjectedRuntimeState(clanMap);
    this.logger.info("Runtime state restored from SQLite", {
      categoryCount: clanMap.size,
      guildBossInfoCount: guildConfigMap.size,
    });

    return this.getAll();
  }

  get(categoryId: string): ClanData | undefined {
    return this.clanDataByCategory.get(categoryId);
  }

  getAll(): ReadonlyMap<string, ClanData> {
    return new Map(this.clanDataByCategory);
  }

  getLastOrphanedCategoryScanReport(): OrphanedCategoryScanReport | null {
    if (!this.lastOrphanedCategoryScanReport) {
      return null;
    }

    return {
      ...this.lastOrphanedCategoryScanReport,
      records: this.lastOrphanedCategoryScanReport.records.map((record) => ({
        ...record,
        bossChannelIds: [...record.bossChannelIds],
      })),
    };
  }

  getCleanupEligibleOrphanedCategories(): readonly OrphanedCategoryScanRecord[] {
    return this.lastOrphanedCategoryScanReport?.records.filter((record) => record.status === "orphaned") ?? [];
  }

  async scanOrphanedCategories(
    classifier: OrphanedCategoryScanClassifier,
  ): Promise<OrphanedCategoryScanReport> {
    const scannedAt = now(this.clock).toISOString();
    const records: OrphanedCategoryScanRecord[] = [];

    for (const clanData of Array.from(this.clanDataByCategory.values()).sort((left, right) =>
      left.categoryId.localeCompare(right.categoryId),
    )) {
      let classification: OrphanedCategoryScanClassification;

      try {
        classification = await classifier.classify(clanData);
      } catch (error) {
        classification = {
          status: "scan-deferred",
          reason: "classification-threw",
          details: { error },
        };
      }

      const record: OrphanedCategoryScanRecord = {
        guildId: clanData.guildId,
        categoryId: clanData.categoryId,
        status: classification.status,
        reason: classification.reason,
        day: clanData.date,
        commandChannelId: clanData.commandChannelId,
        remainAttackChannelId: clanData.remainAttackChannelId,
        bossChannelIds: [...clanData.bossChannelIds],
        ...(classification.details ? { details: classification.details } : {}),
      };
      records.push(record);

      if (record.status === "orphaned") {
        this.logger.warn("Orphaned category detected during startup scan", { ...record });
      } else if (record.status === "scan-deferred") {
        this.logger.warn("Orphaned-category scan deferred", { ...record });
      }
    }

    const report: OrphanedCategoryScanReport = {
      scannedAt,
      scannedCount: records.length,
      activeCount: records.filter((record) => record.status === "active").length,
      orphanedCount: records.filter((record) => record.status === "orphaned").length,
      scanDeferredCount: records.filter((record) => record.status === "scan-deferred").length,
      records,
    };

    this.lastOrphanedCategoryScanReport = report;
    this.logger.info("Startup orphaned-category scan completed", {
      scannedAt,
      scannedCount: report.scannedCount,
      activeCount: report.activeCount,
      orphanedCount: report.orphanedCount,
      scanDeferredCount: report.scanDeferredCount,
    });

    return this.getLastOrphanedCategoryScanReport()!;
  }

  cleanupOrphanedCategory(categoryId: string): OrphanedCategoryCleanupResult {
    const scanRecord = this.lastOrphanedCategoryScanReport?.records.find((record) => record.categoryId === categoryId);
    if (!scanRecord) {
      throw new InternalError(
        "runtime-state.orphaned-category-scan-required",
        `No orphaned-category scan record found for category id: ${categoryId}`,
        {
          details: { categoryId },
        },
      );
    }

    if (scanRecord.status !== "orphaned") {
      throw new InternalError(
        "runtime-state.orphaned-category-cleanup-not-eligible",
        `Category id ${categoryId} is not eligible for orphaned cleanup.`,
        {
          details: {
            categoryId,
            status: scanRecord.status,
            reason: scanRecord.reason,
          },
        },
      );
    }

    const clanData = this.getOrThrow(categoryId);
    const deletedCounts = runInTransaction(this.database, () => {
      const counts = {
        ClanData: this.countRowsByCategory("ClanData", categoryId),
        PlayerData: this.countRowsByCategory("PlayerData", categoryId),
        BossStatusData: this.countRowsByCategory("BossStatusData", categoryId),
        AttackStatus: this.countRowsByCategory("AttackStatus", categoryId),
        CarryOver: this.countRowsByCategory("CarryOver", categoryId),
        AttackEntry: this.countRowsByCategory("AttackEntry", categoryId),
        PlayerResourceState: this.countRowsByCategory("PlayerResourceState", categoryId),
        OperationLog: this.countRowsByCategory("OperationLog", categoryId),
        ResourceAdjustmentLog: this.countRowsByCategory("ResourceAdjustmentLog", categoryId),
        ProgressMessageIdData: this.countRowsByCategory("ProgressMessageIdData", categoryId),
        SummaryMessageIdData: this.countRowsByCategory("SummaryMessageIdData", categoryId),
      } as const;

      this.summaryMessageIdRepository.deleteAllByCategory(categoryId);
      this.progressMessageIdRepository.deleteAllByCategory(categoryId);
      this.resourceAdjustmentRepository.deleteAllByCategory(categoryId);
      this.playerResourceStateRepository.deleteAllByCategory(categoryId);
      this.operationLogRepository.deleteAllByCategory(categoryId);
      this.attackEntryRepository.deleteAllByCategory(categoryId);
      this.attackStatusRepository.deleteAllByCategory(categoryId);
      this.carryOverRepository.deleteAllByCategory(categoryId);
      this.bossStatusRepository.deleteAllByCategory(categoryId);
      this.playerRepository.deleteAllByCategory(categoryId);
      this.clanRepository.delete(categoryId);

      return counts;
    });

    this.delete(categoryId);

    const remainingGuildCategoryCount = this.countClanRowsByGuild(clanData.guildId);
    const result: OrphanedCategoryCleanupResult = {
      categoryId,
      guildId: clanData.guildId,
      deletedCounts,
      remainingGuildCategoryCount,
      guildConfigDeleted: false,
    };

    this.logger.info("Orphaned category cleanup executed", { ...result });
    return result;
  }

  getAttackEntries(categoryId: string): readonly AttackEntry[] {
    return [...(this.attackEntriesByCategory.get(categoryId) ?? [])];
  }

  getOperationLogs(categoryId: string): readonly OperationLog[] {
    return [...(this.operationLogsByCategory.get(categoryId) ?? [])];
  }

  getPlayerResourceStates(categoryId: string): readonly PlayerResourceState[] {
    const userMap = this.playerResourceStateByCategory.get(categoryId);
    if (!userMap) {
      return [];
    }

    const states: PlayerResourceState[] = [];
    for (const dayMap of userMap.values()) {
      states.push(...dayMap.values());
    }

    return states;
  }

  getPlayerResourceState(
    categoryId: string,
    userId: string,
    dayKey: string,
  ): PlayerResourceState | undefined {
    return this.playerResourceStateByCategory.get(categoryId)?.get(userId)?.get(dayKey);
  }

  syncProjectedStateForCategory(
    categoryId: string,
    currentDayKey: string = getClanBattleDayKeyFromClock(this.clock),
    transitionAt: Date = now(this.clock),
  ): ProjectedStateRefreshResult {
    const result = this.projectionCoordinator.refreshCategory(
      categoryId,
      currentDayKey,
      transitionAt,
    );
    this.attackEntriesByCategory.set(categoryId, result.attackEntries);
    this.playerResourceStateByCategory.set(
      categoryId,
      this.projectionCoordinator.groupPlayerResourceStates(result.playerResourceStates),
    );
    this.operationLogsByCategory.set(categoryId, result.operationLogs);
    this.notifyCategoryStateChanged(categoryId);
    return result;
  }

  set(clanData: ClanData): void {
    this.clanDataByCategory.set(clanData.categoryId, clanData);
    this.notifyCategoryStateChanged(clanData.categoryId);
  }

  delete(categoryId: string): void {
    this.clanDataByCategory.delete(categoryId);
    this.attackEntriesByCategory.delete(categoryId);
    this.playerResourceStateByCategory.delete(categoryId);
    this.operationLogsByCategory.delete(categoryId);
  }

  withCategoryLock<TResult>(
    categoryId: string,
    operation: () => TResult | Promise<TResult>,
  ): Promise<TResult> {
    return this.categoryLock.run(categoryId, operation);
  }

  subscribeCategoryStateChanges(listener: CategoryStateChangeListener): () => void {
    this.categoryStateChangeListeners.add(listener);
    return () => {
      this.categoryStateChangeListeners.delete(listener);
    };
  }

  notifyCategoryStateChanged(categoryId: string): void {
    for (const listener of this.categoryStateChangeListeners) {
      try {
        listener(categoryId);
      } catch (error) {
        this.logger.warn("Category state change listener failed", {
          categoryId,
          error,
        });
      }
    }
  }

  async ensureDateUpToDate(
    categoryId: string,
    clock: Clock = this.clock,
  ): Promise<ClanBattleDayGuardResult> {
    return this.withCategoryLock(categoryId, () => this.ensureDateUpToDateLocked(categoryId, clock));
  }

  ensureDateUpToDateLocked(
    categoryId: string,
    clock: Clock = this.clock,
  ): ClanBattleDayGuardResult {
    const clanData = this.getOrThrow(categoryId);
    const result = ensureClanBattleDay(clanData, clock);

    if (!result.changed) {
      this.notifyCategoryStateChanged(categoryId);
      return result;
    }

    const deletedPendingAttackStatuses = this.removePendingAttackStatuses(clanData);
    const transitionAt = now(clock);

    const projectedStateRefreshResult = runInTransaction(this.database, () => {
      for (const playerData of clanData.playerDataMap.values()) {
        this.playerRepository.update(categoryId, playerData);
        this.carryOverRepository.replaceAll(categoryId, playerData.userId, []);
      }

      for (const pendingAttackStatus of deletedPendingAttackStatuses) {
        this.attackStatusRepository.delete(
          categoryId,
          pendingAttackStatus.lap,
          pendingAttackStatus.bossIndex,
          pendingAttackStatus.attackStatus,
        );
      }

      this.summaryMessageIdRepository.deleteAllByCategory(categoryId);
      this.clanRepository.update(clanData);
      return this.projectionCoordinator.pruneHistoricalStateAndRefreshCategory(
        categoryId,
        result.currentDayKey,
        transitionAt,
      );
    });

    this.attackEntriesByCategory.set(categoryId, projectedStateRefreshResult.attackEntries);
    this.playerResourceStateByCategory.set(
      categoryId,
      this.projectionCoordinator.groupPlayerResourceStates(
        projectedStateRefreshResult.playerResourceStates,
      ),
    );
    this.operationLogsByCategory.set(categoryId, projectedStateRefreshResult.operationLogs);

    this.logger.info("Clan battle day changed", {
      categoryId,
      previousDayKey: result.previousDayKey,
      currentDayKey: result.currentDayKey,
      deletedPendingAttackStatusCount: deletedPendingAttackStatuses.length,
      prunedAttackEntryCount: projectedStateRefreshResult.prunedAttackEntryCount,
      prunedOperationLogCount: projectedStateRefreshResult.prunedOperationLogCount,
      prunedPlayerResourceStateCount: projectedStateRefreshResult.prunedPlayerResourceStateCount,
      prunedResourceAdjustmentCount: projectedStateRefreshResult.prunedResourceAdjustmentCount,
      expiredAttackEntryCount: projectedStateRefreshResult.expiredAttackEntryCount,
    });

    this.notifyCategoryStateChanged(categoryId);
    return result;
  }

  private removePendingAttackStatuses(clanData: ClanData): PendingAttackStatusDeletion[] {
    const deletedPendingAttackStatuses: PendingAttackStatusDeletion[] = [];

    for (const [lap, bossStatusList] of clanData.bossStatusByLap.entries()) {
      bossStatusList.forEach((bossStatusData, bossIndex) => {
        const keptAttackStatuses = bossStatusData.attackPlayers.filter((attackStatus) => {
          if (attackStatus.attacked) {
            return true;
          }

          deletedPendingAttackStatuses.push({
            lap,
            bossIndex,
            attackStatus,
          });
          return false;
        });

        bossStatusData.attackPlayers = keptAttackStatuses;
      });
    }

    return deletedPendingAttackStatuses;
  }

  private refreshProjectedRuntimeState(clanMap: ReadonlyMap<string, ClanData>): void {
    const currentDayKey = getClanBattleDayKeyFromClock(this.clock);
    const transitionAt = now(this.clock);
    const attackEntriesByCategory = new Map<string, AttackEntry[]>();
    const playerResourceStateByCategory = new Map<
      string,
      Map<string, Map<string, PlayerResourceState>>
    >();
    const operationLogsByCategory = new Map<string, OperationLog[]>();
    let expiredAttackEntryCount = 0;

    runInTransaction(this.database, () => {
      for (const categoryId of clanMap.keys()) {
        const result = this.projectionCoordinator.refreshCategory(
          categoryId,
          currentDayKey,
          transitionAt,
        );
        attackEntriesByCategory.set(categoryId, result.attackEntries);
        playerResourceStateByCategory.set(
          categoryId,
          this.projectionCoordinator.groupPlayerResourceStates(result.playerResourceStates),
        );
        operationLogsByCategory.set(categoryId, result.operationLogs);
        expiredAttackEntryCount += result.expiredAttackEntryCount;
      }
    });

    this.attackEntriesByCategory = attackEntriesByCategory;
    this.playerResourceStateByCategory = playerResourceStateByCategory;
    this.operationLogsByCategory = operationLogsByCategory;
    this.logger.info("Projected attack state restored from SQLite", {
      categoryCount: clanMap.size,
      attackEntryCount: Array.from(attackEntriesByCategory.values()).reduce(
        (count, attackEntries) => count + attackEntries.length,
        0,
      ),
      playerResourceStateCount: Array.from(playerResourceStateByCategory.values()).reduce(
        (count, userMap) =>
          count +
          Array.from(userMap.values()).reduce((dayCount, dayMap) => dayCount + dayMap.size, 0),
        0,
      ),
      operationLogCount: Array.from(operationLogsByCategory.values()).reduce(
        (count, operationLogs) => count + operationLogs.length,
        0,
      ),
      expiredAttackEntryCount,
    });
  }

  private countRowsByCategory(tableName: string, categoryId: string): number {
    const row = this.database
      .prepare<[bigint], { count: bigint }>(`select count(*) as count from ${tableName} where category_id=?`)
      .get(encodeSnowflake(categoryId));
    return Number(row?.count ?? 0n);
  }

  private countClanRowsByGuild(guildId: string): number {
    const row = this.database
      .prepare<[bigint], { count: bigint }>("select count(*) as count from ClanData where guild_id=?")
      .get(encodeSnowflake(guildId));
    return Number(row?.count ?? 0n);
  }

  private getOrThrow(categoryId: string): ClanData {
    const clanData = this.clanDataByCategory.get(categoryId);

    if (!clanData) {
      throw new InternalError(
        "runtime-state.category-not-found",
        `Unknown category id: ${categoryId}`,
        {
          details: { categoryId },
        },
      );
    }

    return clanData;
  }
}
