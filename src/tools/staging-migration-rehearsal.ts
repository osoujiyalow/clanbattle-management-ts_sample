import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { createProgressActionComponents } from "../discord/progress-action-buttons.js";
import type { ClanData } from "../domain/clan-data.js";
import {
  ensureCoreSchema,
  inspectStartupBlockingLegacyShape,
  type ConstraintPreflightInspection,
  type StartupBlockingLegacyShapeInspection,
} from "../repositories/sqlite/core-schema.js";
import type { SqliteDatabase } from "../repositories/sqlite/db.js";
import { closeSqliteDatabase, openSqliteDatabase } from "../repositories/sqlite/db.js";
import {
  BATTLE_STORAGE_ATTACK_TYPE,
  CARRYOVER_STORAGE_ATTACK_TYPE,
} from "../repositories/sqlite/attack-type-storage.js";
import { renderProgressEmbed } from "../renderers/progress-renderer.js";
import { renderRemainAttackEmbed } from "../renderers/remain-attack-renderer.js";
import { RuntimeStateService } from "../services/runtime-state-service.js";
import { createFixedClock, type Clock } from "../shared/time.js";
import { normalizeAttackTypesForExplicitCleanup } from "./legacy-attack-type-normalization.js";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type CountRow = {
  count: bigint;
};

type AttackTypeCountRow = {
  attack_type: string;
  count: bigint;
};

type PlayerAggregateRow = {
  players: bigint;
  min_physics: bigint | null;
  max_physics: bigint | null;
  min_magic: bigint | null;
  max_magic: bigint | null;
  min_battle?: bigint | null;
  max_battle?: bigint | null;
};

type DuplicatePlayerRow = {
  category_id: bigint;
  user_id: bigint;
  row_count: bigint;
  max_physics: bigint;
  max_magic: bigint;
};

type AttackTypeCount = {
  attackType: string;
  count: number;
};

type ValueCount = {
  value: string;
  count: number;
};

type TableInspection = {
  exists: boolean;
  rowCount: number;
  columns: string[];
  attackTypes: AttackTypeCount[];
};

type AttackEntryInspection = {
  exists: boolean;
  rowCount: number;
  columns: string[];
  kinds: ValueCount[];
  statuses: ValueCount[];
  dayKeys: string[];
};

type PlayerResourceStateInspection = {
  exists: boolean;
  rowCount: number;
  columns: string[];
  dayKeys: string[];
  maxBattleReservedCount: number | null;
  maxBattleConsumedCount: number | null;
  maxCarryAvailableCount: number | null;
  maxCarryReservedCount: number | null;
};

type OperationLogInspection = {
  exists: boolean;
  rowCount: number;
  columns: string[];
  operationTypes: ValueCount[];
  dayKeys: string[];
};

type HiddenStateInspection = {
  attackEntry: AttackEntryInspection;
  playerResourceState: PlayerResourceStateInspection;
  operationLog: OperationLogInspection;
};

type PlayerAggregateInspection = {
  players: number;
  minPhysics: number | null;
  maxPhysics: number | null;
  minMagic: number | null;
  maxMagic: number | null;
  minBattle: number | null;
  maxBattle: number | null;
};

type DuplicatePlayerInspection = {
  categoryId: string;
  userId: string;
  rowCount: number;
  maxPhysics: number;
  maxMagic: number;
};

type PlayerDataInspection = {
  exists: boolean;
  columns: string[];
  aggregate: PlayerAggregateInspection | null;
  hasBattleAttackCount: boolean;
  battleMismatchCount: number | null;
  duplicateRows: DuplicatePlayerInspection[];
};

type LegacyReserveInspection = {
  reserveTableExists: boolean;
  clanDataReserveColumns: string[];
  hasArtifacts: boolean;
};

type DatabaseInspection = {
  tables: {
    ClanData: TableInspection;
    PlayerData: TableInspection;
    AttackStatus: TableInspection;
    BossStatusData: TableInspection;
    CarryOver: TableInspection;
    AttackEntry: TableInspection;
    PlayerResourceState: TableInspection;
    OperationLog: TableInspection;
    ProgressMessageIdData: TableInspection;
    SummaryMessageIdData: TableInspection;
    ReserveData: TableInspection;
  };
  playerData: PlayerDataInspection;
  legacyReserve: LegacyReserveInspection;
  startupBlockingLegacyShape: StartupBlockingLegacyShapeInspection;
  legacyAttackTypeAliases: {
    attackStatus: string[];
    carryOver: string[];
  };
  constraintPreflight: ConstraintPreflightInspection;
  hiddenState: HiddenStateInspection;
};

type ProgressButtonInspection = {
  customId: string | null;
  emoji: string | null;
  label: string | null;
};

