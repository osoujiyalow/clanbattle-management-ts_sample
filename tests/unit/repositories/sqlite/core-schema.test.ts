import { afterEach, describe, expect, it } from "vitest";

import { AttackType } from "../../../../src/domain/attack-type.js";
import {
  CONSTRAINT_PREFLIGHT_TARGETS,
  StartupBlockingLegacyShapeError,
  ensureCoreSchema,
  inspectConstraintPreflight,
} from "../../../../src/repositories/sqlite/core-schema.js";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
  type SqliteDatabase,
} from "../../../../src/repositories/sqlite/db.js";
import { createTempSqlitePath, type TempSqlitePath } from "./test-sqlite-path.js";

describe("ensureCoreSchema", () => {
  let tempPath: TempSqlitePath | undefined;
  let database: SqliteDatabase | undefined;

  afterEach(() => {
    if (database) {
      closeSqliteDatabase(database);
      database = undefined;
    }

    tempPath?.cleanup();
    tempPath = undefined;
  });

  function createFutureConstraintTargetTablesWithoutIndexes(database: SqliteDatabase): void {
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
        command_channel_id int,
        remain_attack_message_id int,
        summary_channel_id int,
        day date
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
    `);
  }

  it("creates the runtime tables for an empty sqlite file", () => {
    tempPath = createTempSqlitePath("cb-core-schema-");
    database = openSqliteDatabase({ filePath: tempPath.filePath });

    ensureCoreSchema(database);

    const tableNames = database
      .prepare<[], { name: string }>(
        "select name from sqlite_master where type='table' order by name",
      )
      .all()
      .map((row) => row.name);

    expect(tableNames).toEqual([
      "AttackEntry",
      "AttackStatus",
      "BossStatusData",
      "CarryOver",
      "ClanData",
      "GuildBossInfoConfig",
      "OperationLog",
      "PlayerData",
      "PlayerResourceState",
      "ProgressMessageIdData",
      "ResourceAdjustmentLog",
      "SummaryMessageIdData",
    ]);

    const playerColumns = database
      .prepare<[], { name: string }>("select name from pragma_table_info('PlayerData') order by cid")
      .all()
      .map((row) => row.name);
    const carryOverColumns = database
      .prepare<[], { name: string }>("select name from pragma_table_info('CarryOver') order by cid")
      .all()
      .map((row) => row.name);
    const attackEntryColumns = database
      .prepare<[], { name: string }>("select name from pragma_table_info('AttackEntry') order by cid")
      .all()
      .map((row) => row.name);
    const playerResourceStateColumns = database
      .prepare<[], { name: string }>(
        "select name from pragma_table_info('PlayerResourceState') order by cid",
      )
      .all()
      .map((row) => row.name);
    const operationLogColumns = database
      .prepare<[], { name: string }>("select name from pragma_table_info('OperationLog') order by cid")
      .all()
      .map((row) => row.name);
    const resourceAdjustmentColumns = database
      .prepare<[], { name: string }>(
        "select name from pragma_table_info('ResourceAdjustmentLog') order by cid",
      )
      .all()
      .map((row) => row.name);
    const uniqueIndexNames = database
      .prepare<[], { name: string }>(
        "select name from sqlite_master where type='index' and name not like 'sqlite_autoindex_%' order by name",
      )
      .all()
      .map((row) => row.name);

    expect(playerColumns).toEqual([
      "category_id",
      "user_id",
      "physics_attack",
      "magic_attack",
      "battle_attack_count",
      "task_kill",
    ]);
    expect(carryOverColumns).toEqual([
      "category_id",
      "user_id",
      "boss_index",
      "attack_type",
      "created",
    ]);
    expect(attackEntryColumns).toEqual([
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
    expect(playerResourceStateColumns).toEqual([
      "category_id",
      "user_id",
      "day_key",
      "battle_reserved_count",
      "battle_consumed_count",
      "carry_available_count",
      "carry_reserved_count",
    ]);
    expect(operationLogColumns).toEqual([
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
    expect(resourceAdjustmentColumns).toEqual([
      "adjustment_id",
      "category_id",
      "user_id",
      "actor_user_id",
      "day_key",
      "resource_type",
      "remaining",
      "occurred_at",
    ]);
    expect(uniqueIndexNames).toEqual(
      expect.arrayContaining([
        "idx_clan_data_category_id",
        "idx_boss_status_data_category_lap_boss",
        "idx_attack_status_category_user_lap_boss_created",
        "idx_progress_message_id_data_category_lap",
        "idx_summary_message_id_data_category_lap",
      ]),
    );
  });

  it("fails fast when PlayerData still needs startup-time legacy cleanup", () => {
    tempPath = createTempSqlitePath("cb-core-schema-dedupe-");
    database = openSqliteDatabase({ filePath: tempPath.filePath });

    database.exec(`
      create table PlayerData (
        category_id int,
        user_id int,
        physics_attack int default 0,
        magic_attack int default 0,
        task_kill boolean
      );
    `);
    database.prepare("insert into PlayerData values (?, ?, ?, ?, ?)").run(200n, 300n, 1, 0, 0);
    database.prepare("insert into PlayerData values (?, ?, ?, ?, ?)").run(200n, 300n, 0, 2, 1);

    expect(() => ensureCoreSchema(database)).toThrowError(StartupBlockingLegacyShapeError);
    expect(() => ensureCoreSchema(database)).toThrowError(/battle_attack_count/i);
    expect(() => ensureCoreSchema(database)).toThrowError(/duplicateRows/i);
  });

  it("deduplicates legacy PlayerData rows in explicit repair mode and creates a unique index", () => {
    tempPath = createTempSqlitePath("cb-core-schema-dedupe-repair-");
    database = openSqliteDatabase({ filePath: tempPath.filePath });

    database.exec(`
      create table PlayerData (
        category_id int,
        user_id int,
        physics_attack int default 0,
        magic_attack int default 0,
        task_kill boolean
      );
    `);
    database.prepare("insert into PlayerData values (?, ?, ?, ?, ?)").run(200n, 300n, 1, 0, 0);
    database.prepare("insert into PlayerData values (?, ?, ?, ?, ?)").run(200n, 300n, 0, 2, 1);

    ensureCoreSchema(database, { legacyShapeHandling: "repair" });
    ensureCoreSchema(database);

    const playerRows = database
      .prepare<
        [],
        {
          count: bigint;
          physics_attack: bigint;
          magic_attack: bigint;
          battle_attack_count: bigint;
          task_kill: bigint;
        }
      >(
        "select count(*) as count, max(physics_attack) as physics_attack, max(magic_attack) as magic_attack, max(battle_attack_count) as battle_attack_count, max(task_kill) as task_kill from PlayerData where category_id=200 and user_id=300",
      )
      .get();
    const indexNames = database
      .prepare<[], { name: string }>("select name from sqlite_master where type='index' and tbl_name='PlayerData' order by name")
      .all()
      .map((row) => row.name);
    const resourceStateIndexNames = database
      .prepare<[], { name: string }>(
        "select name from sqlite_master where type='index' and tbl_name='PlayerResourceState' order by name",
      )
      .all()
      .map((row) => row.name);

    expect(playerRows).toEqual({
      count: 1n,
      physics_attack: 1n,
      magic_attack: 2n,
      battle_attack_count: 3n,
      task_kill: 1n,
    });
    expect(indexNames).toContain("idx_player_data_category_user");
    expect(resourceStateIndexNames).toContain("idx_player_resource_state_category_user_day");
  });

  it("fails fast when legacy reserve/carry-over cleanup is still required", () => {
    tempPath = createTempSqlitePath("cb-core-schema-attack-type-");
    database = openSqliteDatabase({ filePath: tempPath.filePath });

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

      create table CarryOver (
        category_id int,
        user_id int,
        boss_index int,
        attack_type varchar,
        carry_over_time int,
        created datetime
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
    `);

    database
      .prepare("insert into AttackStatus values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        200n,
        300n,
        1,
        0,
        1_234_567,
        "magic",
        1,
        "MAGIC",
        0,
        "2026-03-07 11:34:56.000000+09:00",
      );
    database
      .prepare("insert into CarryOver values (?, ?, ?, ?, ?, ?)")
      .run(200n, 300n, 0, "PHYSICS", 45, "2026-03-07 10:23:45.000000+09:00");
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
        999n,
        307n,
        401n,
        402n,
        403n,
        404n,
        405n,
        406n,
        308n,
        "2026-03-07",
      );
    database
      .prepare("insert into ReserveData values (?, ?, ?, ?, ?, ?, ?)")
      .run(200n, 0, 300n, "CARRYOVER", 765_432, "carry", 1);

    expect(() => ensureCoreSchema(database)).toThrowError(StartupBlockingLegacyShapeError);
    expect(() => ensureCoreSchema(database)).toThrowError(/ReserveData table exists/);
    expect(() => ensureCoreSchema(database)).toThrowError(/carry_over_time/i);

    const reserveTable = database
      .prepare<[], { count: bigint }>(
        "select count(*) as count from sqlite_master where type='table' and name='ReserveData'",
      )
      .get();
    const carryOverColumns = database
      .prepare<[], { name: string }>("select name from pragma_table_info('CarryOver') order by cid")
      .all()
      .map((row) => row.name);

    expect(reserveTable?.count).toBe(1n);
    expect(carryOverColumns).toContain("carry_over_time");
  });

  it("repairs ReserveData and rebuilds ClanData/CarryOver in explicit repair mode without silently rewriting legacy attack_type values", () => {
    tempPath = createTempSqlitePath("cb-core-schema-attack-type-repair-");
    database = openSqliteDatabase({ filePath: tempPath.filePath });

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

      create table CarryOver (
        category_id int,
        user_id int,
        boss_index int,
        attack_type varchar,
        carry_over_time int,
        created datetime
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
    `);

    database
      .prepare("insert into AttackStatus values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        200n,
        300n,
        1,
        0,
        1_234_567,
        "magic",
        1,
        "MAGIC",
        0,
        "2026-03-07 11:34:56.000000+09:00",
      );
    database
      .prepare("insert into CarryOver values (?, ?, ?, ?, ?, ?)")
      .run(200n, 300n, 0, "PHYSICS", 45, "2026-03-07 10:23:45.000000+09:00");
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
        999n,
        307n,
        401n,
        402n,
        403n,
        404n,
        405n,
        406n,
        308n,
        "2026-03-07",
      );
    database
      .prepare("insert into ReserveData values (?, ?, ?, ?, ?, ?, ?)")
      .run(200n, 0, 300n, "CARRYOVER", 765_432, "carry", 1);

    ensureCoreSchema(database, { legacyShapeHandling: "repair" });

    const attackStatusRow = database
      .prepare<[], { attack_type: string }>("select attack_type from AttackStatus")
      .get();
    const carryOverRow = database
      .prepare<[], { attack_type: string }>("select attack_type from CarryOver")
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

    expect(attackStatusRow?.attack_type).toBe("MAGIC");
    expect(carryOverRow?.attack_type).toBe("PHYSICS");
    expect(carryOverColumns).toEqual([
      "category_id",
      "user_id",
      "boss_index",
      "attack_type",
      "created",
    ]);
    expect(reserveTable?.count).toBe(0n);
    expect(clanColumns).not.toContain("reserve_channel_id");
    expect(clanColumns).not.toContain("boss1_reserve_message_id");
  });

  it("publishes the planned constraint-preflight targets for future single-row tables", () => {
    expect(CONSTRAINT_PREFLIGHT_TARGETS).toEqual([
      {
        tableName: "ClanData",
        plannedIndexName: "idx_clan_data_category_id",
        columns: ["category_id"],
      },
      {
        tableName: "BossStatusData",
        plannedIndexName: "idx_boss_status_data_category_lap_boss",
        columns: ["category_id", "lap", "boss_index"],
      },
      {
        tableName: "AttackStatus",
        plannedIndexName: "idx_attack_status_category_user_lap_boss_created",
        columns: ["category_id", "user_id", "lap", "boss_index", "created"],
      },
      {
        tableName: "ProgressMessageIdData",
        plannedIndexName: "idx_progress_message_id_data_category_lap",
        columns: ["category_id", "lap"],
      },
      {
        tableName: "SummaryMessageIdData",
        plannedIndexName: "idx_summary_message_id_data_category_lap",
        columns: ["category_id", "lap"],
      },
    ]);
  });

  it("detects duplicate groups for future constraint targets without applying constraints yet", () => {
    tempPath = createTempSqlitePath("cb-core-schema-constraint-preflight-");
    database = openSqliteDatabase({ filePath: tempPath.filePath });

    createFutureConstraintTargetTablesWithoutIndexes(database);

    database
      .prepare("insert into ClanData values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(100n, 200n, 301n, 302n, 303n, 304n, 305n, 306n, 307n, null, 308n, "2026-03-07");
    database
      .prepare("insert into ClanData values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(101n, 200n, 401n, 402n, 403n, 404n, 405n, 406n, 407n, null, 408n, "2026-03-08");

    database
      .prepare("insert into BossStatusData values (?, ?, ?, ?)")
      .run(200n, 0, 7, 0);
    database
      .prepare("insert into BossStatusData values (?, ?, ?, ?)")
      .run(200n, 0, 7, 1);

    database
      .prepare("insert into AttackStatus values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(200n, 300n, 7, 0, 123_456, "first", 0, AttackType.BATTLE, 0, "2026-03-07 12:34:56.000000+09:00");
    database
      .prepare("insert into AttackStatus values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(200n, 300n, 7, 0, 654_321, "second", 1, AttackType.CARRYOVER, 1, "2026-03-07 12:34:56.000000+09:00");

    database
      .prepare("insert into ProgressMessageIdData values (?, ?, ?, ?, ?, ?, ?)")
      .run(200n, 7, 11n, null, null, null, null);
    database
      .prepare("insert into ProgressMessageIdData values (?, ?, ?, ?, ?, ?, ?)")
      .run(200n, 7, 22n, null, null, null, null);

    database
      .prepare("insert into SummaryMessageIdData values (?, ?, ?, ?, ?, ?, ?)")
      .run(200n, 7, 33n, null, null, null, null);
    database
      .prepare("insert into SummaryMessageIdData values (?, ?, ?, ?, ?, ?, ?)")
      .run(200n, 7, 44n, null, null, null, null);

    const inspection = inspectConstraintPreflight(database);
    const clanTarget = inspection.targets.find((target) => target.tableName === "ClanData");
    const bossStatusTarget = inspection.targets.find((target) => target.tableName === "BossStatusData");
    const attackStatusTarget = inspection.targets.find((target) => target.tableName === "AttackStatus");
    const progressTarget = inspection.targets.find((target) => target.tableName === "ProgressMessageIdData");
    const summaryTarget = inspection.targets.find((target) => target.tableName === "SummaryMessageIdData");

    expect(inspection.ready).toBe(false);
    expect(clanTarget).toMatchObject({
      duplicateGroupCount: 1,
      duplicateGroups: [{ rowCount: 2, key: { category_id: "200" } }],
    });
    expect(bossStatusTarget).toMatchObject({
      duplicateGroupCount: 1,
      duplicateGroups: [{ rowCount: 2, key: { category_id: "200", lap: "7", boss_index: "0" } }],
    });
    expect(attackStatusTarget).toMatchObject({
      duplicateGroupCount: 1,
      duplicateGroups: [
        {
          rowCount: 2,
          key: {
            category_id: "200",
            user_id: "300",
            lap: "7",
            boss_index: "0",
            created: "2026-03-07 12:34:56.000000+09:00",
          },
        },
      ],
    });
    expect(progressTarget).toMatchObject({
      duplicateGroupCount: 1,
      duplicateGroups: [{ rowCount: 2, key: { category_id: "200", lap: "7" } }],
    });
    expect(summaryTarget).toMatchObject({
      duplicateGroupCount: 1,
      duplicateGroups: [{ rowCount: 2, key: { category_id: "200", lap: "7" } }],
    });
  });

  it("fails fast when future constraint targets contain duplicates", () => {
    tempPath = createTempSqlitePath("cb-core-schema-constraint-stop-");
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createFutureConstraintTargetTablesWithoutIndexes(database);

    database
      .prepare("insert into ClanData values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(100n, 200n, 301n, 302n, 303n, 304n, 305n, 306n, 307n, null, 308n, "2026-03-07");
    database
      .prepare("insert into ClanData values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(101n, 200n, 401n, 402n, 403n, 404n, 405n, 406n, 407n, null, 408n, "2026-03-08");

    expect(() => ensureCoreSchema(database)).toThrowError(StartupBlockingLegacyShapeError);
    expect(() => ensureCoreSchema(database)).toThrowError(/idx_clan_data_category_id/);
  });
});
