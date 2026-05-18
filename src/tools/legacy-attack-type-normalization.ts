import {
  BATTLE_STORAGE_ATTACK_TYPE,
  CARRYOVER_STORAGE_ATTACK_TYPE,
} from "../repositories/sqlite/attack-type-storage.js";
import { runInTransaction, type SqliteDatabase } from "../repositories/sqlite/db.js";

const LEGACY_BATTLE_ATTACK_TYPE_ALIASES = ["BATTLE", "MAGIC", "PHYSICS"] as const;
const LEGACY_CARRYOVER_ATTACK_TYPE_ALIASES = ["CARRYOVER"] as const;

function tableExists(database: SqliteDatabase, tableName: string): boolean {
  const row = database
    .prepare<[string], { count: bigint }>(
      "select count(*) as count from sqlite_master where type='table' and name=?",
    )
    .get(tableName);

  return Number(row?.count ?? 0n) > 0;
}

function columnExists(database: SqliteDatabase, tableName: string, columnName: string): boolean {
  if (!tableExists(database, tableName)) {
    return false;
  }

  const row = database
    .prepare<[string], { name: string }>(`select name from pragma_table_info('${tableName}') where name=?`)
    .get(columnName);

  return row?.name === columnName;
}

export interface AttackTypeNormalizationCounts {
  AttackStatus: number;
  CarryOver: number;
}

export function normalizeAttackTypeForExplicitCleanup(attackType: string): string {
  if (
    attackType === BATTLE_STORAGE_ATTACK_TYPE ||
    LEGACY_BATTLE_ATTACK_TYPE_ALIASES.includes(attackType as (typeof LEGACY_BATTLE_ATTACK_TYPE_ALIASES)[number])
  ) {
    return BATTLE_STORAGE_ATTACK_TYPE;
  }

  if (
    attackType === CARRYOVER_STORAGE_ATTACK_TYPE ||
    LEGACY_CARRYOVER_ATTACK_TYPE_ALIASES.includes(
      attackType as (typeof LEGACY_CARRYOVER_ATTACK_TYPE_ALIASES)[number],
    )
  ) {
    return CARRYOVER_STORAGE_ATTACK_TYPE;
  }

  throw new Error(`unknown attack type: ${attackType}`);
}

export function normalizeAttackTypesForExplicitCleanup(
  database: SqliteDatabase,
): AttackTypeNormalizationCounts {
  const counts: AttackTypeNormalizationCounts = {
    AttackStatus: 0,
    CarryOver: 0,
  };

  runInTransaction(database, () => {
    for (const tableName of ["AttackStatus", "CarryOver"] as const) {
      if (!columnExists(database, tableName, "attack_type")) {
        continue;
      }

      counts[tableName] += Number(
        database
          .prepare(
            `update ${tableName} set attack_type=? where attack_type in (?, ?, ?)` ,
          )
          .run(
            BATTLE_STORAGE_ATTACK_TYPE,
            ...LEGACY_BATTLE_ATTACK_TYPE_ALIASES,
          ).changes,
      );

      counts[tableName] += Number(
        database
          .prepare(`update ${tableName} set attack_type=? where attack_type=?`)
          .run(
            CARRYOVER_STORAGE_ATTACK_TYPE,
            LEGACY_CARRYOVER_ATTACK_TYPE_ALIASES[0],
          ).changes,
      );
    }
  });

  return counts;
}