type RuntimeInspection = {
  restored: boolean;
  categoryCount: number;
  categoryIds: string[];
  projectedState: {
    attackEntryCount: number;
    playerResourceStateCount: number;
    operationLogCount: number;
    attackEntryStatuses: ValueCount[];
    operationTypes: ValueCount[];
    samplePlayerResourceState:
      | {
          categoryId: string;
          userId: string;
          dayKey: string;
          battleReservedCount: number;
          battleConsumedCount: number;
          carryAvailableCount: number;
          carryReservedCount: number;
        }
      | null;
  };
  progressButtons: ProgressButtonInspection[];
  sampleProgress: {
    title: string | null;
    description: string | null;
  } | null;
  sampleRemainAttack: {
    title: string | null;
    description: string | null;
    fieldNames: string[];
    firstFieldValue: string | null;
  } | null;
  sampleRenderError: {
    name: string;
    message: string;
  } | null;
  error: {
    name: string;
    message: string;
  } | null;
};

type RehearsalCheck = {
  name: string;
  ok: boolean;
  details: JsonValue;
};

type RehearsalSummary = {
  sourceHadStartupBlockingLegacyShape: boolean;
  sourceHadLegacyReserveArtifacts: boolean;
  sourceHadLegacyCarryOverTimeColumn: boolean;
  sourceHadLegacyAttackTypeAliases: boolean;
  sourceNeededBattleAttackBackfill: boolean;
  sourceHadConstraintTargetDuplicates: boolean;
  sourceHadHiddenStateRows: boolean;
  sourceNeededProjectedStateBackfill: boolean;
};

export type RehearsalReport = {
  sourcePath: string;
  backupPath: string;
  workingPath: string;
  reportPath: string;
  before: DatabaseInspection;
  after: DatabaseInspection;
  sourceAfter: DatabaseInspection;
  runtime: RuntimeInspection;
  summary: RehearsalSummary;
  checks: RehearsalCheck[];
  ok: boolean;
};

export interface RunStagingMigrationRehearsalOptions {
  sourcePath: string;
  outputDir: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

const LEGACY_ATTACK_TYPE_ALIASES = new Set(["BATTLE", "PHYSICS", "MAGIC", "CARRYOVER"]);
const CANONICAL_ATTACK_TYPES = new Set<string>([
  BATTLE_STORAGE_ATTACK_TYPE,
  CARRYOVER_STORAGE_ATTACK_TYPE,
]);
const EXPECTED_ATTACK_ENTRY_COLUMNS = [
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
] as const;
const EXPECTED_PLAYER_RESOURCE_STATE_COLUMNS = [
  "category_id",
  "user_id",
  "day_key",
  "battle_reserved_count",
  "battle_consumed_count",
  "carry_available_count",
  "carry_reserved_count",
] as const;
const EXPECTED_OPERATION_LOG_COLUMNS = [
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
] as const;

function normalizeForJson(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForJson(entry));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        normalizeForJson(entry),
      ]),
    );
  }

  return String(value);
}

function toNullableNumber(value: bigint | null | undefined): number | null {
  if (value == null) {
    return null;
  }

  return Number(value);
}

function tableExists(database: SqliteDatabase, tableName: string): boolean {
  const row = database
    .prepare<[string], CountRow>(
      "select count(*) as count from sqlite_master where type='table' and name=?",
    )
    .get(tableName);

  return Number(row?.count ?? 0n) > 0;
}

function listColumns(database: SqliteDatabase, tableName: string): string[] {
  if (!tableExists(database, tableName)) {
    return [];
  }

  return database
    .prepare<[], { name: string }>(`select name from pragma_table_info('${tableName}') order by cid`)
    .all()
    .map((row) => row.name);
}

function columnExists(database: SqliteDatabase, tableName: string, columnName: string): boolean {
  if (!tableExists(database, tableName)) {
    return false;
  }

  const row = database
    .prepare<[], { name: string }>(
      `select name from pragma_table_info('${tableName}') where name='${columnName}'`,
    )
    .get();

  return row?.name === columnName;
}

function getTableRowCount(database: SqliteDatabase, tableName: string): number {
  if (!tableExists(database, tableName)) {
    return 0;
  }

  const row = database
    .prepare<[], CountRow>(`select count(*) as count from ${tableName}`)
    .get();
  return Number(row?.count ?? 0n);
}

function getAttackTypeCounts(database: SqliteDatabase, tableName: string): AttackTypeCount[] {
  if (!tableExists(database, tableName) || !columnExists(database, tableName, "attack_type")) {
    return [];
  }

  return database
    .prepare<[], AttackTypeCountRow>(
      `select attack_type, count(*) as count from ${tableName} group by attack_type order by attack_type`,
    )
    .all()
    .map((row) => ({
      attackType: row.attack_type,
      count: Number(row.count),
    }));
}

function getValueCounts(
  database: SqliteDatabase,
  tableName: string,
  columnName: string,
): ValueCount[] {
  if (!tableExists(database, tableName) || !columnExists(database, tableName, columnName)) {
    return [];
  }

  return database
    .prepare<[], { value: string | null; count: bigint }>(
      `select ${columnName} as value, count(*) as count from ${tableName} group by ${columnName} order by ${columnName}`,
    )
    .all()
    .map((row) => ({
      value: row.value ?? "NULL",
      count: Number(row.count),
    }));
}

