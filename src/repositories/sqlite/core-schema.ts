import { runInTransaction, type SqliteDatabase } from "./db.js";

const CORE_SCHEMA_SQL = `
create table if not exists ClanData (
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

create table if not exists PlayerData (
  category_id int,
  user_id int,
  physics_attack int default 0,
  magic_attack int default 0,
  battle_attack_count int default 0,
  task_kill boolean
);

create table if not exists AttackStatus (
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

create table if not exists BossStatusData (
  category_id int,
  boss_index int,
  lap int,
  beated boolean
);

create table if not exists CarryOver (
  category_id int,
  user_id int,
  boss_index int,
  attack_type varchar,
  created datetime
);

create table if not exists AttackEntry (
  attack_entry_id varchar,
  category_id int,
  user_id int,
  day_key date,
  lap int,
  boss_index int,
  kind varchar,
  status varchar,
  declared_at datetime,
  resolved_at datetime,
  damage int,
  memo varchar
);

create table if not exists PlayerResourceState (
  category_id int,
  user_id int,
  day_key date,
  battle_reserved_count int default 0,
  battle_consumed_count int default 0,
  carry_available_count int default 0,
  carry_reserved_count int default 0
);

create table if not exists OperationLog (
  operation_id varchar,
  category_id int,
  user_id int,
  day_key date,
  lap int,
  boss_index int,
  target_attack_entry_id varchar,
  operation_type varchar,
  before_kind varchar,
  after_kind varchar,
  before_status varchar,
  after_status varchar,
  occurred_at datetime,
  invalidated_at datetime
);

create table if not exists ResourceAdjustmentLog (
  adjustment_id varchar,
  category_id int,
  user_id int,
  actor_user_id int,
  day_key date,
  resource_type varchar,
  remaining int,
  occurred_at datetime
);

create table if not exists ProgressMessageIdData (
  category_id int,
  lap int,
  boss1 int,
  boss2 int,
  boss3 int,
  boss4 int,
  boss5 int
);

create table if not exists SummaryMessageIdData (
  category_id int,
  lap int,
  boss1 int,
  boss2 int,
  boss3 int,
  boss4 int,
  boss5 int
);

create table if not exists GuildBossInfoConfig (
  guild_id int primary key,
  hp_json text not null,
  boundaries_json text not null,
  updated_by int,
  updated_at datetime default current_timestamp
);
`;

const CREATE_RUNTIME_INDEX_SQL = `
create unique index if not exists idx_player_data_category_user
on PlayerData (category_id, user_id);

create unique index if not exists idx_attack_entry_attack_entry_id
on AttackEntry (attack_entry_id);

create index if not exists idx_attack_entry_category_user_day_declared
on AttackEntry (category_id, user_id, day_key, declared_at);

create unique index if not exists idx_player_resource_state_category_user_day
on PlayerResourceState (category_id, user_id, day_key);

create unique index if not exists idx_operation_log_operation_id
on OperationLog (operation_id);

create index if not exists idx_operation_log_category_user_day_boss_occurred
on OperationLog (category_id, user_id, day_key, boss_index, occurred_at);

create unique index if not exists idx_resource_adjustment_log_adjustment_id
on ResourceAdjustmentLog (adjustment_id);

create index if not exists idx_resource_adjustment_log_category_user_day_type_occurred
on ResourceAdjustmentLog (category_id, user_id, day_key, resource_type, occurred_at);
`;

export interface ConstraintPreflightTarget {
  readonly tableName:
    | "ClanData"
    | "BossStatusData"
    | "AttackStatus"
    | "ProgressMessageIdData"
    | "SummaryMessageIdData";
  readonly plannedIndexName: string;
  readonly columns: readonly string[];
}

export interface ConstraintPreflightDuplicateGroup {
  readonly rowCount: number;
  readonly key: Readonly<Record<string, string | null>>;
}

export interface ConstraintPreflightTargetInspection extends ConstraintPreflightTarget {
  readonly duplicateGroupCount: number;
  readonly duplicateGroups: readonly ConstraintPreflightDuplicateGroup[];
}

export interface ConstraintPreflightInspection {
  readonly ready: boolean;
  readonly targets: readonly ConstraintPreflightTargetInspection[];
}

export interface StartupBlockingLegacyPlayerDuplicateRow {
  readonly categoryId: string;
  readonly userId: string;
  readonly rowCount: number;
}

