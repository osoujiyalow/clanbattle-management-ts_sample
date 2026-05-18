import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AttackType } from "../../../src/domain/attack-type.js";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
  type SqliteDatabase,
} from "../../../src/repositories/sqlite/db.js";
import { encodeSnowflake } from "../../../src/repositories/sqlite/sqlite-codec.js";
import { formatSqliteDateTime } from "../../../src/repositories/sqlite/sqlite-time.js";
import { runStagingMigrationRehearsal } from "../../../src/tools/staging-migration-rehearsal.js";
import { createTempSqlitePath, type TempSqlitePath } from "../../unit/repositories/sqlite/test-sqlite-path.js";

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

function seedLegacyDatabase(database: SqliteDatabase): void {
  const guildId = "123456789012345678";
  const categoryId = "223456789012345678";
  const userId = "323456789012345678";

  database
    .prepare("insert into ClanData values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      encodeSnowflake(guildId),
      encodeSnowflake(categoryId),
      encodeSnowflake("423456789012345678"),
      encodeSnowflake("523456789012345678"),
      encodeSnowflake("623456789012345678"),
      encodeSnowflake("723456789012345678"),
      encodeSnowflake("823456789012345678"),
      encodeSnowflake("923456789012345678"),
      999n,
      encodeSnowflake("103456789012345678"),
      401n,
      null,
      null,
      null,
      null,
      encodeSnowflake("113456789012345678"),
      encodeSnowflake("123456789012345678"),
      "2026-03-07",
    );

  database
    .prepare("insert into PlayerData values (?, ?, ?, ?, ?)")
    .run(encodeSnowflake(categoryId), encodeSnowflake(userId), 1, 2, 0);

  database
    .prepare("insert into BossStatusData values (?, ?, ?, ?)")
    .run(encodeSnowflake(categoryId), 0, 1, 0);

  database
    .prepare("insert into AttackStatus values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      encodeSnowflake(categoryId),
      encodeSnowflake(userId),
      1,
      0,
      123_456,
      "legacy magic",
      0,
      "MAGIC",
      0,
      formatSqliteDateTime(new Date("2026-03-07T02:34:56.000Z")),
    );

  database
    .prepare("insert into CarryOver values (?, ?, ?, ?, ?, ?)")
    .run(
      encodeSnowflake(categoryId),
      encodeSnowflake(userId),
      0,
      "CARRYOVER",
      45,
      formatSqliteDateTime(new Date("2026-03-07T01:23:45.000Z")),
    );

  database
    .prepare("insert into ReserveData values (?, ?, ?, ?, ?, ?, ?)")
    .run(encodeSnowflake(categoryId), 0, encodeSnowflake(userId), "MAGIC", 654_321, "reserve", 0);
}