function getDistinctColumnValues(
  database: SqliteDatabase,
  tableName: string,
  columnName: string,
): string[] {
  if (!tableExists(database, tableName) || !columnExists(database, tableName, columnName)) {
    return [];
  }

  return database
    .prepare<[], { value: string | null }>(
      `select distinct ${columnName} as value from ${tableName} where ${columnName} is not null order by ${columnName}`,
    )
    .all()
    .map((row) => row.value)
    .filter((value): value is string => typeof value === "string");
}

function inspectTable(database: SqliteDatabase, tableName: string): TableInspection {
  return {
    exists: tableExists(database, tableName),
    rowCount: getTableRowCount(database, tableName),
    columns: listColumns(database, tableName),
    attackTypes: getAttackTypeCounts(database, tableName),
  };
}

function inspectAttackEntry(database: SqliteDatabase): AttackEntryInspection {
  return {
    exists: tableExists(database, "AttackEntry"),
    rowCount: getTableRowCount(database, "AttackEntry"),
    columns: listColumns(database, "AttackEntry"),
    kinds: getValueCounts(database, "AttackEntry", "kind"),
    statuses: getValueCounts(database, "AttackEntry", "status"),
    dayKeys: getDistinctColumnValues(database, "AttackEntry", "day_key"),
  };
}

function inspectPlayerResourceState(database: SqliteDatabase): PlayerResourceStateInspection {
  if (!tableExists(database, "PlayerResourceState")) {
    return {
      exists: false,
      rowCount: 0,
      columns: [],
      dayKeys: [],
      maxBattleReservedCount: null,
      maxBattleConsumedCount: null,
      maxCarryAvailableCount: null,
      maxCarryReservedCount: null,
    };
  }

  const aggregate = database
    .prepare<
      [],
      {
        max_battle_reserved_count: bigint | null;
        max_battle_consumed_count: bigint | null;
        max_carry_available_count: bigint | null;
        max_carry_reserved_count: bigint | null;
      }
    >(
      `
        select
          max(battle_reserved_count) as max_battle_reserved_count,
          max(battle_consumed_count) as max_battle_consumed_count,
          max(carry_available_count) as max_carry_available_count,
          max(carry_reserved_count) as max_carry_reserved_count
        from PlayerResourceState
      `,
    )
    .get();

  return {
    exists: true,
    rowCount: getTableRowCount(database, "PlayerResourceState"),
    columns: listColumns(database, "PlayerResourceState"),
    dayKeys: getDistinctColumnValues(database, "PlayerResourceState", "day_key"),
    maxBattleReservedCount: toNullableNumber(aggregate?.max_battle_reserved_count),
    maxBattleConsumedCount: toNullableNumber(aggregate?.max_battle_consumed_count),
    maxCarryAvailableCount: toNullableNumber(aggregate?.max_carry_available_count),
    maxCarryReservedCount: toNullableNumber(aggregate?.max_carry_reserved_count),
  };
}

function inspectOperationLog(database: SqliteDatabase): OperationLogInspection {
  return {
    exists: tableExists(database, "OperationLog"),
    rowCount: getTableRowCount(database, "OperationLog"),
    columns: listColumns(database, "OperationLog"),
    operationTypes: getValueCounts(database, "OperationLog", "operation_type"),
    dayKeys: getDistinctColumnValues(database, "OperationLog", "day_key"),
  };
}

function inspectPlayerData(database: SqliteDatabase): PlayerDataInspection {
  if (!tableExists(database, "PlayerData")) {
    return {
      exists: false,
      columns: [],
      aggregate: null,
      hasBattleAttackCount: false,
      battleMismatchCount: null,
      duplicateRows: [],
    };
  }

  const columns = listColumns(database, "PlayerData");
  const hasBattleAttackCount = columns.includes("battle_attack_count");
  const aggregateSql = hasBattleAttackCount
    ? `
      select
        count(*) as players,
        min(physics_attack) as min_physics,
        max(physics_attack) as max_physics,
        min(magic_attack) as min_magic,
        max(magic_attack) as max_magic,
        min(battle_attack_count) as min_battle,
        max(battle_attack_count) as max_battle
      from PlayerData
    `
    : `
      select
        count(*) as players,
        min(physics_attack) as min_physics,
        max(physics_attack) as max_physics,
        min(magic_attack) as min_magic,
        max(magic_attack) as max_magic
      from PlayerData
    `;
  const aggregate = database.prepare<[], PlayerAggregateRow>(aggregateSql).get();

  const battleMismatchCount = hasBattleAttackCount
    ? Number(
        database
          .prepare<[], CountRow>(
            `
              select count(*) as count
              from PlayerData
              where coalesce(battle_attack_count, 0) <> coalesce(physics_attack, 0) + coalesce(magic_attack, 0)
            `,
          )
          .get()?.count ?? 0n,
      )
    : null;

  return {
    exists: true,
    columns,
    aggregate: aggregate
      ? {
          players: Number(aggregate.players),
          minPhysics: toNullableNumber(aggregate.min_physics),
          maxPhysics: toNullableNumber(aggregate.max_physics),
          minMagic: toNullableNumber(aggregate.min_magic),
          maxMagic: toNullableNumber(aggregate.max_magic),
          minBattle: toNullableNumber(aggregate.min_battle),
          maxBattle: toNullableNumber(aggregate.max_battle),
        }
      : null,
    hasBattleAttackCount,
    battleMismatchCount,
    duplicateRows: database
      .prepare<[], DuplicatePlayerRow>(
        `
          select
            category_id,
            user_id,
            count(*) as row_count,
            max(coalesce(physics_attack, 0)) as max_physics,
            max(coalesce(magic_attack, 0)) as max_magic
          from PlayerData
          group by category_id, user_id
          having count(*) > 1
          order by category_id, user_id
        `,
      )
      .all()
      .map((row) => ({
        categoryId: row.category_id.toString(),
        userId: row.user_id.toString(),
        rowCount: Number(row.row_count),
        maxPhysics: Number(row.max_physics),
        maxMagic: Number(row.max_magic),
      })),
  };
}