export interface StartupBlockingLegacyPlayerInspection {
  readonly exists: boolean;
  readonly hasBattleAttackCount: boolean;
  readonly battleMismatchCount: number | null;
  readonly duplicateRows: readonly StartupBlockingLegacyPlayerDuplicateRow[];
}

export interface StartupBlockingLegacyReserveInspection {
  readonly reserveTableExists: boolean;
  readonly clanDataReserveColumns: readonly string[];
  readonly hasArtifacts: boolean;
}

export interface StartupBlockingLegacyShapeInspection {
  readonly ready: boolean;
  readonly legacyReserve: StartupBlockingLegacyReserveInspection;
  readonly carryOver: {
    readonly columns: readonly string[];
    readonly hasCarryOverTimeColumn: boolean;
  };
  readonly playerData: StartupBlockingLegacyPlayerInspection;
  readonly constraintPreflight: ConstraintPreflightInspection;
}

export interface EnsureCoreSchemaOptions {
  readonly legacyShapeHandling?: "fail-fast" | "repair";
}

export const CONSTRAINT_PREFLIGHT_TARGETS: readonly ConstraintPreflightTarget[] = [
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
] as const;

const CREATE_CONSTRAINT_INDEX_SQL = CONSTRAINT_PREFLIGHT_TARGETS.map(
  (target) =>
    `create unique index if not exists ${target.plannedIndexName}
on ${target.tableName} (${target.columns.join(", ")});`,
).join("\n\n");

interface DuplicatePlayerDataRow {
  row_count: bigint;
  category_id: bigint;
  user_id: bigint;
  physics_attack: bigint;
  magic_attack: bigint;
  task_kill: bigint;
  keeper_rowid: bigint;
}

interface CountRow {
  count: bigint;
}

interface DuplicateGroupRow {
  row_count: bigint;
  [key: string]: string | number | bigint | boolean | Date | null;
}

const SELECT_DUPLICATE_PLAYER_DATA_SQL = `
select
  count(*) as row_count,
  category_id,
  user_id,
  max(coalesce(physics_attack, 0)) as physics_attack,
  max(coalesce(magic_attack, 0)) as magic_attack,
  max(coalesce(task_kill, 0)) as task_kill,
  min(rowid) as keeper_rowid
from PlayerData
group by category_id, user_id
having count(*) > 1
`;

const UPDATE_DUPLICATE_PLAYER_DATA_SQL = `
update PlayerData
set
  physics_attack=?,
  magic_attack=?,
  battle_attack_count=?,
  task_kill=?
where
  rowid=?
`;

const DELETE_DUPLICATE_PLAYER_DATA_SQL = `
delete from PlayerData
where
  category_id=? and user_id=? and rowid<>?
`;

const CLAN_DATA_LEGACY_RESERVE_COLUMNS = [
  "reserve_channel_id",
  "boss1_reserve_message_id",
  "boss2_reserve_message_id",
  "boss3_reserve_message_id",
  "boss4_reserve_message_id",
  "boss5_reserve_message_id",
] as const;

const CLAN_DATA_REBUILD_SQL = `
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
`;

const INSERT_REBUILT_CLAN_DATA_SQL = `
insert into ClanData (
  guild_id,
  category_id,
  boss1_channel_id,
  boss2_channel_id,
  boss3_channel_id,
  boss4_channel_id,
  boss5_channel_id,
  remain_attack_channel_id,
  command_channel_id,
  remain_attack_message_id,
  summary_channel_id,
  day
)
select
  guild_id,
  category_id,
  boss1_channel_id,
  boss2_channel_id,
  boss3_channel_id,
  boss4_channel_id,
  boss5_channel_id,
  remain_attack_channel_id,
  command_channel_id,
  remain_attack_message_id,
  summary_channel_id,
  day
from ClanData_legacy_reserve_cleanup
`;

const CARRY_OVER_REBUILD_SQL = `
create table CarryOver (
  category_id int,
  user_id int,
  boss_index int,
  attack_type varchar,
  created datetime
);
`;

const INSERT_REBUILT_CARRY_OVER_SQL = `
insert into CarryOver (
  category_id,
  user_id,
  boss_index,
  attack_type,
  created
)
select
  category_id,
  user_id,
  boss_index,
  attack_type,
  created
from CarryOver_legacy_carry_over_time_cleanup
`;

function tableExists(database: SqliteDatabase, tableName: string): boolean {
  const row = database
    .prepare<[string], CountRow>(
      "select count(*) as count from sqlite_master where type='table' and name=?",
    )
    .get(tableName);

  return (row?.count ?? 0n) > 0n;
}

