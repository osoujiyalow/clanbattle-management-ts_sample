import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

import {
  AttackEntry,
  AttackEntryKind,
  AttackEntryStatus,
} from "../../../src/domain/attack-entry.js";
import { AttackStatus } from "../../../src/domain/attack-status.js";
import { AttackType } from "../../../src/domain/attack-type.js";
import { ClanBattleData } from "../../../src/domain/clan-battle-data.js";
import { ClanData } from "../../../src/domain/clan-data.js";
import { GuildBossInfoConfig } from "../../../src/domain/guild-bossinfo-config.js";
import { OperationLog, OperationLogType } from "../../../src/domain/operation-log.js";
import { CarryOver, PlayerData } from "../../../src/domain/player-data.js";
import {
  ResourceAdjustment,
  ResourceAdjustmentType,
} from "../../../src/domain/resource-adjustment.js";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
  type SqliteDatabase,
} from "../../../src/repositories/sqlite/db.js";
import { StartupBlockingLegacyShapeError } from "../../../src/repositories/sqlite/core-schema.js";
import { AttackEntryRepository } from "../../../src/repositories/sqlite/attack-entry-repository.js";
import { GuildBossInfoRepository } from "../../../src/repositories/sqlite/guild-bossinfo-repository.js";
import { OperationLogRepository } from "../../../src/repositories/sqlite/operation-log-repository.js";
import { PlayerRepository } from "../../../src/repositories/sqlite/player-repository.js";
import { BossStatusRepository } from "../../../src/repositories/sqlite/boss-status-repository.js";
import { AttackStatusRepository } from "../../../src/repositories/sqlite/attack-status-repository.js";
import { CarryOverRepository } from "../../../src/repositories/sqlite/carry-over-repository.js";
import { ClanRepository } from "../../../src/repositories/sqlite/clan-repository.js";
import { ResourceAdjustmentRepository } from "../../../src/repositories/sqlite/resource-adjustment-repository.js";
import { PlayerResourceStateRepository } from "../../../src/repositories/sqlite/player-resource-state-repository.js";
import { encodeOptionalSnowflake, encodeSnowflake } from "../../../src/repositories/sqlite/sqlite-codec.js";
import { formatSqliteDateTime } from "../../../src/repositories/sqlite/sqlite-time.js";
import { RuntimeStateService } from "../../../src/services/runtime-state-service.js";
import type { Logger, LogContext } from "../../../src/shared/logger.js";
import { createFixedClock } from "../../../src/shared/time.js";
import { createCoreRepositorySchema } from "../../unit/repositories/sqlite/core-repository-schema.js";
import { createTempSqlitePath, type TempSqlitePath } from "../../unit/repositories/sqlite/test-sqlite-path.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return {
    promise,
    resolve(value) {
      resolve?.(value);
    },
  };
}

function createMemoryLogger(): {
  logger: Logger;
  records: Array<{ level: string; message: string; context?: LogContext }>;
} {
  const records: Array<{ level: string; message: string; context?: LogContext }> = [];

  const logger: Logger = {
    debug(message, context) {
      records.push({ level: "debug", message, context });
    },
    info(message, context) {
      records.push({ level: "info", message, context });
    },
    warn(message, context) {
      records.push({ level: "warn", message, context });
    },
    error(message, context) {
      records.push({ level: "error", message, context });
    },
  };

  return { logger, records };
}

function createClanData(params?: Partial<ConstructorParameters<typeof ClanData>[0]>): ClanData {
  return new ClanData({
    guildId: "123456789012345678",
    categoryId: "223456789012345678",
    bossChannelIds: [
      "323456789012345678",
      "423456789012345678",
      "523456789012345678",
      "623456789012345678",
      "723456789012345678",
    ],
    remainAttackChannelId: "823456789012345678",
    commandChannelId: "103456789012345678",
    summaryChannelId: "113456789012345678",
    date: "2026-03-07",
    ...params,
  });
}

function insertMessageIdRow(
  database: SqliteDatabase,
  tableName: "ProgressMessageIdData" | "SummaryMessageIdData",
  categoryId: string,
  lap: number,
  messageIds: readonly (string | null)[],
): void {
  database
    .prepare(`insert into ${tableName} values (?, ?, ?, ?, ?, ?, ?)`)
    .run(encodeSnowflake(categoryId), lap, ...messageIds.map(encodeOptionalSnowflake));
}

function createLegacyCoreSchema(database: SqliteDatabase): void {
  database.exec(`
    create table ClanData (
      guild_id int,
      category_id int,
      boss1_channel_id int,
      boss2_channel_id int,
      boss3_channel_id int,
      boss4_channel_id int,
      boss5_channel_id int,
      remain_attack_channel_id int,
      reserve_channel_id int,
      command_channel_id int,
      boss1_reserve_message_id int,
      boss2_reserve_message_id int,
      boss3_reserve_message_id int,
      boss4_reserve_message_id int,
      boss5_reserve_message_id int,
      remain_attack_message_id int,
      summary_channel_id int,
      day date
    );

    create table PlayerData (
      category_id int,
      user_id int,
      physics_attack int default 0,
      magic_attack int default 0,
      task_kill boolean
    );

    create table ReserveData (
      category_id int,
      boss_index int,
      user_id int,
      attack_type varchar,
      damage int,
      memo varchar,
      carry_over boolean
    );

    create table AttackStatus (
      category_id int,
      user_id int,
      lap int,
      boss_index int,
      damage int,
      memo varchar,
      attacked boolean,
      attack_type varchar,
      carry_over boolean,
      created datetime
    );

    create table BossStatusData (
      category_id int,
      boss_index int,
      lap int,
      beated boolean
    );

    create table CarryOver (
      category_id int,
      user_id int,
      boss_index int,
      attack_type varchar,
      carry_over_time int,
      created datetime
    );

    create table ProgressMessageIdData (
      category_id int,
      lap int,
      boss1 int,
      boss2 int,
      boss3 int,
      boss4 int,
      boss5 int
    );

    create table SummaryMessageIdData (
      category_id int,
      lap int,
      boss1 int,
      boss2 int,
      boss3 int,
      boss4 int,
      boss5 int
    );

    create table GuildBossInfoConfig (
      guild_id int primary key,
      hp_json text not null,
      boundaries_json text not null,
      updated_by int,
      updated_at datetime default current_timestamp
    );
  `);
}

function insertLegacyClanDataRow(database: SqliteDatabase, clanData: ClanData): void {
  database
    .prepare("insert into ClanData values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      encodeSnowflake(clanData.guildId),
      encodeSnowflake(clanData.categoryId),
      ...clanData.bossChannelIds.map(encodeSnowflake),
      encodeSnowflake(clanData.remainAttackChannelId),
      999n,
      encodeSnowflake(clanData.commandChannelId),
      401n,
      null,
      null,
      null,
      null,
      clanData.remainAttackMessageId ? BigInt(clanData.remainAttackMessageId) : null,
      encodeSnowflake(clanData.summaryChannelId),
      clanData.date,
    );
}