function listLegacyAttackTypeAliases(tableInspection: TableInspection): string[] {
  return tableInspection.attackTypes
    .map((entry) => entry.attackType)
    .filter((attackType) => LEGACY_ATTACK_TYPE_ALIASES.has(attackType))
    .sort();
}

function inspectDatabase(database: SqliteDatabase): DatabaseInspection {
  const clanTable = inspectTable(database, "ClanData");
  const attackStatusTable = inspectTable(database, "AttackStatus");
  const carryOverTable = inspectTable(database, "CarryOver");
  const reserveTable = inspectTable(database, "ReserveData");
  const startupBlockingLegacyShape = inspectStartupBlockingLegacyShape(database);

  return {
    tables: {
      ClanData: clanTable,
      PlayerData: inspectTable(database, "PlayerData"),
      AttackStatus: attackStatusTable,
      BossStatusData: inspectTable(database, "BossStatusData"),
      CarryOver: carryOverTable,
      AttackEntry: inspectTable(database, "AttackEntry"),
      PlayerResourceState: inspectTable(database, "PlayerResourceState"),
      OperationLog: inspectTable(database, "OperationLog"),
      ProgressMessageIdData: inspectTable(database, "ProgressMessageIdData"),
      SummaryMessageIdData: inspectTable(database, "SummaryMessageIdData"),
      ReserveData: reserveTable,
    },
    playerData: inspectPlayerData(database),
    legacyReserve: {
      reserveTableExists: startupBlockingLegacyShape.legacyReserve.reserveTableExists,
      clanDataReserveColumns: [...startupBlockingLegacyShape.legacyReserve.clanDataReserveColumns],
      hasArtifacts: startupBlockingLegacyShape.legacyReserve.hasArtifacts,
    },
    startupBlockingLegacyShape,
    legacyAttackTypeAliases: {
      attackStatus: listLegacyAttackTypeAliases(attackStatusTable),
      carryOver: listLegacyAttackTypeAliases(carryOverTable),
    },
    constraintPreflight: startupBlockingLegacyShape.constraintPreflight,
    hiddenState: {
      attackEntry: inspectAttackEntry(database),
      playerResourceState: inspectPlayerResourceState(database),
      operationLog: inspectOperationLog(database),
    },
  };
}

function selectSampleProgress(clanData: ClanData): { lap: number; bossIndex: number } | null {
  const laps = [...clanData.bossStatusByLap.keys()].sort((left, right) => left - right);

  for (const lap of laps) {
    const bossStatusList = clanData.bossStatusByLap.get(lap);
    if (!bossStatusList) {
      continue;
    }

    for (let bossIndex = 0; bossIndex < bossStatusList.length; bossIndex += 1) {
      if (bossStatusList[bossIndex]) {
        return { lap, bossIndex };
      }
    }
  }

  return null;
}

function countAttackStatuses(clanData: ClanData): number {
  let count = 0;

  for (const bossStatusList of clanData.bossStatusByLap.values()) {
    for (const bossStatus of bossStatusList) {
      if (!bossStatus) {
        continue;
      }

      count += bossStatus.attackPlayers.length;
    }
  }

  return count;
}

function selectSampleClan(clans: ClanData[]): ClanData | undefined {
  return [...clans].sort((left, right) => {
    const attackDelta = countAttackStatuses(right) - countAttackStatuses(left);
    if (attackDelta !== 0) {
      return attackDelta;
    }

    return right.playerDataMap.size - left.playerDataMap.size;
  })[0];
}

function summarizeStringValues(values: readonly string[]): ValueCount[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([value, count]) => ({ value, count }));
}

