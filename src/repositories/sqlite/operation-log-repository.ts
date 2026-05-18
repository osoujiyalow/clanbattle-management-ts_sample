import {
  parseAttackEntryKind,
  parseAttackEntryStatus,
} from "../../domain/attack-entry.js";
import {
  OperationLog,
  parseOperationLogType,
} from "../../domain/operation-log.js";
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

interface OperationLogRow {
  operation_id: string;
  category_id: bigint;
  user_id: bigint;
  day_key: string;
  lap: bigint;
  boss_index: bigint;
  target_attack_entry_id: string;
  operation_type: string;
  before_kind: string | null;
  after_kind: string | null;
  before_status: string | null;
  after_status: string | null;
  occurred_at: string | Date;
  invalidated_at: string | Date | null;
}

const INSERT_OPERATION_LOG_SQL = `insert into OperationLog (
  operation_id,
  category_id,
  user_id,
  day_key,
  lap,
  boss_index,
  target_attack_entry_id,
  operation_type,
  before_kind,
  after_kind,
  before_status,
  after_status,
  occurred_at,
  invalidated_at
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
  ?,
  ?,
  ?
)`;

const UPDATE_OPERATION_LOG_SQL = `update OperationLog
set
  category_id=?,
  user_id=?,
  day_key=?,
  lap=?,
  boss_index=?,
  target_attack_entry_id=?,
  operation_type=?,
  before_kind=?,
  after_kind=?,
  before_status=?,
  after_status=?,
  occurred_at=?,
  invalidated_at=?
where
  operation_id=?`;

const DELETE_OPERATION_LOG_SQL = `delete from OperationLog
where
  operation_id=?`;

const DELETE_ALL_OPERATION_LOG_BY_CATEGORY_SQL = `delete from OperationLog
where
  category_id=?`;

const DELETE_ALL_OPERATION_LOG_BY_USER_SQL = `delete from OperationLog
where
  category_id=? and user_id=?`;

const DELETE_ALL_OPERATION_LOG_BY_BOSS_SQL = `delete from OperationLog
where
  category_id=? and boss_index=?`;

const DELETE_OPERATION_LOG_BEFORE_DAY_KEY_SQL = `delete from OperationLog
where
  category_id=? and day_key<?`;

const SELECT_OPERATION_LOG_BY_ID_SQL = `select *
from OperationLog
where
  operation_id=?`;

const SELECT_OPERATION_LOG_BY_CATEGORY_SQL = `select *
from OperationLog
where
  category_id=?
order by
  user_id asc,
  day_key asc,
  occurred_at asc,
  operation_id asc`;

function requireOperationLogType(value: string) {
  const parsed = parseOperationLogType(value);

  if (!parsed) {
    throw new Error(`unknown operation log type: ${value}`);
  }

  return parsed;
}

function requireNullableAttackEntryKind(value: string | null) {
  if (value === null) {
    return null;
  }

  const parsed = parseAttackEntryKind(value);

  if (!parsed) {
    throw new Error(`unknown attack entry kind: ${value}`);
  }

  return parsed;
}

function requireNullableAttackEntryStatus(value: string | null) {
  if (value === null) {
    return null;
  }

  const parsed = parseAttackEntryStatus(value);

  if (!parsed) {
    throw new Error(`unknown attack entry status: ${value}`);
  }

  return parsed;
}

function toOperationLog(row: OperationLogRow): OperationLog {
  return new OperationLog({
    operationId: row.operation_id,
    categoryId: decodeSnowflake(row.category_id),
    userId: decodeSnowflake(row.user_id),
    dayKey: normalizeSqliteDate(row.day_key),
    lap: decodeSqliteInteger(row.lap),
    bossIndex: decodeSqliteInteger(row.boss_index),
    targetAttackEntryId: row.target_attack_entry_id,
    operationType: requireOperationLogType(row.operation_type),
    beforeKind: requireNullableAttackEntryKind(row.before_kind),
    afterKind: requireNullableAttackEntryKind(row.after_kind),
    beforeStatus: requireNullableAttackEntryStatus(row.before_status),
    afterStatus: requireNullableAttackEntryStatus(row.after_status),
    occurredAt: parseSqliteDateTime(row.occurred_at),
    invalidatedAt: row.invalidated_at ? parseSqliteDateTime(row.invalidated_at) : null,
  });
}

export class OperationLogRepository {
  constructor(private readonly database: SqliteDatabase) {}

  insert(operationLog: OperationLog): void {
    this.database.prepare(INSERT_OPERATION_LOG_SQL).run(
      operationLog.operationId,
      encodeSnowflake(operationLog.categoryId),
      encodeSnowflake(operationLog.userId),
      normalizeSqliteDate(operationLog.dayKey),
      operationLog.lap,
      operationLog.bossIndex,
      operationLog.targetAttackEntryId,
      operationLog.operationType,
      operationLog.beforeKind,
      operationLog.afterKind,
      operationLog.beforeStatus,
      operationLog.afterStatus,
      formatSqliteDateTime(operationLog.occurredAt),
      operationLog.invalidatedAt ? formatSqliteDateTime(operationLog.invalidatedAt) : null,
    );
  }

  update(operationLog: OperationLog): void {
    this.database.prepare(UPDATE_OPERATION_LOG_SQL).run(
      encodeSnowflake(operationLog.categoryId),
      encodeSnowflake(operationLog.userId),
      normalizeSqliteDate(operationLog.dayKey),
      operationLog.lap,
      operationLog.bossIndex,
      operationLog.targetAttackEntryId,
      operationLog.operationType,
      operationLog.beforeKind,
      operationLog.afterKind,
      operationLog.beforeStatus,
      operationLog.afterStatus,
      formatSqliteDateTime(operationLog.occurredAt),
      operationLog.invalidatedAt ? formatSqliteDateTime(operationLog.invalidatedAt) : null,
      operationLog.operationId,
    );
  }

  delete(operationId: string): void {
    this.database.prepare(DELETE_OPERATION_LOG_SQL).run(operationId);
  }

  deleteAllByCategory(categoryId: string): void {
    this.database.prepare(DELETE_ALL_OPERATION_LOG_BY_CATEGORY_SQL).run(
      encodeSnowflake(categoryId),
    );
  }

  deleteAllByUser(categoryId: string, userId: string): void {
    this.database.prepare(DELETE_ALL_OPERATION_LOG_BY_USER_SQL).run(
      encodeSnowflake(categoryId),
      encodeSnowflake(userId),
    );
  }

  deleteAllByBossIndex(categoryId: string, bossIndex: number): void {
    this.database.prepare(DELETE_ALL_OPERATION_LOG_BY_BOSS_SQL).run(
      encodeSnowflake(categoryId),
      bossIndex,
    );
  }

  deleteBeforeDayKey(categoryId: string, dayKey: string): number {
    const result = this.database.prepare(DELETE_OPERATION_LOG_BEFORE_DAY_KEY_SQL).run(
      encodeSnowflake(categoryId),
      normalizeSqliteDate(dayKey),
    );
    return result.changes;
  }

  findById(operationId: string): OperationLog | null {
    const row = this.database
      .prepare<[string], OperationLogRow>(SELECT_OPERATION_LOG_BY_ID_SQL)
      .get(operationId);

    return row ? toOperationLog(row) : null;
  }

  findAllByCategory(categoryId: string): OperationLog[] {
    const rows = this.database
      .prepare<[bigint], OperationLogRow>(SELECT_OPERATION_LOG_BY_CATEGORY_SQL)
      .all(encodeSnowflake(categoryId));

    return rows.map(toOperationLog);
  }
}
