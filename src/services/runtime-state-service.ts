import { BossStatusData } from "../domain/boss-status-data.js";
import { ClanBattleData } from "../domain/clan-battle-data.js";
import { type ClanData } from "../domain/clan-data.js";
import { type AttackStatus } from "../domain/attack-status.js";
import { CarryOver } from "../domain/player-data.js";
import { InternalError } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import { CategoryLock } from "../shared/category-lock.js";
import { ensureClanBattleDay, type ClanBattleDayGuardResult } from "../shared/date-guard.js";
import { type Clock, systemClock } from "../shared/time.js";
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
import { PlayerRepository } from "../repositories/sqlite/player-repository.js";
import { ReserveRepository } from "../repositories/sqlite/reserve-repository.js";

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function createBossStatusList(clanData: ClanData, lap: number): BossStatusData[] {
  return Array.from({ length: clanData.bossChannelIds.length }, (_, bossIndex) => {
    return new BossStatusData({
      lap,
      bossIndex,
      guildId: clanData.guildId,
    });
  });
}

function ensureBossStatusList(clanData: ClanData, lap: number): BossStatusData[] {
  const existing = clanData.bossStatusByLap.get(lap);

  if (existing) {
    return existing;
  }

  const created = createBossStatusList(clanData, lap);
  clanData.bossStatusByLap.set(lap, created);
  return created;
}

export interface RuntimeStateServiceOptions {
  database: SqliteDatabase;
  clanRepository?: ClanRepository;
  playerRepository?: PlayerRepository;
  reserveRepository?: ReserveRepository;
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

export class RuntimeStateService {
  private readonly clanRepository: ClanRepository;
  private readonly playerRepository: PlayerRepository;
  private readonly reserveRepository: ReserveRepository;
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
  private clanDataByCategory = new Map<string, ClanData>();

  constructor(options: RuntimeStateServiceOptions) {
    this.database = options.database;
    this.clanRepository = options.clanRepository ?? new ClanRepository(options.database);
    this.playerRepository = options.playerRepository ?? new PlayerRepository(options.database);
    this.reserveRepository = options.reserveRepository ?? new ReserveRepository(options.database);
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
  }

  restoreFromDatabase(): ReadonlyMap<string, ClanData> {
    const guildConfigMap = this.guildBossInfoRepository.loadAll();
    ClanBattleData.loadGuildConfigMap(guildConfigMap);

    const clanMap = this.clanRepository.findAll();
    const playerMapByCategory = this.playerRepository.findAllGroupedByCategory();
    const reserveMapByCategory = this.reserveRepository.findAllGroupedByCategory(playerMapByCategory);
    const bossStatusMapByCategory = this.bossStatusRepository.findAllGroupedByCategory(clanMap);
    const attackStatusMapByCategory =
      this.attackStatusRepository.findAllGroupedByCategory(playerMapByCategory);
    const carryOverMapByCategory =
      this.carryOverRepository.findAllGroupedByCategory(playerMapByCategory);
    const progressMessageIdsByCategory = this.progressMessageIdRepository.findAllGroupedByCategory();
    const summaryMessageIdsByCategory = this.summaryMessageIdRepository.findAllGroupedByCategory();
    let retiredLegacyReserveCount = 0;

    for (const [categoryId, clanData] of clanMap.entries()) {
      const playerMap = playerMapByCategory.get(categoryId);
      playerMap?.forEach((playerData) => clanData.addPlayerData(playerData));

      clanData.reserveList = reserveMapByCategory.get(categoryId) ?? clanData.reserveList;
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
        const bossStatusList = ensureBossStatusList(clanData, lap);
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

      if (this.cleanupLegacyReserveState(clanData)) {
        retiredLegacyReserveCount += 1;
      }
    }

    this.clanDataByCategory = clanMap;
    this.logger.info("Runtime state restored from SQLite", {
      categoryCount: clanMap.size,
      guildBossInfoCount: guildConfigMap.size,
      retiredLegacyReserveCount,
    });

    return this.getAll();
  }

  get(categoryId: string): ClanData | undefined {
    return this.clanDataByCategory.get(categoryId);
  }

  getAll(): ReadonlyMap<string, ClanData> {
    return new Map(this.clanDataByCategory);
  }

  set(clanData: ClanData): void {
    this.clanDataByCategory.set(clanData.categoryId, clanData);
  }

  delete(categoryId: string): void {
    this.clanDataByCategory.delete(categoryId);
  }

  withCategoryLock<TResult>(
    categoryId: string,
    operation: () => TResult | Promise<TResult>,
  ): Promise<TResult> {
    return this.categoryLock.run(categoryId, operation);
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
      return result;
    }

    const deletedPendingAttackStatuses = this.removePendingAttackStatuses(clanData);

    runInTransaction(this.database, () => {
      for (const playerData of clanData.playerDataMap.values()) {
        this.playerRepository.update(categoryId, playerData);
        this.carryOverRepository.replaceAll(categoryId, playerData.userId, []);
      }

      this.reserveRepository.deleteAllByCategory(categoryId);

      for (const pendingAttackStatus of deletedPendingAttackStatuses) {
        this.attackStatusRepository.delete(
          categoryId,
          pendingAttackStatus.lap,
          pendingAttackStatus.bossIndex,
          pendingAttackStatus.attackStatus,
        );
      }

      this.clanRepository.update(clanData);
    });

    this.logger.info("Clan battle day changed", {
      categoryId,
      previousDayKey: result.previousDayKey,
      currentDayKey: result.currentDayKey,
      deletedPendingAttackStatusCount: deletedPendingAttackStatuses.length,
    });

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

  private cleanupLegacyReserveState(clanData: ClanData): boolean {
    const reserveEntryCount = clanData.reserveList.reduce((sum, reserveList) => sum + reserveList.length, 0);
    const reserveMessageCount = clanData.reserveMessageIds.filter((messageId) => messageId !== null).length;

    if (clanData.reserveChannelId === "0" && reserveEntryCount === 0 && reserveMessageCount === 0) {
      return false;
    }

    const legacyReserveChannelId = clanData.reserveChannelId;
    runInTransaction(this.database, () => {
      this.reserveRepository.deleteAllByCategory(clanData.categoryId);
      clanData.retireLegacyReserve();
      this.clanRepository.update(clanData);
    });

    this.logger.info("Cleaned up legacy reserve state during restore", {
      categoryId: clanData.categoryId,
      legacyReserveChannelId,
      reserveEntryCount,
      reserveMessageCount,
    });

    return true;
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