function getProgressButtonLabels(): ProgressButtonInspection[] {
  return createProgressActionComponents().flatMap((row) =>
    row.components.map((component) => {
      const json = component.toJSON();
      const customId = "custom_id" in json ? json.custom_id : null;
      const emoji =
        "emoji" in json && json.emoji && typeof json.emoji.name === "string" ? json.emoji.name : null;
      const label = "label" in json ? json.label : null;
      return {
        customId,
        emoji,
        label,
      };
    }),
  );
}

function inspectRuntimeState(
  runtimeStateService: RuntimeStateService,
  clock?: Clock,
): RuntimeInspection {
  const clans = [...runtimeStateService.getAll().values()];
  const sampleClan = selectSampleClan(clans);
  const attackEntries = clans.flatMap((clanData) =>
    runtimeStateService.getAttackEntries(clanData.categoryId),
  );
  const playerResourceStates = clans.flatMap((clanData) =>
    runtimeStateService.getPlayerResourceStates(clanData.categoryId),
  );
  const operationLogs = clans.flatMap((clanData) =>
    runtimeStateService.getOperationLogs(clanData.categoryId),
  );
  const samplePlayerResourceState = playerResourceStates[0] ?? null;
  const projectedState = {
    attackEntryCount: attackEntries.length,
    playerResourceStateCount: playerResourceStates.length,
    operationLogCount: operationLogs.length,
    attackEntryStatuses: summarizeStringValues(attackEntries.map((attackEntry) => attackEntry.status)),
    operationTypes: summarizeStringValues(operationLogs.map((operationLog) => operationLog.operationType)),
    samplePlayerResourceState: samplePlayerResourceState
      ? {
          categoryId: samplePlayerResourceState.categoryId,
          userId: samplePlayerResourceState.userId,
          dayKey: samplePlayerResourceState.dayKey,
          battleReservedCount: samplePlayerResourceState.battleReservedCount,
          battleConsumedCount: samplePlayerResourceState.battleConsumedCount,
          carryAvailableCount: samplePlayerResourceState.carryAvailableCount,
          carryReservedCount: samplePlayerResourceState.carryReservedCount,
        }
      : null,
  };

  if (!sampleClan) {
    return {
      restored: true,
      categoryCount: 0,
      categoryIds: [],
      projectedState,
      progressButtons: getProgressButtonLabels(),
      sampleProgress: null,
      sampleRemainAttack: null,
      sampleRenderError: null,
      error: null,
    };
  }

  const sampleProgress = selectSampleProgress(sampleClan);
  const sampleDisplayNames = new Map(
    [...sampleClan.playerDataMap.values()].map((playerData) => [playerData.userId, playerData.userId]),
  );
  let progressEmbed:
    | {
        title?: string;
        description?: string;
      }
    | null = null;
  let remainEmbed:
    | {
        title?: string;
        description?: string;
        footer?: {
          text?: string;
        };
        fields?: Array<{
          name: string;
          value: string;
        }>;
      }
    | null = null;
  let sampleRenderError: RuntimeInspection["sampleRenderError"] = null;

  try {
    remainEmbed = renderRemainAttackEmbed({
      clanData: sampleClan,
      displayNamesByUserId: sampleDisplayNames,
      ...(clock ? { clock } : {}),
    }).toJSON();
    progressEmbed = sampleProgress
      ? renderProgressEmbed({
          clanData: sampleClan,
          lap: sampleProgress.lap,
          bossIndex: sampleProgress.bossIndex,
          displayNamesByUserId: sampleDisplayNames,
        }).toJSON()
      : null;
  } catch (error: unknown) {
    sampleRenderError = {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    restored: true,
    categoryCount: clans.length,
    categoryIds: clans.map((clanData) => clanData.categoryId),
    projectedState,
    progressButtons: getProgressButtonLabels(),
    sampleProgress: progressEmbed
      ? {
          title: progressEmbed.title ?? null,
          description: progressEmbed.description ?? null,
        }
      : null,
    sampleRemainAttack: remainEmbed
      ? {
          title: remainEmbed.title ?? null,
          description: remainEmbed.description ?? null,
          fieldNames: (remainEmbed.fields ?? []).map((field) => field.name),
          firstFieldValue: remainEmbed.fields?.[0]?.value ?? null,
        }
      : null,
    sampleRenderError,
    error: null,
  };
}

function buildInspectionClock(database: SqliteDatabase): Clock | null {
  const row = database
    .prepare<[], { day: string | null }>("select max(day) as day from ClanData")
    .get();

  if (!row?.day) {
    return null;
  }

  return createFixedClock(`${row.day}T12:00:00+09:00`);
}

function runWithInspectionSavepoint<TResult>(
  database: SqliteDatabase,
  operation: () => TResult,
): TResult {
  database.exec("savepoint staging_runtime_inspection");

  try {
    const result = operation();
    database.exec("rollback to staging_runtime_inspection");
    database.exec("release staging_runtime_inspection");
    return result;
  } catch (error) {
    database.exec("rollback to staging_runtime_inspection");
    database.exec("release staging_runtime_inspection");
    throw error;
  }
}

function inspectRuntime(database: SqliteDatabase): RuntimeInspection {
  try {
    return runWithInspectionSavepoint(database, () => {
      const inspectionClock = buildInspectionClock(database) ?? undefined;
      const runtimeStateService = new RuntimeStateService({
        database,
        ...(inspectionClock ? { clock: inspectionClock } : {}),
      });
      runtimeStateService.restoreFromDatabase();
      return inspectRuntimeState(runtimeStateService, inspectionClock);
    });
  } catch (error: unknown) {
    return {
      restored: false,
      categoryCount: 0,
      categoryIds: [],
      projectedState: {
        attackEntryCount: 0,
        playerResourceStateCount: 0,
        operationLogCount: 0,
        attackEntryStatuses: [],
        operationTypes: [],
        samplePlayerResourceState: null,
      },
      progressButtons: getProgressButtonLabels(),
      sampleProgress: null,
      sampleRemainAttack: null,
      sampleRenderError: null,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function createRuntimeInspectionError(error: unknown): RuntimeInspection {
  return {
    restored: false,
    categoryCount: 0,
    categoryIds: [],
    projectedState: {
      attackEntryCount: 0,
      playerResourceStateCount: 0,
      operationLogCount: 0,
      attackEntryStatuses: [],
      operationTypes: [],
      samplePlayerResourceState: null,
    },
    progressButtons: getProgressButtonLabels(),
    sampleProgress: null,
    sampleRemainAttack: null,
    sampleRenderError: null,
    error: {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function formatTimestamp(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function isCanonicalAttackTypeSet(entries: AttackTypeCount[]): boolean {
  return entries.every((entry) => CANONICAL_ATTACK_TYPES.has(entry.attackType));
}

function isBattleAttackCountReady(inspection: StartupBlockingLegacyShapeInspection): boolean {
  return (
    !inspection.playerData.exists ||
    (inspection.playerData.hasBattleAttackCount &&
      (inspection.playerData.battleMismatchCount ?? 0) === 0)
  );
}

function createConstraintPreflightDetails(
  constraintPreflight: ConstraintPreflightInspection,
): JsonValue {
  return {
    ready: constraintPreflight.ready,
    duplicateTargets: constraintPreflight.targets
      .filter((target) => target.duplicateGroupCount > 0)
      .map((target) => ({
        tableName: target.tableName,
        plannedIndexName: target.plannedIndexName,
        columns: [...target.columns],
        duplicateGroupCount: target.duplicateGroupCount,
        duplicateGroups: target.duplicateGroups.map((duplicateGroup) => ({
          rowCount: duplicateGroup.rowCount,
          key: { ...duplicateGroup.key },
        })),
      })),
  };
}

function createStartupBlockingLegacyShapeDetails(
  inspection: StartupBlockingLegacyShapeInspection,
): JsonValue {
  return {
    ready: inspection.ready,
    legacyReserve: {
      reserveTableExists: inspection.legacyReserve.reserveTableExists,
      clanDataReserveColumns: [...inspection.legacyReserve.clanDataReserveColumns],
      hasArtifacts: inspection.legacyReserve.hasArtifacts,
    },
    carryOverTimeColumn: {
      present: inspection.carryOver.hasCarryOverTimeColumn,
      columns: [...inspection.carryOver.columns],
    },
    battleAttackCountReady: isBattleAttackCountReady(inspection),
    playerDataDuplicateRows: inspection.playerData.duplicateRows.map((row) => ({ ...row })),
    constraintPreflight: createConstraintPreflightDetails(inspection.constraintPreflight),
  };
}

function createSummary(before: DatabaseInspection): RehearsalSummary {
  return {
    sourceHadStartupBlockingLegacyShape: !before.startupBlockingLegacyShape.ready,
    sourceHadLegacyReserveArtifacts: before.startupBlockingLegacyShape.legacyReserve.hasArtifacts,
    sourceHadLegacyCarryOverTimeColumn:
      before.startupBlockingLegacyShape.carryOver.hasCarryOverTimeColumn,
    sourceHadLegacyAttackTypeAliases:
      before.legacyAttackTypeAliases.attackStatus.length > 0 ||
      before.legacyAttackTypeAliases.carryOver.length > 0,
    sourceNeededBattleAttackBackfill:
      before.startupBlockingLegacyShape.playerData.exists &&
      !isBattleAttackCountReady(before.startupBlockingLegacyShape),
    sourceHadConstraintTargetDuplicates: !before.startupBlockingLegacyShape.constraintPreflight.ready,
    sourceHadHiddenStateRows:
      before.hiddenState.attackEntry.rowCount > 0 ||
      before.hiddenState.playerResourceState.rowCount > 0 ||
      before.hiddenState.operationLog.rowCount > 0,
    sourceNeededProjectedStateBackfill:
      before.tables.AttackStatus.rowCount > 0 && before.hiddenState.attackEntry.rowCount === 0,
  };
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeForJson(left)) === JSON.stringify(normalizeForJson(right));
}

function evaluateChecks(
  before: DatabaseInspection,
  after: DatabaseInspection,
  sourceAfter: DatabaseInspection,
  runtime: RuntimeInspection,
  paths: {
    backupPath: string;
    workingPath: string;
  },
): RehearsalCheck[] {
  return [
    {
      name: "backup-created",
      ok: fs.existsSync(paths.backupPath),
      details: { backupPath: paths.backupPath },
    },
    {
      name: "working-copy-created",
      ok: fs.existsSync(paths.workingPath),
      details: { workingPath: paths.workingPath },
    },
    {
      name: "source-database-unchanged",
      ok: sameJsonValue(before, sourceAfter),
      details: {
        startupBlockingLegacyShapeBefore: createStartupBlockingLegacyShapeDetails(
          before.startupBlockingLegacyShape,
        ),
        startupBlockingLegacyShapeSourceAfter: createStartupBlockingLegacyShapeDetails(
          sourceAfter.startupBlockingLegacyShape,
        ),
      },
    },
    {
      name: "startup-blocking-legacy-shape-ready",
      ok: after.startupBlockingLegacyShape.ready,
      details: createStartupBlockingLegacyShapeDetails(after.startupBlockingLegacyShape),
    },
    {
      name: "rehearsal-runtime-restore-succeeded",
      ok: runtime.restored,
      details: runtime.error ?? { categoryCount: runtime.categoryCount },
    },
    {
      name: "reserve-table-removed",
      ok: !after.legacyReserve.reserveTableExists,
      details: { existsAfter: after.legacyReserve.reserveTableExists },
    },
    {
      name: "clandata-reserve-columns-removed",
      ok: after.legacyReserve.clanDataReserveColumns.length === 0,
      details: { remainingColumns: after.legacyReserve.clanDataReserveColumns },
    },
    {
      name: "carry-over-time-column-removed",
      ok: !after.tables.CarryOver.columns.includes("carry_over_time"),
      details: {
        columnsAfter: after.tables.CarryOver.columns,
      },
    },
    {
      name: "rehearsal-hidden-state-tables-present",
      ok:
        after.hiddenState.attackEntry.exists &&
        after.hiddenState.playerResourceState.exists &&
        after.hiddenState.operationLog.exists,
      details: {
        attackEntryExists: after.hiddenState.attackEntry.exists,
        playerResourceStateExists: after.hiddenState.playerResourceState.exists,
        operationLogExists: after.hiddenState.operationLog.exists,
      },
    },
    {
      name: "rehearsal-hidden-state-columns-ready",
      ok:
        sameJsonValue(after.hiddenState.attackEntry.columns, EXPECTED_ATTACK_ENTRY_COLUMNS) &&
        sameJsonValue(
          after.hiddenState.playerResourceState.columns,
          EXPECTED_PLAYER_RESOURCE_STATE_COLUMNS,
        ) &&
        sameJsonValue(after.hiddenState.operationLog.columns, EXPECTED_OPERATION_LOG_COLUMNS),
      details: {
        attackEntryColumns: after.hiddenState.attackEntry.columns,
        playerResourceStateColumns: after.hiddenState.playerResourceState.columns,
        operationLogColumns: after.hiddenState.operationLog.columns,
      },
    },
    {
      name: "rehearsal-runtime-projected-state-counts-match-db",
      ok:
        runtime.projectedState.attackEntryCount === after.hiddenState.attackEntry.rowCount &&
        runtime.projectedState.playerResourceStateCount ===
          after.hiddenState.playerResourceState.rowCount &&
        runtime.projectedState.operationLogCount === after.hiddenState.operationLog.rowCount,
      details: {
        runtimeProjectedState: runtime.projectedState,
        dbProjectedState: {
          attackEntryCount: after.hiddenState.attackEntry.rowCount,
          playerResourceStateCount: after.hiddenState.playerResourceState.rowCount,
          operationLogCount: after.hiddenState.operationLog.rowCount,
        },
      },
    },
    {
      name: "rehearsal-player-resource-counts-bounded",
      ok:
        (after.hiddenState.playerResourceState.maxBattleReservedCount ?? 0) <= 3 &&
        (after.hiddenState.playerResourceState.maxBattleConsumedCount ?? 0) <= 3 &&
        (after.hiddenState.playerResourceState.maxCarryAvailableCount ?? 0) <= 3 &&
        (after.hiddenState.playerResourceState.maxCarryReservedCount ?? 0) <= 3,
      details: {
        maxBattleReservedCount: after.hiddenState.playerResourceState.maxBattleReservedCount,
        maxBattleConsumedCount: after.hiddenState.playerResourceState.maxBattleConsumedCount,
        maxCarryAvailableCount: after.hiddenState.playerResourceState.maxCarryAvailableCount,
        maxCarryReservedCount: after.hiddenState.playerResourceState.maxCarryReservedCount,
      },
    },
    {
      name: "player-data-duplicate-rows-removed",
      ok: after.startupBlockingLegacyShape.playerData.duplicateRows.length === 0,
      details: {
        duplicateRows: after.startupBlockingLegacyShape.playerData.duplicateRows.map((row) => ({
          ...row,
        })),
      },
    },
    {
      name: "battle-attack-count-ready",
      ok: isBattleAttackCountReady(after.startupBlockingLegacyShape),
      details: {
        battleAttackCountReady: isBattleAttackCountReady(after.startupBlockingLegacyShape),
        hasBattleAttackCount: after.startupBlockingLegacyShape.playerData.hasBattleAttackCount,
        battleMismatchCount: after.startupBlockingLegacyShape.playerData.battleMismatchCount,
      },
    },
    {
      name: "constraint-preflight-ready",
      ok: after.startupBlockingLegacyShape.constraintPreflight.ready,
      details: createConstraintPreflightDetails(after.startupBlockingLegacyShape.constraintPreflight),
    },
    {
      name: "rehearsal-attack-types-normalized",
      ok:
        isCanonicalAttackTypeSet(after.tables.AttackStatus.attackTypes) &&
        isCanonicalAttackTypeSet(after.tables.CarryOver.attackTypes),
      details: {
        attackStatusAliases: after.legacyAttackTypeAliases.attackStatus,
        carryOverAliases: after.legacyAttackTypeAliases.carryOver,
        attackStatusTypes: after.tables.AttackStatus.attackTypes,
        carryOverTypes: after.tables.CarryOver.attackTypes,
      },
    },
  ];
}

function buildFailureMessage(report: RehearsalReport): string {
  const failedChecks = report.checks.filter((check) => !check.ok).map((check) => check.name);

  if (failedChecks.length === 0) {
    return "staging migration rehearsal failed";
  }

  return `staging migration rehearsal failed: ${failedChecks.join(", ")}`;
}

export async function runStagingMigrationRehearsal(
  options: RunStagingMigrationRehearsalOptions,
): Promise<RehearsalReport> {
  const sourcePath = path.resolve(options.sourcePath);
  const outputDir = path.resolve(options.outputDir);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`source database not found: ${sourcePath}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const baseName = path.basename(sourcePath, path.extname(sourcePath));
  const timestamp = formatTimestamp(new Date());
  const backupPath = path.join(outputDir, `${baseName}.backup.${timestamp}.sqlite3`);
  const workingPath = path.join(outputDir, `${baseName}.rehearsal.${timestamp}.sqlite3`);
  const reportPath = path.join(outputDir, `${baseName}.rehearsal.${timestamp}.json`);

  const sourceDatabase = openSqliteDatabase({
    filePath: sourcePath,
    fileMustExist: true,
  });
  try {
    await sourceDatabase.backup(backupPath);
    await sourceDatabase.backup(workingPath);
  } finally {
    closeSqliteDatabase(sourceDatabase);
  }

  const rehearsalDatabase = openSqliteDatabase({
    filePath: workingPath,
    fileMustExist: true,
  });

  let before: DatabaseInspection;
  let after: DatabaseInspection;
  let runtime: RuntimeInspection;
  try {
    before = inspectDatabase(rehearsalDatabase);
    let migrationError: unknown = null;
    try {
      ensureCoreSchema(rehearsalDatabase, { legacyShapeHandling: "repair" });
      normalizeAttackTypesForExplicitCleanup(rehearsalDatabase);
    } catch (error: unknown) {
      migrationError = error;
    }

    runtime = migrationError ? createRuntimeInspectionError(migrationError) : inspectRuntime(rehearsalDatabase);
    after = inspectDatabase(rehearsalDatabase);
  } finally {
    closeSqliteDatabase(rehearsalDatabase);
  }

  const sourceVerificationDatabase = openSqliteDatabase({
    filePath: sourcePath,
    fileMustExist: true,
    readonly: true,
  });

  let sourceAfter: DatabaseInspection;
  try {
    sourceAfter = inspectDatabase(sourceVerificationDatabase);
  } finally {
    closeSqliteDatabase(sourceVerificationDatabase);
  }

  const report: RehearsalReport = {
    sourcePath,
    backupPath,
    workingPath,
    reportPath,
    before,
    after,
    sourceAfter,
    runtime,
    summary: createSummary(before),
    checks: evaluateChecks(before, after, sourceAfter, runtime, {
      backupPath,
      workingPath,
    }),
    ok: false,
  };
  report.ok = report.checks.every((check) => check.ok);

  fs.writeFileSync(reportPath, `${JSON.stringify(normalizeForJson(report), null, 2)}\n`, "utf8");

  return report;
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      source: { type: "string" },
      "output-dir": { type: "string" },
    },
    allowPositionals: false,
  });

  const report = await runStagingMigrationRehearsal({
    sourcePath: parsed.values.source ?? path.join(repoRoot, "staging.sqlite3"),
    outputDir: parsed.values["output-dir"] ?? path.join(repoRoot, "logs", "rehearsals"),
  });

  console.log(JSON.stringify(normalizeForJson(report), null, 2));

  if (!report.ok) {
    throw new Error(buildFailureMessage(report));
  }
}

function isMainModule(): boolean {
  return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
}

if (isMainModule()) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