describe("RuntimeStateService", () => {
  let tempPath: TempSqlitePath | undefined;
  let database: SqliteDatabase | undefined;

  afterEach(() => {
    if (database) {
      closeSqliteDatabase(database);
      database = undefined;
    }

    tempPath?.cleanup();
    tempPath = undefined;
    ClanBattleData.loadGuildConfigMap(new Map());
  });

  it("restores aggregate state from SQLite into the runtime store", () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const clanRepository = new ClanRepository(database);
    const playerRepository = new PlayerRepository(database);
    const bossStatusRepository = new BossStatusRepository(database);
    const attackStatusRepository = new AttackStatusRepository(database);
    const carryOverRepository = new CarryOverRepository(database);
    const guildBossInfoRepository = new GuildBossInfoRepository(database);

    const clanData = createClanData();
    clanRepository.insert(clanData);

    const playerA = new PlayerData({
      userId: "123456789012345679",
      physicsAttack: 1,
    });
    const playerB = new PlayerData({
      userId: "123456789012345680",
      magicAttack: 2,
    });
    playerRepository.insertMany(clanData.categoryId, [playerA, playerB]);
    playerRepository.update(clanData.categoryId, playerA);
    playerRepository.update(clanData.categoryId, playerB);

    clanData.initializeBossStatusData(2);
    const bossStatusList = clanData.bossStatusByLap.get(2)!;
    bossStatusList[1]!.beated = true;
    bossStatusRepository.insertAllForLap(clanData.categoryId, bossStatusList);

    const attackStatus = new AttackStatus({
      playerData: playerA,
      attackType: AttackType.BATTLE,
      carryOver: false,
      damage: 9_876_543,
      memo: "attack memo",
      attacked: true,
      created: new Date("2026-03-07T02:34:56.000Z"),
    });
    attackStatusRepository.insert(clanData.categoryId, 2, 1, attackStatus);

    const carryOver = new CarryOver({
      attackType: AttackType.BATTLE,
      bossIndex: 3,
      created: new Date("2026-03-07T01:23:45.000Z"),
    });
    carryOverRepository.insert(clanData.categoryId, playerB.userId, carryOver);

    insertMessageIdRow(database, "ProgressMessageIdData", clanData.categoryId, 2, [
      "123456789012345681",
      "123456789012345682",
      null,
      null,
      null,
    ]);
    insertMessageIdRow(database, "SummaryMessageIdData", clanData.categoryId, 2, [
      "123456789012345683",
      null,
      null,
      null,
      null,
    ]);

    guildBossInfoRepository.upsert(
      clanData.guildId,
      new GuildBossInfoConfig({
        hp: [
          [11_000_000, 12_000_000, 13_000_000, 14_000_000, 15_000_000],
          [21_000_000, 22_000_000, 23_000_000, 24_000_000, 25_000_000],
          [31_000_000, 32_000_000, 33_000_000, 34_000_000, 35_000_000],
        ],
        boundaries: [
          [1, 3],
          [4, 10],
          [11, -1],
        ],
      }),
      playerA.userId,
    );

    const runtimeStateService = new RuntimeStateService({
      database,
      clock: createFixedClock("2026-03-07T03:00:00.000Z"),
    });
    const runtimeStore = runtimeStateService.restoreFromDatabase();
    const restoredClanData = runtimeStore.get(clanData.categoryId);

    expect(restoredClanData).toBeDefined();
    expect(restoredClanData?.playerDataMap.size).toBe(2);
    expect(restoredClanData?.bossStatusByLap.get(2)?.[1]?.beated).toBe(true);
    expect(restoredClanData?.bossStatusByLap.get(2)?.[1]?.attackPlayers).toHaveLength(1);
    expect(restoredClanData?.bossStatusByLap.get(2)?.[1]?.attackPlayers[0]?.memo).toBe("attack memo");
    expect(restoredClanData?.progressMessageIdsByLap.get(2)?.[1]).toBe("123456789012345682");
    expect(restoredClanData?.summaryMessageIdsByLap.get(2)?.[0]).toBe("123456789012345683");
    expect(restoredClanData?.getPlayerData(playerB.userId)?.carryOverList).toHaveLength(1);
    expect(restoredClanData?.bossStatusByLap.get(2)?.[0]?.maxHp).toBe(11_000_000);
    expect(ClanBattleData.getGuildConfig(clanData.guildId).hp[0]?.[0]).toBe(11_000_000);
  });

  it("collects a report-only orphaned-category startup scan", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const clanRepository = new ClanRepository(database);
    const { logger, records } = createMemoryLogger();

    const activeClan = createClanData({
      guildId: "123456789012345671",
      categoryId: "223456789012345671",
      commandChannelId: "323456789012345671",
      remainAttackChannelId: "423456789012345671",
      summaryChannelId: "523456789012345671",
      bossChannelIds: [
        "623456789012345671",
        "723456789012345671",
        "823456789012345671",
        "923456789012345671",
        "103456789012345671",
      ],
      date: "2026-03-07",
    });
    const deferredClan = createClanData({
      guildId: "123456789012345672",
      categoryId: "223456789012345672",
      commandChannelId: "323456789012345672",
      remainAttackChannelId: "423456789012345672",
      summaryChannelId: "523456789012345672",
      bossChannelIds: [
        "623456789012345672",
        "723456789012345672",
        "823456789012345672",
        "923456789012345672",
        "103456789012345672",
      ],
      date: "2026-03-07",
    });
    const orphanedClan = createClanData({
      guildId: "123456789012345673",
      categoryId: "223456789012345673",
      commandChannelId: "323456789012345673",
      remainAttackChannelId: "423456789012345673",
      summaryChannelId: "523456789012345673",
      bossChannelIds: [
        "623456789012345673",
        "723456789012345673",
        "823456789012345673",
        "923456789012345673",
        "103456789012345673",
      ],
      date: "2026-03-07",
    });

    clanRepository.insert(activeClan);
    clanRepository.insert(deferredClan);
    clanRepository.insert(orphanedClan);

    const runtimeStateService = new RuntimeStateService({
      database,
      logger,
      clock: createFixedClock("2026-03-07T03:00:00.000Z"),
    });
    runtimeStateService.restoreFromDatabase();

    const report = await runtimeStateService.scanOrphanedCategories({
      async classify(clanData) {
        switch (clanData.categoryId) {
          case activeClan.categoryId:
            return {
              status: "active",
              reason: "category-resolved",
            };
          case deferredClan.categoryId:
            return {
              status: "scan-deferred",
              reason: "guild-fetch-failed",
            };
          case orphanedClan.categoryId:
            return {
              status: "orphaned",
              reason: "category-not-found",
            };
          default:
            throw new Error(`unexpected category ${clanData.categoryId}`);
        }
      },
    });

    expect(report).toMatchObject({
      scannedCount: 3,
      activeCount: 1,
      orphanedCount: 1,
      scanDeferredCount: 1,
    });
    expect(report.records.map((record) => [record.categoryId, record.status, record.reason])).toEqual([
      [activeClan.categoryId, "active", "category-resolved"],
      [deferredClan.categoryId, "scan-deferred", "guild-fetch-failed"],
      [orphanedClan.categoryId, "orphaned", "category-not-found"],
    ]);
    expect(report.records.find((record) => record.categoryId === orphanedClan.categoryId)).toMatchObject({
      guildId: orphanedClan.guildId,
      categoryId: orphanedClan.categoryId,
      day: "2026-03-07",
      commandChannelId: orphanedClan.commandChannelId,
      remainAttackChannelId: orphanedClan.remainAttackChannelId,
      bossChannelIds: orphanedClan.bossChannelIds,
    });
    expect(runtimeStateService.getLastOrphanedCategoryScanReport()).toEqual(report);
    expect(runtimeStateService.getAll().size).toBe(3);
    expect(records.some((record) => record.message === "Startup orphaned-category scan completed")).toBe(true);
    expect(records.filter((record) => record.level === "warn").map((record) => record.message)).toEqual([
      "Orphaned-category scan deferred",
      "Orphaned category detected during startup scan",
    ]);
  });

  it("cleans up a reported orphaned category without deleting guild-shared config", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const clanRepository = new ClanRepository(database);
    const playerRepository = new PlayerRepository(database);
    const bossStatusRepository = new BossStatusRepository(database);
    const attackStatusRepository = new AttackStatusRepository(database);
    const carryOverRepository = new CarryOverRepository(database);
    const attackEntryRepository = new AttackEntryRepository(database);
    const operationLogRepository = new OperationLogRepository(database);
    const resourceAdjustmentRepository = new ResourceAdjustmentRepository(database);
    const playerResourceStateRepository = new PlayerResourceStateRepository(database);
    const guildBossInfoRepository = new GuildBossInfoRepository(database);
    const { logger } = createMemoryLogger();

    const activeClan = createClanData({
      guildId: "123456789012345670",
      categoryId: "223456789012345670",
      date: "2026-03-07",
    });
    const orphanedClan = createClanData({
      guildId: "123456789012345670",
      categoryId: "223456789012345671",
      commandChannelId: "323456789012345671",
      remainAttackChannelId: "423456789012345671",
      summaryChannelId: "523456789012345671",
      bossChannelIds: [
        "623456789012345671",
        "723456789012345671",
        "823456789012345671",
        "923456789012345671",
        "103456789012345671",
      ],
      date: "2026-03-07",
    });
    activeClan.initializeBossStatusData(1);
    orphanedClan.initializeBossStatusData(1);
    clanRepository.insert(activeClan);
    clanRepository.insert(orphanedClan);

    const orphanedPlayer = new PlayerData({
      userId: "123456789012345679",
      physicsAttack: 1,
      battleAttackCount: 1,
      taskKill: true,
    });
    playerRepository.insertMany(orphanedClan.categoryId, [orphanedPlayer]);
    playerRepository.update(orphanedClan.categoryId, orphanedPlayer);
    bossStatusRepository.insertAllForLap(orphanedClan.categoryId, orphanedClan.bossStatusByLap.get(1)!);

    const resolvedAttackStatus = new AttackStatus({
      playerData: orphanedPlayer,
      attackType: AttackType.BATTLE,
      carryOver: false,
      attacked: true,
      damage: 123_456,
      memo: "resolved",
      created: new Date("2026-03-07T02:34:56.000Z"),
    });
    attackStatusRepository.insert(orphanedClan.categoryId, 1, 0, resolvedAttackStatus);

    const carryOver = new CarryOver({
      attackType: AttackType.CARRYOVER,
      bossIndex: 0,
      created: new Date("2026-03-07T03:00:00.000Z"),
    });
    carryOverRepository.insert(orphanedClan.categoryId, orphanedPlayer.userId, carryOver);

    attackEntryRepository.insert(
      new AttackEntry({
        attackEntryId: "entry-orphaned",
        categoryId: orphanedClan.categoryId,
        userId: orphanedPlayer.userId,
        dayKey: "2026-03-07",
        lap: 1,
        bossIndex: 0,
        kind: AttackEntryKind.BATTLE,
        status: AttackEntryStatus.FINISHED,
        declaredAt: new Date("2026-03-07T02:00:00.000Z"),
        resolvedAt: new Date("2026-03-07T02:05:00.000Z"),
        damage: 123_456,
        memo: "entry",
      }),
    );
    operationLogRepository.insert(
      new OperationLog({
        operationId: "operation-orphaned",
        categoryId: orphanedClan.categoryId,
        userId: orphanedPlayer.userId,
        dayKey: "2026-03-07",
        lap: 1,
        bossIndex: 0,
        targetAttackEntryId: "entry-orphaned",
        operationType: OperationLogType.FINISH,
        beforeKind: AttackEntryKind.BATTLE,
        afterKind: AttackEntryKind.BATTLE,
        beforeStatus: AttackEntryStatus.DECLARED,
        afterStatus: AttackEntryStatus.FINISHED,
        occurredAt: new Date("2026-03-07T02:05:00.000Z"),
      }),
    );
    resourceAdjustmentRepository.insert(
      new ResourceAdjustment({
        adjustmentId: "adjustment-orphaned",
        categoryId: orphanedClan.categoryId,
        userId: orphanedPlayer.userId,
        actorUserId: orphanedPlayer.userId,
        dayKey: "2026-03-07",
        resourceType: ResourceAdjustmentType.BATTLE,
        remaining: 2,
        occurredAt: new Date("2026-03-07T02:05:00.000Z"),
      }),
    );
    playerResourceStateRepository.upsert({
      categoryId: orphanedClan.categoryId,
      userId: orphanedPlayer.userId,
      dayKey: "2026-03-07",
      battleReservedCount: 0,
      battleConsumedCount: 1,
      carryAvailableCount: 0,
      carryReservedCount: 0,
    });
    insertMessageIdRow(database, "ProgressMessageIdData", orphanedClan.categoryId, 1, [
      "123456789012345681",
      null,
      null,
      null,
      null,
    ]);
    insertMessageIdRow(database, "SummaryMessageIdData", orphanedClan.categoryId, 1, [
      "123456789012345682",
      null,
      null,
      null,
      null,
    ]);

    guildBossInfoRepository.upsert(
      orphanedClan.guildId,
      new GuildBossInfoConfig({
        hp: [
          [11_000_000, 12_000_000, 13_000_000, 14_000_000, 15_000_000],
          [21_000_000, 22_000_000, 23_000_000, 24_000_000, 25_000_000],
          [31_000_000, 32_000_000, 33_000_000, 34_000_000, 35_000_000],
        ],
        boundaries: [
          [1, 3],
          [4, 10],
          [11, -1],
        ],
      }),
      orphanedPlayer.userId,
    );

    const runtimeStateService = new RuntimeStateService({
      database,
      logger,
      clock: createFixedClock("2026-03-07T03:00:00.000Z"),
    });
    runtimeStateService.restoreFromDatabase();
    await runtimeStateService.scanOrphanedCategories({
      async classify(clanData) {
        return clanData.categoryId === orphanedClan.categoryId
          ? { status: "orphaned", reason: "category-not-found" }
          : { status: "active", reason: "category-resolved" };
      },
    });

    const result = runtimeStateService.cleanupOrphanedCategory(orphanedClan.categoryId);

    expect(result).toMatchObject({
      categoryId: orphanedClan.categoryId,
      guildId: orphanedClan.guildId,
      remainingGuildCategoryCount: 1,
      guildConfigDeleted: false,
      deletedCounts: {
        ClanData: 1,
        PlayerData: 1,
        BossStatusData: 5,
        AttackStatus: 1,
        CarryOver: 1,
        AttackEntry: 1,
        PlayerResourceState: 1,
        OperationLog: 1,
        ResourceAdjustmentLog: 1,
        ProgressMessageIdData: 1,
        SummaryMessageIdData: 1,
      },
    });
    expect(runtimeStateService.get(orphanedClan.categoryId)).toBeUndefined();
    expect(runtimeStateService.get(activeClan.categoryId)).toBeDefined();
    expect(clanRepository.findByCategoryId(orphanedClan.categoryId)).toBeNull();
    expect(playerRepository.findByCategoryId(orphanedClan.categoryId).size).toBe(0);
    expect(bossStatusRepository.findAllGroupedByCategory(new Map()).get(orphanedClan.categoryId)).toBeUndefined();
    expect(attackStatusRepository.findAllGroupedByCategory(new Map()).get(orphanedClan.categoryId)).toBeUndefined();
    expect(carryOverRepository.findAllGroupedByCategory(new Map()).get(orphanedClan.categoryId)).toBeUndefined();
    expect(attackEntryRepository.findAllByCategory(orphanedClan.categoryId)).toHaveLength(0);
    expect(operationLogRepository.findAllByCategory(orphanedClan.categoryId)).toHaveLength(0);
    expect(playerResourceStateRepository.findAllByCategory(orphanedClan.categoryId)).toHaveLength(0);
    expect(resourceAdjustmentRepository.findAllByCategory(orphanedClan.categoryId)).toHaveLength(0);
    expect(
      database
        .prepare<[], { count: bigint }>("select count(*) as count from GuildBossInfoConfig where guild_id = ?")
        .get(encodeSnowflake(orphanedClan.guildId))?.count,
    ).toBe(1n);
  });

  it("refuses orphaned cleanup when the category was not reported as orphaned", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const clanRepository = new ClanRepository(database);
    const clanData = createClanData({
      guildId: "123456789012345674",
      categoryId: "223456789012345674",
      date: "2026-03-07",
    });
    clanRepository.insert(clanData);

    const runtimeStateService = new RuntimeStateService({
      database,
      clock: createFixedClock("2026-03-07T03:00:00.000Z"),
    });
    runtimeStateService.restoreFromDatabase();

    expect(() => runtimeStateService.cleanupOrphanedCategory(clanData.categoryId)).toThrowError(
      /No orphaned-category scan record found/,
    );

    await runtimeStateService.scanOrphanedCategories({
      async classify() {
        return {
          status: "active",
          reason: "category-resolved",
        };
      },
    });

    expect(() => runtimeStateService.cleanupOrphanedCategory(clanData.categoryId)).toThrowError(
      /not eligible for orphaned cleanup/,
    );
  });

  it("rebuilds projected attack state from AttackEntry during restore", () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const clanRepository = new ClanRepository(database);
    const attackEntryRepository = new AttackEntryRepository(database);
    const operationLogRepository = new OperationLogRepository(database);
    const clanData = createClanData({
      date: "2026-03-28",
    });

    clanRepository.insert(clanData);
    attackEntryRepository.insert(
      new AttackEntry({
        attackEntryId: "attack-1",
        categoryId: clanData.categoryId,
        userId: "123456789012345679",
        dayKey: "2026-03-28",
        lap: 4,
        bossIndex: 0,
        kind: AttackEntryKind.BATTLE,
        status: AttackEntryStatus.DEFEATED,
        declaredAt: new Date("2026-03-28T09:00:00+09:00"),
        resolvedAt: new Date("2026-03-28T09:03:00+09:00"),
      }),
    );
    attackEntryRepository.insert(
      new AttackEntry({
        attackEntryId: "attack-2",
        categoryId: clanData.categoryId,
        userId: "123456789012345679",
        dayKey: "2026-03-28",
        lap: 4,
        bossIndex: 1,
        kind: AttackEntryKind.CARRYOVER,
        status: AttackEntryStatus.DECLARED,
        declaredAt: new Date("2026-03-28T09:05:00+09:00"),
      }),
    );
    operationLogRepository.insert(
      new OperationLog({
        operationId: "operation-1",
        categoryId: clanData.categoryId,
        userId: "123456789012345679",
        dayKey: "2026-03-28",
        lap: 4,
        bossIndex: 0,
        targetAttackEntryId: "attack-1",
        operationType: OperationLogType.DEFEAT,
        beforeKind: AttackEntryKind.BATTLE,
        afterKind: AttackEntryKind.BATTLE,
        beforeStatus: AttackEntryStatus.DECLARED,
        afterStatus: AttackEntryStatus.DEFEATED,
        occurredAt: new Date("2026-03-28T09:03:00+09:00"),
      }),
    );
    database.exec("delete from PlayerResourceState");
    database
      .prepare(
        "insert into PlayerResourceState values (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(encodeSnowflake(clanData.categoryId), 123456789012345679n, "2026-03-28", 9, 9, 9, 9);

    const runtimeStateService = new RuntimeStateService({
      database,
      clock: createFixedClock("2026-03-28T03:00:00.000Z"),
    });
    runtimeStateService.restoreFromDatabase();

    expect(runtimeStateService.getAttackEntries(clanData.categoryId)).toHaveLength(2);
    expect(
      runtimeStateService
        .getPlayerResourceState(clanData.categoryId, "123456789012345679", "2026-03-28")
        ?.toRecord(),
    ).toEqual({
      categoryId: clanData.categoryId,
      userId: "123456789012345679",
      dayKey: "2026-03-28",
      battleReservedCount: 0,
      battleConsumedCount: 1,
      carryAvailableCount: 0,
      carryReservedCount: 1,
    });
    expect(runtimeStateService.getOperationLogs(clanData.categoryId)).toHaveLength(1);

    const projectionRow = database
      .prepare<
        [],
        {
          battle_reserved_count: bigint;
          battle_consumed_count: bigint;
          carry_available_count: bigint;
          carry_reserved_count: bigint;
        }
      >(
        "select battle_reserved_count, battle_consumed_count, carry_available_count, carry_reserved_count from PlayerResourceState where category_id = 223456789012345678 and user_id = 123456789012345679 and day_key = '2026-03-28'",
      )
      .get();
    expect(projectionRow).toEqual({
      battle_reserved_count: 0n,
      battle_consumed_count: 1n,
      carry_available_count: 0n,
      carry_reserved_count: 1n,
    });
  });

  it("keeps attacked progress rows empty when PlayerData is missing even if projected cache exists", () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const clanRepository = new ClanRepository(database);
    const attackEntryRepository = new AttackEntryRepository(database);
    const operationLogRepository = new OperationLogRepository(database);
    const clanData = createClanData({
      date: "2026-03-28",
      progressMessageIdsByLap: new Map([[4, ["123", null, null, null, null]]]),
    });
    clanData.initializeBossStatusData(4);
    clanRepository.insert(clanData);

    attackEntryRepository.insert(
      new AttackEntry({
        attackEntryId: "attack-1",
        categoryId: clanData.categoryId,
        userId: "123456789012345679",
        dayKey: "2026-03-28",
        lap: 4,
        bossIndex: 0,
        kind: AttackEntryKind.BATTLE,
        status: AttackEntryStatus.FINISHED,
        declaredAt: new Date("2026-03-28T09:00:00+09:00"),
        resolvedAt: new Date("2026-03-28T09:03:00+09:00"),
        damage: 7_654_321,
      }),
    );
    operationLogRepository.insert(
      new OperationLog({
        operationId: "operation-1",
        categoryId: clanData.categoryId,
        userId: "123456789012345679",
        dayKey: "2026-03-28",
        lap: 4,
        bossIndex: 0,
        targetAttackEntryId: "attack-1",
        operationType: OperationLogType.FINISH,
        beforeKind: AttackEntryKind.BATTLE,
        afterKind: AttackEntryKind.BATTLE,
        beforeStatus: AttackEntryStatus.DECLARED,
        afterStatus: AttackEntryStatus.FINISHED,
        occurredAt: new Date("2026-03-28T09:03:00+09:00"),
      }),
    );

    const runtimeStateService = new RuntimeStateService({
      database,
      clock: createFixedClock("2026-03-28T03:00:00.000Z"),
    });
    runtimeStateService.restoreFromDatabase();

    const restoredClanData = runtimeStateService.get(clanData.categoryId);
    expect(restoredClanData?.playerDataMap.size).toBe(0);
    expect(restoredClanData?.bossStatusByLap.get(4)).toBeUndefined();
    expect(runtimeStateService.getAttackEntries(clanData.categoryId)).toHaveLength(1);
    expect(runtimeStateService.getOperationLogs(clanData.categoryId)).toHaveLength(1);
  });

  it("refreshes projected cache without overwriting canonical runtime player and boss state", () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const clanRepository = new ClanRepository(database);
    const playerRepository = new PlayerRepository(database);
    const bossStatusRepository = new BossStatusRepository(database);
    const attackStatusRepository = new AttackStatusRepository(database);
    const carryOverRepository = new CarryOverRepository(database);
    const attackEntryRepository = new AttackEntryRepository(database);
    const playerResourceStateRepository = new PlayerResourceStateRepository(database);

    const playerData = new PlayerData({
      userId: "123456789012345679",
      physicsAttack: 2,
      magicAttack: 0,
      battleAttackCount: 2,
      carryOverList: [
        new CarryOver({
          attackType: AttackType.BATTLE,
          bossIndex: 0,
          created: new Date("2026-03-28T08:55:00+09:00"),
        }),
      ],
    });
    const clanData = createClanData({
      date: "2026-03-28",
      playerDataMap: new Map([[playerData.userId, playerData]]),
    });
    clanData.initializeBossStatusData(4);

    const canonicalAttackStatus = new AttackStatus({
      playerData,
      attackType: AttackType.BATTLE,
      carryOver: false,
      attacked: true,
      damage: 1_234_567,
      memo: "canonical status",
      created: new Date("2026-03-28T08:50:00+09:00"),
    });
    clanData.bossStatusByLap.get(4)![0]!.attackPlayers.push(canonicalAttackStatus);

    clanRepository.insert(clanData);
    playerRepository.insertMany(clanData.categoryId, [playerData]);
    playerRepository.update(clanData.categoryId, playerData);
    bossStatusRepository.insertAllForLap(clanData.categoryId, clanData.bossStatusByLap.get(4)!);
    attackStatusRepository.insert(clanData.categoryId, 4, 0, canonicalAttackStatus);
    carryOverRepository.replaceAll(clanData.categoryId, playerData.userId, playerData.carryOverList);

    const runtimeStateService = new RuntimeStateService({
      database,
      clock: createFixedClock("2026-03-28T03:00:00.000Z"),
    });
    const restoredClanData = runtimeStateService.restoreFromDatabase().get(clanData.categoryId);
    const restoredPlayerData = restoredClanData?.getPlayerData(playerData.userId);

    attackEntryRepository.insert(
      new AttackEntry({
        attackEntryId: "attack-projected-1",
        categoryId: clanData.categoryId,
        userId: playerData.userId,
        dayKey: "2026-03-28",
        lap: 4,
        bossIndex: 0,
        kind: AttackEntryKind.BATTLE,
        status: AttackEntryStatus.FINISHED,
        declaredAt: new Date("2026-03-28T09:00:00+09:00"),
        resolvedAt: new Date("2026-03-28T09:03:00+09:00"),
        damage: 7_654_321,
        memo: "projected entry",
      }),
    );
    playerResourceStateRepository.upsert({
      categoryId: clanData.categoryId,
      userId: playerData.userId,
      dayKey: "2026-03-28",
      battleReservedCount: 0,
      battleConsumedCount: 2,
      carryAvailableCount: 0,
      carryReservedCount: 0,
    });

    runtimeStateService.syncProjectedStateForCategory(clanData.categoryId, "2026-03-28");

    expect(runtimeStateService.getAttackEntries(clanData.categoryId)).toHaveLength(1);
    expect(
      runtimeStateService.getPlayerResourceState(clanData.categoryId, playerData.userId, "2026-03-28"),
    ).toMatchObject({
      battleConsumedCount: 1,
      carryAvailableCount: 0,
    });
    expect(restoredPlayerData?.battleAttackCount).toBe(2);
    expect(restoredPlayerData?.carryOverList).toHaveLength(1);
    expect(restoredClanData?.bossStatusByLap.get(4)?.[0]?.attackPlayers).toHaveLength(1);
    expect(restoredClanData?.bossStatusByLap.get(4)?.[0]?.attackPlayers[0]?.memo).toBe(
      "canonical status",
    );
    expect(restoredClanData?.bossStatusByLap.get(4)?.[0]?.attackPlayers[0]?.damage).toBe(1_234_567);
  });

  it("prunes stale previous-day attack entries during restore", () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const clanRepository = new ClanRepository(database);
    const attackEntryRepository = new AttackEntryRepository(database);
    const clanData = createClanData({
      date: "2026-03-27",
    });

    clanRepository.insert(clanData);
    attackEntryRepository.insert(
      new AttackEntry({
        attackEntryId: "attack-1",
        categoryId: clanData.categoryId,
        userId: "123456789012345679",
        dayKey: "2026-03-27",
        lap: 4,
        bossIndex: 0,
        kind: AttackEntryKind.BATTLE,
        status: AttackEntryStatus.DECLARED,
        declaredAt: new Date("2026-03-27T23:00:00+09:00"),
      }),
    );

      const runtimeStateService = new RuntimeStateService({
        database,
        clock: createFixedClock("2026-03-28T00:30:00.000Z"),
      });
      runtimeStateService.restoreFromDatabase();

      const restoredClanData = runtimeStateService.get(clanData.categoryId);
      expect(restoredClanData?.date).toBe("2026-03-28");
      expect(runtimeStateService.getAttackEntries(clanData.categoryId)).toHaveLength(0);
      expect(
        runtimeStateService.getPlayerResourceState(clanData.categoryId, "123456789012345679", "2026-03-27"),
      ).toBeUndefined();
      expect(runtimeStateService.getOperationLogs(clanData.categoryId)).toHaveLength(0);
      expect(
        database
          .prepare<[], { count: bigint }>("select count(*) as count from AttackEntry")
          .get()?.count,
      ).toBe(0n);
      expect(
        database
          .prepare<[], { count: bigint }>("select count(*) as count from OperationLog")
          .get()?.count,
      ).toBe(0n);
    });

    it("applies JST 5:00 recovery on restore without redrawing historical progress state", () => {
      tempPath = createTempSqlitePath();
      database = openSqliteDatabase({ filePath: tempPath.filePath });
      createCoreRepositorySchema(database);

      const clanRepository = new ClanRepository(database);
      const playerRepository = new PlayerRepository(database);
      const bossStatusRepository = new BossStatusRepository(database);
      const attackStatusRepository = new AttackStatusRepository(database);
      const carryOverRepository = new CarryOverRepository(database);
      const attackEntryRepository = new AttackEntryRepository(database);
      const operationLogRepository = new OperationLogRepository(database);
      const resourceAdjustmentRepository = new ResourceAdjustmentRepository(database);

      const playerData = new PlayerData({
        userId: "123456789012345679",
        physicsAttack: 2,
        magicAttack: 1,
        carryOverList: [
          new CarryOver({
            attackType: AttackType.BATTLE,
            bossIndex: 3,
            created: new Date("2026-03-07T12:34:56.000Z"),
          }),
        ],
        taskKill: true,
      });
      const clanData = createClanData({
        date: "2026-03-07",
        remainAttackMessageId: "123456789012345699",
        playerDataMap: new Map([[playerData.userId, playerData]]),
        progressMessageIdsByLap: new Map([[44, ["123456789012345684", null, null, null, null]]]),
        summaryMessageIdsByLap: new Map([[44, ["123456789012345685", null, null, null, null]]]),
      });
      clanData.initializeBossStatusData(44);

      const resolvedAttackStatus = new AttackStatus({
        playerData,
        attackType: AttackType.BATTLE,
        carryOver: false,
        attacked: true,
        damage: 654_321,
        memo: "resolved",
        created: new Date("2026-03-07T03:45:00.000Z"),
      });
      clanData.bossStatusByLap.get(44)![3]!.attackPlayers.push(resolvedAttackStatus);

      clanRepository.insert(clanData);
      playerRepository.insertMany(clanData.categoryId, [playerData]);
      playerRepository.update(clanData.categoryId, playerData);
      bossStatusRepository.insertAllForLap(clanData.categoryId, clanData.bossStatusByLap.get(44)!);
      attackStatusRepository.insert(clanData.categoryId, 44, 3, resolvedAttackStatus);
      carryOverRepository.replaceAll(clanData.categoryId, playerData.userId, playerData.carryOverList);
      insertMessageIdRow(database, "ProgressMessageIdData", clanData.categoryId, 44, [
        "123456789012345684",
        null,
        null,
        null,
        null,
      ]);
      insertMessageIdRow(database, "SummaryMessageIdData", clanData.categoryId, 44, [
        "123456789012345685",
        null,
        null,
        null,
        null,
      ]);
      attackEntryRepository.insert(
        new AttackEntry({
          attackEntryId: "attack-restore-1",
          categoryId: clanData.categoryId,
          userId: playerData.userId,
          dayKey: "2026-03-07",
          lap: 44,
          bossIndex: 3,
          kind: AttackEntryKind.BATTLE,
          status: AttackEntryStatus.FINISHED,
          declaredAt: new Date("2026-03-07T03:40:00.000Z"),
          resolvedAt: new Date("2026-03-07T03:45:00.000Z"),
          damage: 654_321,
        }),
      );
      operationLogRepository.insert(
        new OperationLog({
          operationId: "operation-restore-1",
          categoryId: clanData.categoryId,
          userId: playerData.userId,
          dayKey: "2026-03-07",
          lap: 44,
          bossIndex: 3,
          targetAttackEntryId: "attack-restore-1",
          operationType: OperationLogType.FINISH,
          beforeKind: AttackEntryKind.BATTLE,
          afterKind: AttackEntryKind.BATTLE,
          beforeStatus: AttackEntryStatus.DECLARED,
          afterStatus: AttackEntryStatus.FINISHED,
          occurredAt: new Date("2026-03-07T03:45:00.000Z"),
        }),
      );
      resourceAdjustmentRepository.insert(
        new ResourceAdjustment({
          adjustmentId: "adjustment-restore-1",
          categoryId: clanData.categoryId,
          userId: playerData.userId,
          actorUserId: playerData.userId,
          dayKey: "2026-03-07",
          resourceType: ResourceAdjustmentType.BATTLE,
          remaining: 2,
          occurredAt: new Date("2026-03-07T03:46:00.000Z"),
        }),
      );
      database
        .prepare("insert into PlayerResourceState values (?, ?, ?, ?, ?, ?, ?)")
        .run(
          encodeSnowflake(clanData.categoryId),
          encodeSnowflake(playerData.userId),
          "2026-03-07",
          0,
          1,
          0,
          0,
        );

      const runtimeStateService = new RuntimeStateService({
        database,
        clock: createFixedClock("2026-03-08T00:30:00.000Z"),
      });
      const restoredClanData = runtimeStateService.restoreFromDatabase().get(clanData.categoryId);
      const restoredPlayerData = restoredClanData?.getPlayerData(playerData.userId);

      expect(restoredClanData?.date).toBe("2026-03-08");
      expect(restoredClanData?.remainAttackMessageId).toBeNull();
      expect(restoredPlayerData?.physicsAttack).toBe(0);
      expect(restoredPlayerData?.magicAttack).toBe(0);
      expect(restoredPlayerData?.taskKill).toBe(false);
      expect(restoredPlayerData?.carryOverList).toHaveLength(0);
      expect(restoredClanData?.progressMessageIdsByLap.get(44)?.[0]).toBe("123456789012345684");
      expect(restoredClanData?.summaryMessageIdsByLap.size).toBe(0);
      expect(restoredClanData?.bossStatusByLap.get(44)?.[3]?.attackPlayers).toHaveLength(1);
      expect(restoredClanData?.bossStatusByLap.get(44)?.[3]?.attackPlayers[0]?.memo).toBe("resolved");
      expect(restoredClanData?.bossStatusByLap.get(44)?.[3]?.attackPlayers[0]?.damage).toBe(654_321);
      expect(runtimeStateService.getAttackEntries(clanData.categoryId)).toHaveLength(0);
      expect(runtimeStateService.getOperationLogs(clanData.categoryId)).toHaveLength(0);
      expect(runtimeStateService.getPlayerResourceStates(clanData.categoryId)).toHaveLength(0);
    });

  it("prunes declared attack entries and rebuilds projection when the clan battle day changes", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const clanRepository = new ClanRepository(database);
    const playerRepository = new PlayerRepository(database);
    const attackEntryRepository = new AttackEntryRepository(database);
    const clanData = createClanData({
      date: "2026-03-07",
    });
    const playerData = new PlayerData({
      userId: "123456789012345679",
      physicsAttack: 1,
    });

    clanRepository.insert(clanData);
    playerRepository.insertMany(clanData.categoryId, [playerData]);
    attackEntryRepository.insert(
      new AttackEntry({
        attackEntryId: "attack-1",
        categoryId: clanData.categoryId,
        userId: playerData.userId,
        dayKey: "2026-03-07",
        lap: 2,
        bossIndex: 0,
        kind: AttackEntryKind.BATTLE,
        status: AttackEntryStatus.DECLARED,
        declaredAt: new Date("2026-03-07T13:00:00+09:00"),
      }),
    );

    const runtimeStateService = new RuntimeStateService({
      database,
      clock: createFixedClock("2026-03-07T03:00:00.000Z"),
    });
    runtimeStateService.restoreFromDatabase();

    expect(runtimeStateService.getAttackEntries(clanData.categoryId)[0]?.status).toBe(
      AttackEntryStatus.DECLARED,
    );

    await runtimeStateService.ensureDateUpToDate(
      clanData.categoryId,
      createFixedClock("2026-03-08T00:30:00.000Z"),
    );

    expect(runtimeStateService.getAttackEntries(clanData.categoryId)).toHaveLength(0);
    expect(
      runtimeStateService.getPlayerResourceState(clanData.categoryId, playerData.userId, "2026-03-07"),
    ).toBeUndefined();
    expect(runtimeStateService.getOperationLogs(clanData.categoryId)).toHaveLength(0);

    expect(
      database
        .prepare<[], { count: bigint }>("select count(*) as count from AttackEntry")
        .get()?.count,
    ).toBe(0n);
    expect(
      database
        .prepare<[], { count: bigint }>("select count(*) as count from OperationLog")
        .get()?.count,
    ).toBe(0n);
    expect(
      database
        .prepare<[], { count: bigint }>("select count(*) as count from PlayerResourceState")
        .get()?.count,
    ).toBe(0n);
  });

  it("prunes previous-day hidden state while preserving late-lap confirmed chip damage", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const clanRepository = new ClanRepository(database);
    const playerRepository = new PlayerRepository(database);
    const bossStatusRepository = new BossStatusRepository(database);
    const attackStatusRepository = new AttackStatusRepository(database);
    const attackEntryRepository = new AttackEntryRepository(database);
    const operationLogRepository = new OperationLogRepository(database);
    const resourceAdjustmentRepository = new ResourceAdjustmentRepository(database);
    const playerData = new PlayerData({
      userId: "123456789012345679",
      physicsAttack: 1,
    });
    const clanData = createClanData({
      date: "2026-03-07",
      playerDataMap: new Map([[playerData.userId, playerData]]),
    });
    clanData.initializeBossStatusData(44);

    const resolvedAttackStatus = new AttackStatus({
      playerData,
      attackType: AttackType.BATTLE,
      carryOver: false,
      attacked: true,
      damage: 7_654_321,
      memo: "late-lap chip",
      created: new Date("2026-03-07T22:45:00+09:00"),
    });
    clanData.bossStatusByLap.get(44)?.[3]?.attackPlayers.push(resolvedAttackStatus);

    clanRepository.insert(clanData);
    playerRepository.insertMany(clanData.categoryId, [playerData]);
    playerRepository.update(clanData.categoryId, playerData);
    bossStatusRepository.insertAllForLap(clanData.categoryId, clanData.bossStatusByLap.get(44)!);
    attackStatusRepository.insert(clanData.categoryId, 44, 3, resolvedAttackStatus);
    attackEntryRepository.insert(
      new AttackEntry({
        attackEntryId: "attack-44-4",
        categoryId: clanData.categoryId,
        userId: playerData.userId,
        dayKey: "2026-03-07",
        lap: 44,
        bossIndex: 3,
        kind: AttackEntryKind.BATTLE,
        status: AttackEntryStatus.FINISHED,
        declaredAt: new Date("2026-03-07T22:40:00+09:00"),
        resolvedAt: new Date("2026-03-07T22:45:00+09:00"),
        damage: 7_654_321,
      }),
    );
    operationLogRepository.insert(
      new OperationLog({
        operationId: "operation-44-4",
        categoryId: clanData.categoryId,
        userId: playerData.userId,
        dayKey: "2026-03-07",
        lap: 44,
        bossIndex: 3,
        targetAttackEntryId: "attack-44-4",
        operationType: OperationLogType.FINISH,
        beforeKind: AttackEntryKind.BATTLE,
        afterKind: AttackEntryKind.BATTLE,
        beforeStatus: AttackEntryStatus.DECLARED,
        afterStatus: AttackEntryStatus.FINISHED,
        occurredAt: new Date("2026-03-07T22:45:00+09:00"),
      }),
    );
    resourceAdjustmentRepository.insert(
      new ResourceAdjustment({
        adjustmentId: "adjustment-44-4",
        categoryId: clanData.categoryId,
        userId: playerData.userId,
        actorUserId: playerData.userId,
        dayKey: "2026-03-07",
        resourceType: ResourceAdjustmentType.BATTLE,
        remaining: 2,
        occurredAt: new Date("2026-03-07T22:46:00+09:00"),
      }),
    );
    database
      .prepare("insert into PlayerResourceState values (?, ?, ?, ?, ?, ?, ?)")
      .run(
        encodeSnowflake(clanData.categoryId),
        encodeSnowflake(playerData.userId),
        "2026-03-07",
        0,
        1,
        0,
        0,
      );

    const runtimeStateService = new RuntimeStateService({
      database,
      clock: createFixedClock("2026-03-08T00:30:00.000Z"),
    });
    runtimeStateService.set(clanData);

    const result = await runtimeStateService.ensureDateUpToDate(clanData.categoryId);

    expect(result).toEqual({
      changed: true,
      previousDayKey: "2026-03-07",
      currentDayKey: "2026-03-08",
      shouldCreateRemainAttackMessage: true,
    });
    expect(clanData.date).toBe("2026-03-08");
    expect(clanData.bossStatusByLap.get(44)?.[3]?.attackPlayers).toHaveLength(1);
    expect(clanData.bossStatusByLap.get(44)?.[3]?.attackPlayers[0]?.memo).toBe("late-lap chip");
    expect(clanData.bossStatusByLap.get(44)?.[3]?.attackPlayers[0]?.damage).toBe(7_654_321);
    expect(runtimeStateService.getAttackEntries(clanData.categoryId)).toHaveLength(0);
    expect(runtimeStateService.getOperationLogs(clanData.categoryId)).toHaveLength(0);
    expect(runtimeStateService.getPlayerResourceStates(clanData.categoryId)).toHaveLength(0);

    expect(
      database
        .prepare<[], { count: bigint }>("select count(*) as count from AttackEntry")
        .get()?.count,
    ).toBe(0n);
    expect(
      database
        .prepare<[], { count: bigint }>("select count(*) as count from OperationLog")
        .get()?.count,
    ).toBe(0n);
    expect(
      database
        .prepare<[], { count: bigint }>("select count(*) as count from PlayerResourceState")
        .get()?.count,
    ).toBe(0n);
    expect(
      database
        .prepare<[], { count: bigint }>("select count(*) as count from ResourceAdjustmentLog")
        .get()?.count,
    ).toBe(0n);
    expect(
      database
        .prepare<[], { count: bigint }>("select count(*) as count from AttackStatus")
        .get()?.count,
    ).toBe(1n);

    closeSqliteDatabase(database);
    database = openSqliteDatabase({ filePath: tempPath.filePath });

    const restoredRuntimeStateService = new RuntimeStateService({
      database,
      clock: createFixedClock("2026-03-08T00:30:00.000Z"),
    });
    const restoredClanData = restoredRuntimeStateService.restoreFromDatabase().get(clanData.categoryId);
    expect(restoredClanData?.date).toBe("2026-03-08");
    expect(restoredClanData?.bossStatusByLap.get(44)?.[3]?.attackPlayers).toHaveLength(1);
    expect(restoredClanData?.bossStatusByLap.get(44)?.[3]?.attackPlayers[0]?.memo).toBe(
      "late-lap chip",
    );
    expect(restoredClanData?.bossStatusByLap.get(44)?.[3]?.attackPlayers[0]?.damage).toBe(
      7_654_321,
    );
    expect(restoredRuntimeStateService.getAttackEntries(clanData.categoryId)).toHaveLength(0);
    expect(restoredRuntimeStateService.getOperationLogs(clanData.categoryId)).toHaveLength(0);
    expect(restoredRuntimeStateService.getPlayerResourceStates(clanData.categoryId)).toHaveLength(
      0,
    );
  });

  it("fails restore when startup-blocking legacy schema cleanup is still required", () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createLegacyCoreSchema(database);

    const clanData = createClanData({
      remainAttackMessageId: "123456789012345680",
    });
    insertLegacyClanDataRow(database, clanData);

    database
      .prepare("insert into PlayerData values (?, ?, ?, ?, ?)")
      .run(encodeSnowflake(clanData.categoryId), 123456789012345679n, 1, 2, 0);
    database
      .prepare("insert into AttackStatus values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        encodeSnowflake(clanData.categoryId),
        123456789012345679n,
        2,
        1,
        9_876_543,
        "legacy magic",
        1,
        "MAGIC",
        0,
        formatSqliteDateTime(new Date("2026-03-07T02:34:56.000Z")),
      );
    database
      .prepare("insert into CarryOver values (?, ?, ?, ?, ?, ?)")
      .run(
        encodeSnowflake(clanData.categoryId),
        123456789012345679n,
        3,
        "MAGIC",
        45,
        formatSqliteDateTime(new Date("2026-03-07T01:23:45.000Z")),
      );
    database
      .prepare("insert into ReserveData values (?, ?, ?, ?, ?, ?, ?)")
      .run(encodeSnowflake(clanData.categoryId), 0, 123456789012345679n, "CARRYOVER", 123_456, "legacy", 1);

    const runtimeStateService = new RuntimeStateService({
      database,
      clock: createFixedClock("2026-03-07T03:00:00.000Z"),
    });
    expect(() => runtimeStateService.restoreFromDatabase()).toThrowError(
      StartupBlockingLegacyShapeError,
    );
    expect(() => runtimeStateService.restoreFromDatabase()).toThrowError(/ReserveData table exists/);
    const playerColumns = database
      .prepare<[], { name: string }>("select name from pragma_table_info('PlayerData') order by cid")
      .all()
      .map((row) => row.name);
    const attackStatusRow = database
      .prepare<[], { attack_type: string }>(
        "select attack_type from AttackStatus where category_id = 223456789012345678 and user_id = 123456789012345679",
      )
      .get();
    const carryOverRow = database
      .prepare<[], { attack_type: string }>(
        "select attack_type from CarryOver where category_id = 223456789012345678 and user_id = 123456789012345679",
      )
      .get();
    const carryOverColumns = database
      .prepare<[], { name: string }>("select name from pragma_table_info('CarryOver') order by cid")
      .all()
      .map((row) => row.name);
    const reserveTable = database
      .prepare<[], { count: bigint }>(
        "select count(*) as count from sqlite_master where type='table' and name='ReserveData'",
      )
      .get();
    const clanColumns = database
      .prepare<[], { name: string }>("select name from pragma_table_info('ClanData') order by cid")
      .all()
      .map((row) => row.name);
    const uniqueIndexNames = database
      .prepare<[], { name: string }>(
        "select name from sqlite_master where type='index' and name not like 'sqlite_autoindex_%' order by name",
      )
      .all()
      .map((row) => row.name);

    expect(playerColumns).not.toContain("battle_attack_count");
    expect(attackStatusRow?.attack_type).toBe("MAGIC");
    expect(carryOverRow?.attack_type).toBe("MAGIC");
    expect(carryOverColumns).toContain("carry_over_time");
    expect(reserveTable?.count).toBe(1n);
    expect(clanColumns).toContain("reserve_channel_id");
    expect(clanColumns).toContain("boss1_reserve_message_id");
    expect(uniqueIndexNames).not.toContain("idx_clan_data_category_id");
  });

  it("fails restore when future constraint targets already contain duplicate rows", () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createLegacyCoreSchema(database);

    database
      .prepare("insert into ClanData values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        100n,
        200n,
        301n,
        302n,
        303n,
        304n,
        305n,
        306n,
        null,
        307n,
        null,
        null,
        null,
        null,
        null,
        null,
        308n,
        "2026-03-07",
      );
    database
      .prepare("insert into ClanData values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        101n,
        200n,
        401n,
        402n,
        403n,
        404n,
        405n,
        406n,
        null,
        407n,
        null,
        null,
        null,
        null,
        null,
        null,
        408n,
        "2026-03-08",
      );

    const runtimeStateService = new RuntimeStateService({ database });

    expect(() => runtimeStateService.restoreFromDatabase()).toThrowError(
      StartupBlockingLegacyShapeError,
    );
    expect(() => runtimeStateService.restoreFromDatabase()).toThrowError(
      /idx_clan_data_category_id/,
    );
  });

  it("serializes updates for the same category id", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const entered = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    const timeline: string[] = [];

    const first = runtimeStateService.withCategoryLock("cat-1", async () => {
      timeline.push("first:start");
      entered.resolve();
      await releaseFirst.promise;
      timeline.push("first:end");
    });

    await entered.promise;

    const second = runtimeStateService.withCategoryLock("cat-1", async () => {
      timeline.push("second:start");
      timeline.push("second:end");
    });

    await expect(
      Promise.race([
        second.then(() => "done"),
        delay(25).then(() => "timeout"),
      ]),
    ).resolves.toBe("timeout");

    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(timeline).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("allows different category ids to proceed independently", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const entered = createDeferred<void>();
    const releaseFirst = createDeferred<void>();

    const first = runtimeStateService.withCategoryLock("cat-1", async () => {
      entered.resolve();
      await releaseFirst.promise;
    });

    await entered.promise;

    const second = runtimeStateService.withCategoryLock("cat-2", async () => "done");

    await expect(
      Promise.race([
        second,
        delay(25).then(() => "timeout"),
      ]),
    ).resolves.toBe("done");

    releaseFirst.resolve();
    await first;
  });

  it("persists the JST 5:00 day reset and pending-declaration cleanup across restore", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const clanRepository = new ClanRepository(database);
    const playerRepository = new PlayerRepository(database);
    const bossStatusRepository = new BossStatusRepository(database);
    const attackStatusRepository = new AttackStatusRepository(database);
    const carryOverRepository = new CarryOverRepository(database);
    const runtimeStateService = new RuntimeStateService({
      database,
      clock: createFixedClock("2026-03-08T00:30:00.000Z"),
    });

    const playerData = new PlayerData({
      userId: "123456789012345679",
      physicsAttack: 2,
      magicAttack: 1,
      carryOverList: [
        new CarryOver({
          attackType: AttackType.BATTLE,
          bossIndex: 1,
          created: new Date("2026-03-07T12:34:56.000Z"),
        }),
      ],
      taskKill: true,
    });

    const clanData = createClanData({
      date: "2026-03-07",
      playerDataMap: new Map([[playerData.userId, playerData]]),
      progressMessageIdsByLap: new Map([[9, ["123456789012345684", null, null, null, null]]]),
      summaryMessageIdsByLap: new Map([[9, ["123456789012345685", null, null, null, null]]]),
    });
    clanData.initializeBossStatusData(9);

    const pendingAttackStatus = new AttackStatus({
      playerData,
      attackType: AttackType.BATTLE,
      carryOver: false,
      attacked: false,
      damage: 123_456,
      memo: "pending",
      created: new Date("2026-03-07T02:34:56.000Z"),
    });
    const resolvedAttackStatus = new AttackStatus({
      playerData,
      attackType: AttackType.BATTLE,
      carryOver: false,
      attacked: true,
      damage: 654_321,
      memo: "resolved",
      created: new Date("2026-03-07T03:45:00.000Z"),
    });
    clanData.bossStatusByLap.get(9)![0]!.attackPlayers.push(pendingAttackStatus, resolvedAttackStatus);

    clanRepository.insert(clanData);
    playerRepository.insertMany(clanData.categoryId, [playerData]);
    playerRepository.update(clanData.categoryId, playerData);
    bossStatusRepository.insertAllForLap(clanData.categoryId, clanData.bossStatusByLap.get(9)!);
    attackStatusRepository.insert(clanData.categoryId, 9, 0, pendingAttackStatus);
    attackStatusRepository.insert(clanData.categoryId, 9, 0, resolvedAttackStatus);
    carryOverRepository.replaceAll(clanData.categoryId, playerData.userId, playerData.carryOverList);
    insertMessageIdRow(database, "ProgressMessageIdData", clanData.categoryId, 9, [
      "123456789012345684",
      null,
      null,
      null,
      null,
    ]);
    insertMessageIdRow(database, "SummaryMessageIdData", clanData.categoryId, 9, [
      "123456789012345685",
      null,
      null,
      null,
      null,
    ]);

    runtimeStateService.set(clanData);

    const result = await runtimeStateService.ensureDateUpToDate(clanData.categoryId);
    const attackRows = database
      .prepare<[], { count: bigint; attacked_count: bigint }>(
        "select count(*) as count, sum(case when attacked = 1 then 1 else 0 end) as attacked_count from AttackStatus",
      )
      .get();
    const carryOverRows = database
      .prepare<[], { count: bigint }>("select count(*) as count from CarryOver")
      .get();
    const playerRow = database
      .prepare<[], { physics_attack: bigint; magic_attack: bigint; task_kill: bigint }>(
        "select physics_attack, magic_attack, task_kill from PlayerData where category_id = 223456789012345678 and user_id = 123456789012345679",
      )
      .get();
    const clanRow = database
      .prepare<[], { day: string }>("select day from ClanData where category_id = 223456789012345678")
      .get();

    expect(result).toEqual({
      changed: true,
      previousDayKey: "2026-03-07",
      currentDayKey: "2026-03-08",
      shouldCreateRemainAttackMessage: true,
    });
    expect(clanData.date).toBe("2026-03-08");
    expect(clanData.remainAttackMessageId).toBeNull();
    expect(playerData.physicsAttack).toBe(0);
    expect(playerData.magicAttack).toBe(0);
    expect(playerData.carryOverList).toHaveLength(0);
    expect(playerData.taskKill).toBe(false);
    expect(clanData.bossStatusByLap.get(9)?.[0]?.attackPlayers).toHaveLength(1);
    expect(clanData.bossStatusByLap.get(9)?.[0]?.attackPlayers[0]?.memo).toBe("resolved");
    expect(clanData.progressMessageIdsByLap.get(9)?.[0]).toBe("123456789012345684");
    expect(clanData.summaryMessageIdsByLap.size).toBe(0);
    expect(attackRows).toEqual({
      count: 1n,
      attacked_count: 1n,
    });
    expect(carryOverRows?.count).toBe(0n);
    expect(playerRow).toEqual({
      physics_attack: 0n,
      magic_attack: 0n,
      task_kill: 0n,
    });
    expect(clanRow?.day).toBe("2026-03-08");

    closeSqliteDatabase(database);
    database = openSqliteDatabase({ filePath: tempPath.filePath });

    const restoredRuntimeStateService = new RuntimeStateService({
      database,
      clock: createFixedClock("2026-03-08T00:30:00.000Z"),
    });
    const restoredClanData = restoredRuntimeStateService.restoreFromDatabase().get(clanData.categoryId);
    const restoredPlayerData = restoredClanData?.getPlayerData(playerData.userId);

    expect(restoredClanData?.date).toBe("2026-03-08");
    expect(restoredPlayerData?.physicsAttack).toBe(0);
    expect(restoredPlayerData?.magicAttack).toBe(0);
    expect(restoredPlayerData?.taskKill).toBe(false);
    expect(restoredPlayerData?.carryOverList).toHaveLength(0);
    expect(restoredClanData?.bossStatusByLap.get(9)?.[0]?.attackPlayers).toHaveLength(1);
    expect(restoredClanData?.bossStatusByLap.get(9)?.[0]?.attackPlayers[0]?.memo).toBe("resolved");
    expect(restoredClanData?.progressMessageIdsByLap.get(9)?.[0]).toBe("123456789012345684");
    expect(restoredClanData?.summaryMessageIdsByLap.size).toBe(0);
  });
});
