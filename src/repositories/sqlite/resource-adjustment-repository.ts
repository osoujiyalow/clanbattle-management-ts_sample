import {
  parseResourceAdjustmentType,
  ResourceAdjustment,
} from "../../domain/resource-adjustment.js";
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

interface ResourceAdjustmentRow {
  adjustment_id: string;
  category_id: bigint;
  user_id: bigint;
  actor_user_id: bigint;
  day_key: string;
  resource_type: string;
  remaining: bigint;
  occurred_at: string | Date;
}

const INSERT_RESOURCE_ADJUSTMENT_SQL = `insert into ResourceAdjustmentLog (
  adjustment_id,
  category_id,
  user_id,
  actor_user_id,
  day_key,
  resource_type,
  remaining,
  occurred_at
) values (
  ?,
  ?,
  ?,
  ?,
  ?,
  ?,
  ?,
  ?
)`;

const DELETE_ALL_RESOURCE_ADJUSTMENT_BY_CATEGORY_SQL = `delete from ResourceAdjustmentLog
where
  category_id=?`;

const DELETE_ALL_RESOURCE_ADJUSTMENT_BY_USER_SQL = `delete from ResourceAdjustmentLog
where
  category_id=? and user_id=?`;

const DELETE_RESOURCE_ADJUSTMENT_BEFORE_DAY_KEY_SQL = `delete from ResourceAdjustmentLog
where
  category_id=? and day_key<?`;

const SELECT_RESOURCE_ADJUSTMENT_BY_CATEGORY_SQL = `select *
from ResourceAdjustmentLog
where
  category_id=?
order by
  user_id asc,
  day_key asc,
  occurred_at asc,
  adjustment_id asc`;

function toResourceAdjustment(row: ResourceAdjustmentRow): ResourceAdjustment {
  const resourceType = parseResourceAdjustmentType(row.resource_type);
  if (!resourceType) {
    throw new Error(`unknown resource adjustment type: ${row.resource_type}`);
  }

  return new ResourceAdjustment({
    adjustmentId: row.adjustment_id,
    categoryId: decodeSnowflake(row.category_id),
    userId: decodeSnowflake(row.user_id),
    actorUserId: decodeSnowflake(row.actor_user_id),
    dayKey: normalizeSqliteDate(row.day_key),
    resourceType,
    remaining: decodeSqliteInteger(row.remaining),
    occurredAt: parseSqliteDateTime(row.occurred_at),
  });
}

export class ResourceAdjustmentRepository {
  constructor(private readonly database: SqliteDatabase) {}

  insert(resourceAdjustment: ResourceAdjustment): void {
    this.database.prepare(INSERT_RESOURCE_ADJUSTMENT_SQL).run(
      resourceAdjustment.adjustmentId,
      encodeSnowflake(resourceAdjustment.categoryId),
      encodeSnowflake(resourceAdjustment.userId),
      encodeSnowflake(resourceAdjustment.actorUserId),
      normalizeSqliteDate(resourceAdjustment.dayKey),
      resourceAdjustment.resourceType,
      resourceAdjustment.remaining,
      formatSqliteDateTime(resourceAdjustment.occurredAt),
    );
  }

  deleteAllByCategory(categoryId: string): void {
    this.database.prepare(DELETE_ALL_RESOURCE_ADJUSTMENT_BY_CATEGORY_SQL).run(
      encodeSnowflake(categoryId),
    );
  }

  deleteAllByUser(categoryId: string, userId: string): void {
    this.database.prepare(DELETE_ALL_RESOURCE_ADJUSTMENT_BY_USER_SQL).run(
      encodeSnowflake(categoryId),
      encodeSnowflake(userId),
    );
  }

  deleteBeforeDayKey(categoryId: string, dayKey: string): number {
    const result = this.database.prepare(DELETE_RESOURCE_ADJUSTMENT_BEFORE_DAY_KEY_SQL).run(
      encodeSnowflake(categoryId),
      normalizeSqliteDate(dayKey),
    );
    return result.changes;
  }

  findAllByCategory(categoryId: string): ResourceAdjustment[] {
    const rows = this.database
      .prepare<[bigint], ResourceAdjustmentRow>(SELECT_RESOURCE_ADJUSTMENT_BY_CATEGORY_SQL)
      .all(encodeSnowflake(categoryId));

    return rows.map(toResourceAdjustment);
  }
}