describe("staging migration rehearsal", () => {
  let sourcePath: TempSqlitePath | undefined;
  let outputDir: string | undefined;

  afterEach(() => {
    sourcePath?.cleanup();
    sourcePath = undefined;

    if (outputDir) {
      fs.rmSync(outputDir, { recursive: true, force: true });
      outputDir = undefined;
    }
  });

  it("migrates a copied working database, keeps the source intact, and writes a passing report", async () => {
    sourcePath = createTempSqlitePath("cb-rehearsal-source-");
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-rehearsal-output-"));

    const sourceDatabase = openSqliteDatabase({ filePath: sourcePath.filePath });
    createLegacyCoreSchema(sourceDatabase);
    seedLegacyDatabase(sourceDatabase);
    closeSqliteDatabase(sourceDatabase);

    const report = await runStagingMigrationRehearsal({
      sourcePath: sourcePath.filePath,
      outputDir,
    });

    expect(report.ok).toBe(true);
    expect(report.summary).toEqual({
      sourceHadStartupBlockingLegacyShape: true,
      sourceHadLegacyReserveArtifacts: true,
      sourceHadLegacyCarryOverTimeColumn: true,
      sourceHadLegacyAttackTypeAliases: true,
      sourceNeededBattleAttackBackfill: true,
      sourceHadConstraintTargetDuplicates: false,
      sourceHadHiddenStateRows: false,
      sourceNeededProjectedStateBackfill: true,
    });
    expect(report.before.startupBlockingLegacyShape.ready).toBe(false);
    expect(report.after.startupBlockingLegacyShape.ready).toBe(true);
    expect(report.sourceAfter.startupBlockingLegacyShape.ready).toBe(false);
    expect(report.after.legacyReserve.reserveTableExists).toBe(false);
    expect(report.after.legacyReserve.clanDataReserveColumns).toEqual([]);
    expect(report.after.tables.CarryOver.columns).toEqual([
      "category_id",
      "user_id",
      "boss_index",
      "attack_type",
      "created",
    ]);
    expect(report.after.hiddenState.attackEntry.columns).toEqual([
      "attack_entry_id",
      "category_id",
      "user_id",
      "day_key",
      "lap",
      "boss_index",
      "kind",
      "status",
      "declared_at",
      "resolved_at",
      "damage",
      "memo",
    ]);
    expect(report.after.hiddenState.playerResourceState.columns).toEqual([
      "category_id",
      "user_id",
      "day_key",
      "battle_reserved_count",
      "battle_consumed_count",
      "carry_available_count",
      "carry_reserved_count",
    ]);
    expect(report.after.hiddenState.operationLog.columns).toEqual([
      "operation_id",
      "category_id",
      "user_id",
      "day_key",
      "lap",
      "boss_index",
      "target_attack_entry_id",
      "operation_type",
      "before_kind",
      "after_kind",
      "before_status",
      "after_status",
      "occurred_at",
      "invalidated_at",
    ]);
    expect(report.after.hiddenState.attackEntry.rowCount).toBe(0);
    expect(report.after.hiddenState.playerResourceState.rowCount).toBe(0);
    expect(report.after.hiddenState.operationLog.rowCount).toBe(0);
    expect(report.after.playerData.hasBattleAttackCount).toBe(true);
    expect(report.after.playerData.battleMismatchCount).toBe(0);
    expect(report.after.legacyAttackTypeAliases).toEqual({
      attackStatus: [],
      carryOver: [],
    });
    expect(report.after.constraintPreflight.ready).toBe(true);
    expect(
      report.after.constraintPreflight.targets.map((target) => ({
        tableName: target.tableName,
        plannedIndexName: target.plannedIndexName,
        columns: target.columns,
        duplicateGroupCount: target.duplicateGroupCount,
      })),
    ).toEqual([
      {
        tableName: "ClanData",
        plannedIndexName: "idx_clan_data_category_id",
        columns: ["category_id"],
        duplicateGroupCount: 0,
      },
      {
        tableName: "BossStatusData",
        plannedIndexName: "idx_boss_status_data_category_lap_boss",
        columns: ["category_id", "lap", "boss_index"],
        duplicateGroupCount: 0,
      },
      {
        tableName: "AttackStatus",
        plannedIndexName: "idx_attack_status_category_user_lap_boss_created",
        columns: ["category_id", "user_id", "lap", "boss_index", "created"],
        duplicateGroupCount: 0,
      },
      {
        tableName: "ProgressMessageIdData",
        plannedIndexName: "idx_progress_message_id_data_category_lap",
        columns: ["category_id", "lap"],
        duplicateGroupCount: 0,
      },
      {
        tableName: "SummaryMessageIdData",
        plannedIndexName: "idx_summary_message_id_data_category_lap",
        columns: ["category_id", "lap"],
        duplicateGroupCount: 0,
      },
    ]);
    expect(report.after.tables.AttackStatus.attackTypes).toEqual([
      { attackType: AttackType.BATTLE, count: 1 },
    ]);
    expect(report.after.tables.CarryOver.attackTypes).toEqual([
      { attackType: AttackType.CARRYOVER, count: 1 },
    ]);
    expect(report.runtime.restored).toBe(true);
    expect(report.runtime.categoryCount).toBe(1);
    expect(report.runtime.projectedState).toEqual({
      attackEntryCount: 0,
      playerResourceStateCount: 0,
      operationLogCount: 0,
      attackEntryStatuses: [],
      operationTypes: [],
      samplePlayerResourceState: null,
    });
    expect(report.checks.every((check) => check.ok)).toBe(true);
    expect(report.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        "startup-blocking-legacy-shape-ready",
        "player-data-duplicate-rows-removed",
        "rehearsal-hidden-state-tables-present",
        "rehearsal-hidden-state-columns-ready",
        "rehearsal-runtime-projected-state-counts-match-db",
        "rehearsal-player-resource-counts-bounded",
        "constraint-preflight-ready",
      ]),
    );
    expect(fs.existsSync(report.backupPath)).toBe(true);
    expect(fs.existsSync(report.workingPath)).toBe(true);
    expect(fs.existsSync(report.reportPath)).toBe(true);

    const workingDatabase = openSqliteDatabase({
      filePath: report.workingPath,
      fileMustExist: true,
      readonly: true,
    });
    const workingIndexNames = workingDatabase
      .prepare<[], { name: string }>(
        "select name from sqlite_master where type='index' and name not like 'sqlite_autoindex_%' order by name",
      )
      .all()
      .map((row) => row.name);
    closeSqliteDatabase(workingDatabase);

    expect(workingIndexNames).toEqual(
      expect.arrayContaining([
        "idx_clan_data_category_id",
        "idx_boss_status_data_category_lap_boss",
        "idx_attack_status_category_user_lap_boss_created",
        "idx_progress_message_id_data_category_lap",
        "idx_summary_message_id_data_category_lap",
      ]),
    );

    const sourceDatabaseAfter = openSqliteDatabase({
      filePath: sourcePath.filePath,
      fileMustExist: true,
      readonly: true,
    });
    const reserveTable = sourceDatabaseAfter
      .prepare<[], { count: bigint }>(
        "select count(*) as count from sqlite_master where type='table' and name='ReserveData'",
      )
      .get();
    const clanColumns = sourceDatabaseAfter
      .prepare<[], { name: string }>("select name from pragma_table_info('ClanData') order by cid")
      .all()
      .map((row) => row.name);
    const sourceCarryOverColumns = sourceDatabaseAfter
      .prepare<[], { name: string }>("select name from pragma_table_info('CarryOver') order by cid")
      .all()
      .map((row) => row.name);
    closeSqliteDatabase(sourceDatabaseAfter);

    expect(reserveTable?.count).toBe(1n);
    expect(clanColumns).toContain("reserve_channel_id");
    expect(clanColumns).toContain("boss1_reserve_message_id");
    expect(sourceCarryOverColumns).toContain("carry_over_time");
  });

  it("fails rehearsal when future constraint targets already contain duplicate rows", async () => {
    sourcePath = createTempSqlitePath("cb-rehearsal-duplicate-source-");
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-rehearsal-duplicate-output-"));

    const sourceDatabase = openSqliteDatabase({ filePath: sourcePath.filePath });
    createLegacyCoreSchema(sourceDatabase);
    sourceDatabase
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
    sourceDatabase
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
    closeSqliteDatabase(sourceDatabase);

    const report = await runStagingMigrationRehearsal({
      sourcePath: sourcePath.filePath,
      outputDir,
    });

    expect(report.ok).toBe(false);
    expect(report.before.startupBlockingLegacyShape.ready).toBe(false);
    expect(report.after.startupBlockingLegacyShape.ready).toBe(false);
    expect(report.summary.sourceHadConstraintTargetDuplicates).toBe(true);
    expect(report.runtime.restored).toBe(false);
    expect(report.after.constraintPreflight.ready).toBe(false);
    expect(
      report.after.constraintPreflight.targets.find((target) => target.tableName === "ClanData"),
    ).toMatchObject({
      duplicateGroupCount: 1,
      duplicateGroups: [{ rowCount: 2, key: { category_id: "200" } }],
    });
    expect(report.runtime.error?.message).toMatch(/idx_clan_data_category_id/);
    expect(
      report.checks.find((check) => check.name === "startup-blocking-legacy-shape-ready"),
    ).toMatchObject({
      ok: false,
    });
    expect(report.checks.find((check) => check.name === "constraint-preflight-ready")).toMatchObject({
      ok: false,
    });
  });
});
