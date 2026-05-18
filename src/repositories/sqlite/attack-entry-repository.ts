import {
  AttackEntry,
  parseAttackEntryKind,
  parseAttackEntryStatus,
} from "../../domain/attack-entry.js";
import type { SqliteDatabase } from "./db.js";
import {
  decodeSnowflake,
  decodeSqliteInteger,
  encodeSnowflake,
} from "./sqlite-codec.js";
import {
  formatSqliteDateTime,
  normalizeSqliteDate,
  parseSqliteDateTime,
} from "./sqlite-time.js";

interface AttackEntryRow {
  attack_entry_id: string;
  category_id: bigint;
  user_id: bigint;
  day_key: string;
  lap: bigint;
  boss_index: bigint;
  kind: string;
  status: string;
  declared_at: string | Date;
  resolved_at: string | Date | null;
  damage: bigint | null;
  memo: string | null;
}

const INSERT_ATTACK_ENTRY_SQL = `insert into AttackEntry (
  attack_entry_id,
  category_id,
  user_id,
  day_key,
  lap,
  boss_index,
  kind,
  status,
  declared_at,
  resolved_at,
  damage,
  memo
) values (
  ?,
  ?,
  ?,
  ?,
  ?,
  ?,
  ?,
  ?,
  ?,
  ?,
  ?,
  ?
)`;

const UPDATE_ATTACK_ENTRY_SQL = `update AttackEntry
set
  category_id=?,
  user_id=?,
  day_key=?,
  lap=?,
  boss_index=?,
  kind=?,
  status=?,
  declared_at=?,
  resolved_at=?,
  damage=?,
  memo=?
where
  attack_entry_id=?`;

const DELETE_ATTACK_ENTRY_SQL = `delete from AttackEntry
where
  attack_entry_id=?`;

const DELETE_ALL_ATTACK_ENTRY_BY_CATEGORY_SQL = `delete from AttackEntry
where
  category_id=?`;

const DELETE_ALL_ATTACK_ENTRY_BY_USER_SQL = `delete from AttackEntry
where
  category_id=? and user_id=?`;

const DELETE_ALL_ATTACK_ENTRY_BY_BOSS_SQL = `delete from AttackEntry
where
  category_id=? and boss_index=?`;

const DELETE_ATTACK_ENTRY_BEFORE_DAY_KEY_SQL = `delete from AttackEntry
where
  category_id=? and day_key<?`;

const SELECT_ATTACK_ENTRY_BY_ID_SQL = `select *
from AttackEntry
where
  attack_entry_id=?`;

const SELECT_ATTACK_ENTRY_BY_CATEGORY_SQL = `select *
from AttackEntry
where
  category_id=?
order by
  user_id asc,
  day_key asc,
  declared_at asc,
  attack_entry_id asc`;

function requireAttackEntryKind(value: string) {
  const parsed = parseAttackEntryKind(value);

  if (!parsed) {
    throw new Error(`unknown attack entry kind: ${value}`);
  }

  return parsed;
}

function requireAttackEntryStatus(value: string) {
  const parsed = parseAttackEntryStatus(value);

  if (!parsed) {
    throw new Error(`unknown attack entry status: ${value}`);
  }

  return parsed;
}

function toAttackEntry(row: AttackEntryRow): AttackEntry {
  return new AttackEntry({
    attackEntryId: row.attack_entry_id,
    categoryId: decodeSnowflake(row.category_id),
    userId: decodeSnowflake(row.user_id),
    dayKey: normalizeSqliteDate(row.day_key),
    lap: decodeSqliteInteger(row.lap),
    bossIndex: decodeSqliteInteger(row.boss_index),
    kind: requireAttackEntryKind(row.kind),
    status: requireAttackEntryStatus(row.status),
    declaredAt: parseSqliteDateTime(row.declared_at),
    resolvedAt: row.resolved_at ? parseSqliteDateTime(row.resolved_at) : null,
    damage: row.damage === null ? null : decodeSqliteInteger(row.damage),
    memo: row.memo,
  });
}

export class AttackEntryRepository {
  constructor(private readonly database: SqliteDatabase) {}

  insert(attackEntry: AttackEntry): void {
    this.database.prepare(INSERT_ATTACK_ENTRY_SQL).run(
      attackEntry.attackEntryId,
      encodeSnowflake(attackEntry.categoryId),
      encodeSnowflake(attackEntry.userId),
      normalizeSqliteDate(attackEntry.dayKey),
      attackEntry.lap,
      attackEntry.bossIndex,
      attackEntry.kind,
      attackEntry.status,
      formatSqliteDateTime(attackEntry.declaredAt),
      attackEntry.resolvedAt ? formatSqliteDateTime(attackEntry.resolvedAt) : null,
      attackEntry.damage,
      attackEntry.memo,
    );
  }

  update(attackEntry: AttackEntry): void {
    this.database.prepare(UPDATE_ATTACK_ENTRY_SQL).run(
      encodeSnowflake(attackEntry.categoryId),
      encodeSnowflake(attackEntry.userId),
      normalizeSqliteDate(attackEntry.dayKey),
      attackEntry.lap,
      attackEntry.bossIndex,
      attackEntry.kind,
      attackEntry.status,
      formatSqliteDateTime(attackEntry.declaredAt),
      attackEntry.resolvedAt ? formatSqliteDateTime(attackEntry.resolvedAt) : null,
      attackEntry.damage,
      attackEntry.memo,
      attackEntry.attackEntryId,
    );
  }

  delete(attackEntryId: string): void {
    this.database.prepare(DELETE_ATTACK_ENTRY_SQL).run(attackEntryId);
  }

  deleteAllByCategory(categoryId: string): void {
    this.database.prepare(DELETE_ALL_ATTACK_ENTRY_BY_CATEGORY_SQL).run(
      encodeSnowflake(categoryId),
    );
  }

  deleteAllByUser(categoryId: string, userId: string): void {
    this.database.prepare(DELETE_ALL_ATTACK_ENTRY_BY_USER_SQL).run(
      encodeSnowflake(categoryId),
      encodeSnowflake(userId),
    );
  }

  deleteAllByBossIndex(categoryId: string, bossIndex: number): void {
    this.database.prepare(DELETE_ALL_ATTACK_ENTRY_BY_BOSS_SQL).run(
      encodeSnowflake(categoryId),
      bossIndex,
    );
  }

  deleteBeforeDayKey(categoryId: string, dayKey: string): number {
    const result = this.database.prepare(DELETE_ATTACK_ENTRY_BEFORE_DAY_KEY_SQL).run(
      encodeSnowflake(categoryId),
      normalizeSqliteDate(dayKey),
    );
    return result.changes;
  }

  findById(attackEntryId: string): AttackEntry | null {
    const row = this.database
      .prepare<[string], AttackEntryRow>(SELECT_ATTACK_ENTRY_BY_ID_SQL)
      .get(attackEntryId);

    return row ? toAttackEntry(row) : null;
  }

  findAllByCategory(categoryId: string): AttackEntry[] {
    const rows = this.database
      .prepare<[bigint], AttackEntryRow>(SELECT_ATTACK_ENTRY_BY_CATEGORY_SQL)
      .all(encodeSnowflake(categoryId));

    return rows.map(toAttackEntry);
  }
}