function columnExists(database: SqliteDatabase, tableName: string, columnName: string): boolean {
  const row = database
    .prepare<[], { name: string }>(
      `select name from pragma_table_info('${tableName}') where name='${columnName}'`,
    )
    .get();

  return row?.name === columnName;
}

function listColumns(database: SqliteDatabase, tableName: string): string[] {
  return database
    .prepare<[], { name: string }>(`select name from pragma_table_info('${tableName}') order by cid`)
    .all()
    .map((row) => row.name);
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function normalizeConstraintPreflightKeyValue(
  value: string | number | bigint | boolean | Date | null | undefined,
): string | null {
  if (value == null) {
    return null;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return String(value);
}

function inspectConstraintPreflightTarget(
  database: SqliteDatabase,
  target: ConstraintPreflightTarget,
): ConstraintPreflightTargetInspection {
  if (!tableExists(database, target.tableName)) {
    return {
      ...target,
      duplicateGroupCount: 0,
      duplicateGroups: [],
    };
  }

  const quotedColumns = target.columns.map(quoteSqliteIdentifier);
  const duplicateRows = database
    .prepare<[], DuplicateGroupRow>(
      `
        select
          ${quotedColumns.join(", ")},
          count(*) as row_count
        from ${quoteSqliteIdentifier(target.tableName)}
        group by ${quotedColumns.join(", ")}
        having count(*) > 1
        order by row_count desc, ${quotedColumns.join(", ")}
      `,
    )
    .all();

  return {
    ...target,
    duplicateGroupCount: duplicateRows.length,
    duplicateGroups: duplicateRows.map((row) => ({
      rowCount: Number(row.row_count),
      key: Object.fromEntries(
        target.columns.map((columnName) => [
          columnName,
          normalizeConstraintPreflightKeyValue(row[columnName]),
        ]),
      ),
    })),
  };
}

export function inspectConstraintPreflight(database: SqliteDatabase): ConstraintPreflightInspection {
  const targets = CONSTRAINT_PREFLIGHT_TARGETS.map((target) =>
    inspectConstraintPreflightTarget(database, target),
  );

  return {
    ready: targets.every((target) => target.duplicateGroupCount === 0),
    targets,
  };
}

export class ConstraintPreflightError extends Error {
  readonly inspection: ConstraintPreflightInspection;

  constructor(inspection: ConstraintPreflightInspection) {
    super(buildConstraintPreflightErrorMessage(inspection));
    this.name = "ConstraintPreflightError";
    this.inspection = inspection;
  }
}

function buildConstraintPreflightErrorMessage(inspection: ConstraintPreflightInspection): string {
  const blockedTargets = inspection.targets
    .filter((target) => target.duplicateGroupCount > 0)
    .map((target) => {
      const firstDuplicateGroup = target.duplicateGroups[0];
      const sampleKey = firstDuplicateGroup ? JSON.stringify(firstDuplicateGroup.key) : "{}";
      return `${target.plannedIndexName} on ${target.tableName}(${target.columns.join(", ")}) duplicateGroups=${target.duplicateGroupCount} sampleKey=${sampleKey}`;
    });

  return `Constraint rollout blocked by duplicate rows in future unique targets: ${blockedTargets.join("; ")}`;
}

function ensureConstraintIndexes(database: SqliteDatabase): void {
  const inspection = inspectConstraintPreflight(database);
  if (!inspection.ready) {
    throw new ConstraintPreflightError(inspection);
  }

  database.exec(CREATE_CONSTRAINT_INDEX_SQL);
}

function ensureBattleAttackCountColumn(database: SqliteDatabase): void {
  if (!tableExists(database, "PlayerData")) {
    return;
  }

  if (columnExists(database, "PlayerData", "battle_attack_count")) {
    return;
  }

  database.exec("alter table PlayerData add column battle_attack_count int default 0");
}

function backfillBattleAttackCount(database: SqliteDatabase): void {
  if (!tableExists(database, "PlayerData")) {
    return;
  }

  database.exec(`
    update PlayerData
    set battle_attack_count=coalesce(physics_attack, 0) + coalesce(magic_attack, 0)
    where battle_attack_count is null
       or battle_attack_count <> coalesce(physics_attack, 0) + coalesce(magic_attack, 0)
  `);
}

function inspectStartupBlockingLegacyPlayerData(
  database: SqliteDatabase,
): StartupBlockingLegacyPlayerInspection {
  if (!tableExists(database, "PlayerData")) {
    return {
      exists: false,
      hasBattleAttackCount: false,
      battleMismatchCount: null,
      duplicateRows: [],
    };
  }

  const hasBattleAttackCount = columnExists(database, "PlayerData", "battle_attack_count");
  const battleMismatchCount = hasBattleAttackCount
    ? Number(
        database
          .prepare<[], CountRow>(
            `
              select count(*) as count
              from PlayerData
              where battle_attack_count is null
                 or battle_attack_count <> coalesce(physics_attack, 0) + coalesce(magic_attack, 0)
            `,
          )
          .get()?.count ?? 0n,
      )
    : null;
  const duplicateRows = database
    .prepare<[], DuplicatePlayerDataRow>(SELECT_DUPLICATE_PLAYER_DATA_SQL)
    .all()
    .map((row) => ({
      categoryId: row.category_id.toString(),
      userId: row.user_id.toString(),
      rowCount: Number(row.row_count),
    }));

  return {
    exists: true,
    hasBattleAttackCount,
    battleMismatchCount,
    duplicateRows,
  };
}

export function inspectStartupBlockingLegacyShape(
  database: SqliteDatabase,
): StartupBlockingLegacyShapeInspection {
  const clanDataColumns = tableExists(database, "ClanData") ? listColumns(database, "ClanData") : [];
  const legacyReserve: StartupBlockingLegacyReserveInspection = {
    reserveTableExists: tableExists(database, "ReserveData"),
    clanDataReserveColumns: clanDataColumns.filter((columnName) =>
      CLAN_DATA_LEGACY_RESERVE_COLUMNS.includes(
        columnName as (typeof CLAN_DATA_LEGACY_RESERVE_COLUMNS)[number],
      ),
    ),
    hasArtifacts: false,
  };
  const carryOverColumns = tableExists(database, "CarryOver") ? listColumns(database, "CarryOver") : [];
  const playerData = inspectStartupBlockingLegacyPlayerData(database);
  const constraintPreflight = inspectConstraintPreflight(database);

  const inspection: StartupBlockingLegacyShapeInspection = {
    legacyReserve: {
      ...legacyReserve,
      hasArtifacts:
        legacyReserve.reserveTableExists || legacyReserve.clanDataReserveColumns.length > 0,
    },
    carryOver: {
      columns: carryOverColumns,
      hasCarryOverTimeColumn: carryOverColumns.includes("carry_over_time"),
    },
    playerData,
    constraintPreflight,
    ready: false,
  };

  return {
    ...inspection,
    ready:
      !inspection.legacyReserve.hasArtifacts &&
      !inspection.carryOver.hasCarryOverTimeColumn &&
      (!inspection.playerData.exists ||
        (inspection.playerData.hasBattleAttackCount &&
          (inspection.playerData.battleMismatchCount ?? 0) === 0 &&
          inspection.playerData.duplicateRows.length === 0)) &&
      inspection.constraintPreflight.ready,
  };
}

function buildStartupBlockingLegacyShapeErrorMessage(
  inspection: StartupBlockingLegacyShapeInspection,
): string {
  const issues: string[] = [];

  if (inspection.legacyReserve.reserveTableExists) {
    issues.push("ReserveData table exists");
  }

  if (inspection.legacyReserve.clanDataReserveColumns.length > 0) {
    issues.push(
      `ClanData legacy reserve columns remain: ${inspection.legacyReserve.clanDataReserveColumns.join(", ")}`,
    );
  }

  if (inspection.carryOver.hasCarryOverTimeColumn) {
    issues.push("CarryOver.carry_over_time column exists");
  }

  if (inspection.playerData.exists && !inspection.playerData.hasBattleAttackCount) {
    issues.push("PlayerData.battle_attack_count column is missing");
  }

  if ((inspection.playerData.battleMismatchCount ?? 0) > 0) {
    issues.push(
      `PlayerData.battle_attack_count mismatchCount=${inspection.playerData.battleMismatchCount}`,
    );
  }

  if (inspection.playerData.duplicateRows.length > 0) {
    const sampleRow = inspection.playerData.duplicateRows[0];
    issues.push(
      `PlayerData duplicateRows=${inspection.playerData.duplicateRows.length} sampleKey=${JSON.stringify(
        sampleRow,
      )}`,
    );
  }

  if (!inspection.constraintPreflight.ready) {
    const blockedTargets = inspection.constraintPreflight.targets
      .filter((target) => target.duplicateGroupCount > 0)
      .map((target) => {
        const sampleKey = target.duplicateGroups[0]
          ? JSON.stringify(target.duplicateGroups[0].key)
          : "{}";
        return `${target.plannedIndexName} duplicateGroups=${target.duplicateGroupCount} sampleKey=${sampleKey}`;
      });
    issues.push(`constraint-preflight-ready=false (${blockedTargets.join("; ")})`);
  }

  return `Startup blocked by legacy DB shape that requires explicit cleanup: ${issues.join("; ")}`;
}

export class StartupBlockingLegacyShapeError extends Error {
  readonly inspection: StartupBlockingLegacyShapeInspection;

  constructor(inspection: StartupBlockingLegacyShapeInspection) {
    super(buildStartupBlockingLegacyShapeErrorMessage(inspection));
    this.name = "StartupBlockingLegacyShapeError";
    this.inspection = inspection;
  }
}

function ensureNoStartupBlockingLegacyShape(database: SqliteDatabase): void {
  const inspection = inspectStartupBlockingLegacyShape(database);
  if (!inspection.ready) {
    throw new StartupBlockingLegacyShapeError(inspection);
  }
}

function rebuildClanDataWithoutLegacyReserveColumns(database: SqliteDatabase): void {
  if (!tableExists(database, "ClanData")) {
    return;
  }

  const clanDataColumns = listColumns(database, "ClanData");
  const hasLegacyReserveColumns = CLAN_DATA_LEGACY_RESERVE_COLUMNS.some((columnName) =>
    clanDataColumns.includes(columnName),
  );

  if (!hasLegacyReserveColumns) {
    return;
  }

  runInTransaction(database, () => {
    database.exec("alter table ClanData rename to ClanData_legacy_reserve_cleanup");
    database.exec(CLAN_DATA_REBUILD_SQL);
    database.exec(INSERT_REBUILT_CLAN_DATA_SQL);
    database.exec("drop table ClanData_legacy_reserve_cleanup");
  });
}

function dropLegacyReserveTable(database: SqliteDatabase): void {
  if (!tableExists(database, "ReserveData")) {
    return;
  }

  database.exec("drop table ReserveData");
}

function rebuildCarryOverWithoutCarryOverTime(database: SqliteDatabase): void {
  if (!tableExists(database, "CarryOver")) {
    return;
  }

  if (!columnExists(database, "CarryOver", "carry_over_time")) {
    return;
  }

  runInTransaction(database, () => {
    database.exec("alter table CarryOver rename to CarryOver_legacy_carry_over_time_cleanup");
    database.exec(CARRY_OVER_REBUILD_SQL);
    database.exec(INSERT_REBUILT_CARRY_OVER_SQL);
    database.exec("drop table CarryOver_legacy_carry_over_time_cleanup");
  });
}

function deduplicatePlayerData(database: SqliteDatabase): void {
  runInTransaction(database, () => {
    const duplicateRows = database
      .prepare<[], DuplicatePlayerDataRow>(SELECT_DUPLICATE_PLAYER_DATA_SQL)
      .all();

    for (const duplicateRow of duplicateRows) {
      const battleAttackCount = Number(duplicateRow.physics_attack + duplicateRow.magic_attack);
      database.prepare(UPDATE_DUPLICATE_PLAYER_DATA_SQL).run(
        Number(duplicateRow.physics_attack),
        Number(duplicateRow.magic_attack),
        battleAttackCount,
        Number(duplicateRow.task_kill),
        duplicateRow.keeper_rowid,
      );
      database.prepare(DELETE_DUPLICATE_PLAYER_DATA_SQL).run(
        duplicateRow.category_id,
        duplicateRow.user_id,
        duplicateRow.keeper_rowid,
      );
    }
  });
}

export function ensureCoreSchema(
  database: SqliteDatabase,
  options: EnsureCoreSchemaOptions = {},
): void {
  const legacyShapeHandling = options.legacyShapeHandling ?? "fail-fast";

  database.exec(CORE_SCHEMA_SQL);

  if (legacyShapeHandling === "repair") {
    rebuildClanDataWithoutLegacyReserveColumns(database);
    dropLegacyReserveTable(database);
    rebuildCarryOverWithoutCarryOverTime(database);
    ensureBattleAttackCountColumn(database);
    backfillBattleAttackCount(database);
    deduplicatePlayerData(database);
  } else {
    ensureNoStartupBlockingLegacyShape(database);
  }

  ensureConstraintIndexes(database);
  database.exec(CREATE_RUNTIME_INDEX_SQL);
}
