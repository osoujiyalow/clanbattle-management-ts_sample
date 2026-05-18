import { PlayerResourceState } from "../../domain/player-resource-state.js";
import type { SqliteDatabase } from "./db.js";
import {
  decodeSnowflake,
  decodeSqliteInteger,
  encodeSnowflake,
} from "./sqlite-codec.js";
import { normalizeSqliteDate } from "./sqlite-time.js";

interface PlayerResourceStateRow {
  category_id: bigint;
  user_id: bigint;
  day_key: string;
  battle_reserved_count: bigint;
  battle_consumed_count: bigint;
  carry_available_count: bigint;
  carry_reserved_count: bigint;
}

const INSERT_PLAYER_RESOURCE_STATE_SQL = `insert into PlayerResourceState (
  category_id,
  user_id,
  day_key,
  battle_reserved_count,
  battle_consumed_count,
  carry_available_count,
  carry_reserved_count
) values (
  ?,
  ?,
  ?,
  ?,
  ?,
  ?,
  ?
)`;

const UPDATE_PLAYER_RESOURCE_STATE_SQL = `update PlayerResourceState
set
  battle_reserved_count=?,
  battle_consumed_count=?,
  carry_available_count=?,
  carry_reserved_count=?
where
  category_id=? and user_id=? and day_key=?`;

const UPSERT_PLAYER_RESOURCE_STATE_SQL = `insert into PlayerResourceState (
  category_id,
  user_id,
  day_key,
  battle_reserved_count,
  battle_consumed_count,
  carry_available_count,
  carry_reserved_count
) values (
  ?,
  ?,
  ?,
  ?,
  ?,
  ?,
  ?
)
on conflict(category_id, user_id, day_key) do update set
  battle_reserved_count=excluded.battle_reserved_count,
  battle_consumed_count=excluded.battle_consumed_count,
  carry_available_count=excluded.carry_available_count,
  carry_reserved_count=excluded.carry_reserved_count`;

const DELETE_PLAYER_RESOURCE_STATE_SQL = `delete from PlayerResourceState
where
  category_id=? and user_id=? and day_key=?`;

const DELETE_ALL_PLAYER_RESOURCE_STATE_BY_CATEGORY_SQL = `delete from PlayerResourceState
where
  category_id=?`;

const DELETE_ALL_PLAYER_RESOURCE_STATE_BY_USER_SQL = `delete from PlayerResourceState
where
  category_id=? and user_id=?`;

const DELETE_PLAYER_RESOURCE_STATE_BEFORE_DAY_KEY_SQL = `delete from PlayerResourceState
where
  category_id=? and day_key<?`;

const SELECT_PLAYER_RESOURCE_STATE_BY_KEY_SQL = `select *
from PlayerResourceState
where
  category_id=? and user_id=? and day_key=?`;

const SELECT_PLAYER_RESOURCE_STATE_BY_CATEGORY_SQL = `select *
from PlayerResourceState
where
  category_id=?
order by
  user_id asc,
  day_key asc`;

function toPlayerResourceState(row: PlayerResourceStateRow): PlayerResourceState {
  return new PlayerResourceState({
    categoryId: decodeSnowflake(row.category_id),
    userId: decodeSnowflake(row.user_id),
    dayKey: normalizeSqliteDate(row.day_key),
    battleReservedCount: decodeSqliteInteger(row.battle_reserved_count),
    battleConsumedCount: decodeSqliteInteger(row.battle_consumed_count),
    carryAvailableCount: decodeSqliteInteger(row.carry_available_count),
    carryReservedCount: decodeSqliteInteger(row.carry_reserved_count),
  });
}

export class PlayerResourceStateRepository {
  constructor(private readonly database: SqliteDatabase) {}

  insert(playerResourceState: PlayerResourceState): void {
    this.database.prepare(INSERT_PLAYER_RESOURCE_STATE_SQL).run(
      encodeSnowflake(playerResourceState.categoryId),
      encodeSnowflake(playerResourceState.userId),
      normalizeSqliteDate(playerResourceState.dayKey),
      playerResourceState.battleReservedCount,
      playerResourceState.battleConsumedCount,
      playerResourceState.carryAvailableCount,
      playerResourceState.carryReservedCount,
    );
  }

  update(playerResourceState: PlayerResourceState): void {
    this.database.prepare(UPDATE_PLAYER_RESOURCE_STATE_SQL).run(
      playerResourceState.battleReservedCount,
      playerResourceState.battleConsumedCount,
      playerResourceState.carryAvailableCount,
      playerResourceState.carryReservedCount,
      encodeSnowflake(playerResourceState.categoryId),
      encodeSnowflake(playerResourceState.userId),
      normalizeSqliteDate(playerResourceState.dayKey),
    );
  }

  upsert(playerResourceState: PlayerResourceState): void {
    this.database.prepare(UPSERT_PLAYER_RESOURCE_STATE_SQL).run(
      encodeSnowflake(playerResourceState.categoryId),
      encodeSnowflake(playerResourceState.userId),
      normalizeSqliteDate(playerResourceState.dayKey),
      playerResourceState.battleReservedCount,
      playerResourceState.battleConsumedCount,
      playerResourceState.carryAvailableCount,
      playerResourceState.carryReservedCount,
    );
  }

  delete(categoryId: string, userId: string, dayKey: string): void {
    this.database.prepare(DELETE_PLAYER_RESOURCE_STATE_SQL).run(
      encodeSnowflake(categoryId),
      encodeSnowflake(userId),
      normalizeSqliteDate(dayKey),
    );
  }

  deleteAllByCategory(categoryId: string): void {
    this.database.prepare(DELETE_ALL_PLAYER_RESOURCE_STATE_BY_CATEGORY_SQL).run(
      encodeSnowflake(categoryId),
    );
  }

  deleteAllByUser(categoryId: string, userId: string): void {
    this.database.prepare(DELETE_ALL_PLAYER_RESOURCE_STATE_BY_USER_SQL).run(
      encodeSnowflake(categoryId),
      encodeSnowflake(userId),
    );
  }

  deleteBeforeDayKey(categoryId: string, dayKey: string): number {
    const result = this.database.prepare(DELETE_PLAYER_RESOURCE_STATE_BEFORE_DAY_KEY_SQL).run(
      encodeSnowflake(categoryId),
      normalizeSqliteDate(dayKey),
    );
    return result.changes;
  }

  findByKey(categoryId: string, userId: string, dayKey: string): PlayerResourceState | null {
    const row = this.database
      .prepare<[bigint, bigint, string], PlayerResourceStateRow>(SELECT_PLAYER_RESOURCE_STATE_BY_KEY_SQL)
      .get(
        encodeSnowflake(categoryId),
        encodeSnowflake(userId),
        normalizeSqliteDate(dayKey),
      );

    return row ? toPlayerResourceState(row) : null;
  }

  findAllByCategory(categoryId: string): PlayerResourceState[] {
    const rows = this.database
      .prepare<[bigint], PlayerResourceStateRow>(SELECT_PLAYER_RESOURCE_STATE_BY_CATEGORY_SQL)
      .all(encodeSnowflake(categoryId));

    return rows.map(toPlayerResourceState);
  }
}
