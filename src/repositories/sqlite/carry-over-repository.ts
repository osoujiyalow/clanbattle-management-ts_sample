import { CarryOver } from "../../domain/player-data.js";
import { parseAttackType } from "../../domain/attack-type.js";
import type { PlayerData } from "../../domain/player-data.js";
import type { SqliteDatabase } from "./db.js";
import {
  decodeSnowflake,
  decodeSqliteInteger,
  encodeSnowflake,
} from "./sqlite-codec.js";
import { formatSqliteDateTime, parseSqliteDateTime } from "./sqlite-time.js";

interface CarryOverRow {
  category_id: bigint;
  user_id: bigint;
  boss_index: bigint;
  attack_type: string;
  carry_over_time: bigint;
  created: string | Date;
}

const INSERT_CARRY_OVER_SQL = `insert into CarryOver values (
  ?,
  ?,
  ?,
  ?,
  ?,
  ?
)`;

const UPDATE_CARRY_OVER_SQL = `update CarryOver
set
  carry_over_time=?
where
  category_id=? and user_id=? and created=?`;

const DELETE_CARRY_OVER_SQL = `delete from CarryOver
where
  category_id=? and user_id=? and created=?`;

const DELETE_ALL_CARRY_OVER_SQL = `delete from CarryOver
where
  category_id=? and user_id=?`;

const SELECT_ALL_CARRY_OVER_SQL = "select * from CarryOver";

function requireAttackType(value: string) {
  const attackType = parseAttackType(value);

  if (!attackType) {
    throw new Error(`unknown attack type: ${value}`);
  }

  return attackType;
}

export class CarryOverRepository {
  constructor(private readonly database: SqliteDatabase) {}

  insert(categoryId: string, userId: string, carryOver: CarryOver): void {
    this.database.prepare(INSERT_CARRY_OVER_SQL).run(
      encodeSnowflake(categoryId),
      encodeSnowflake(userId),
      carryOver.bossIndex,
      carryOver.attackType,
      carryOver.carryOverTime,
      formatSqliteDateTime(carryOver.created),
    );
  }

  update(categoryId: string, userId: string, carryOver: CarryOver): void {
    this.database.prepare(UPDATE_CARRY_OVER_SQL).run(
      carryOver.carryOverTime,
      encodeSnowflake(categoryId),
      encodeSnowflake(userId),
      formatSqliteDateTime(carryOver.created),
    );
  }

  delete(categoryId: string, userId: string, carryOver: CarryOver): void {
    this.database.prepare(DELETE_CARRY_OVER_SQL).run(
      encodeSnowflake(categoryId),
      encodeSnowflake(userId),
      formatSqliteDateTime(carryOver.created),
    );
  }

  replaceAll(categoryId: string, userId: string, carryOverList: readonly CarryOver[]): void {
    this.deleteAllByUser(categoryId, userId);

    if (carryOverList.length === 0) {
      return;
    }

    const statement = this.database.prepare(INSERT_CARRY_OVER_SQL);
    for (const carryOver of carryOverList) {
      statement.run(
        encodeSnowflake(categoryId),
        encodeSnowflake(userId),
        carryOver.bossIndex,
        carryOver.attackType,
        carryOver.carryOverTime,
        formatSqliteDateTime(carryOver.created),
      );
    }
  }

  deleteAllByUser(categoryId: string, userId: string): void {
    this.database.prepare(DELETE_ALL_CARRY_OVER_SQL).run(
      encodeSnowflake(categoryId),
      encodeSnowflake(userId),
    );
  }

  findAllGroupedByCategory(
    playerMapByCategory: ReadonlyMap<string, ReadonlyMap<string, PlayerData>>,
  ): Map<string, Map<string, CarryOver[]>> {
    const rows = this.database.prepare<[], CarryOverRow>(SELECT_ALL_CARRY_OVER_SQL).all();
    const carryOverMapByCategory = new Map<string, Map<string, CarryOver[]>>();

    for (const row of rows) {
      const categoryId = decodeSnowflake(row.category_id);
      const playerMap = playerMapByCategory.get(categoryId);

      if (!playerMap) {
        continue;
      }

      const userId = decodeSnowflake(row.user_id);
      if (!playerMap.has(userId)) {
        continue;
      }

      const categoryCarryOverMap = carryOverMapByCategory.get(categoryId) ?? new Map<string, CarryOver[]>();
      const carryOverList = categoryCarryOverMap.get(userId) ?? [];
      carryOverList.push(
        new CarryOver({
          attackType: requireAttackType(row.attack_type),
          bossIndex: decodeSqliteInteger(row.boss_index),
          carryOverTime: decodeSqliteInteger(row.carry_over_time),
          created: parseSqliteDateTime(row.created),
        }),
      );
      categoryCarryOverMap.set(userId, carryOverList);
      carryOverMapByCategory.set(categoryId, categoryCarryOverMap);
    }

    return carryOverMapByCategory;
  }
}
