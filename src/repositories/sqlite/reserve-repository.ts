import { parseAttackType } from "../../domain/attack-type.js";
import { ReserveData } from "../../domain/reserve-data.js";
import type { PlayerData } from "../../domain/player-data.js";
import type { SqliteDatabase } from "./db.js";
import {
  decodeSnowflake,
  decodeSqliteBoolean,
  decodeSqliteInteger,
  encodeSnowflake,
  encodeSqliteBoolean,
} from "./sqlite-codec.js";

interface ReserveDataRow {
  category_id: bigint;
  boss_index: bigint;
  user_id: bigint;
  attack_type: string;
  damage: bigint;
  memo: string;
  carry_over: bigint | number | boolean;
}

const INSERT_RESERVE_DATA_SQL = `insert into ReserveData values (
  ?,
  ?,
  ?,
  ?,
  ?,
  ?,
  ?
)`;

const UPDATE_RESERVE_DATA_SQL = `update ReserveData
set
  damage=?,
  memo=?,
  carry_over=?
where
  category_id=? and boss_index=? and user_id=? and attack_type=?`;

const DELETE_RESERVE_DATA_SQL = `delete from ReserveData
where
  category_id=? and boss_index=? and user_id=? and attack_type=? and carry_over=?`;

const DELETE_ALL_RESERVE_DATA_SQL = "delete from ReserveData where category_id=?";

const SELECT_ALL_RESERVE_DATA_SQL = "select * from ReserveData";

function createReserveSlots(): ReserveData[][] {
  return [[], [], [], [], []];
}

function requireAttackType(value: string) {
  const attackType = parseAttackType(value);

  if (!attackType) {
    throw new Error(`unknown attack type: ${value}`);
  }

  return attackType;
}

export class ReserveRepository {
  constructor(private readonly database: SqliteDatabase) {}

  insert(categoryId: string, bossIndex: number, reserveData: ReserveData): void {
    this.database.prepare(INSERT_RESERVE_DATA_SQL).run(
      encodeSnowflake(categoryId),
      bossIndex,
      encodeSnowflake(reserveData.playerData.userId),
      reserveData.attackType,
      reserveData.damage,
      reserveData.memo,
      encodeSqliteBoolean(reserveData.carryOver),
    );
  }

  update(categoryId: string, bossIndex: number, reserveData: ReserveData): void {
    this.database.prepare(UPDATE_RESERVE_DATA_SQL).run(
      reserveData.damage,
      reserveData.memo,
      encodeSqliteBoolean(reserveData.carryOver),
      encodeSnowflake(categoryId),
      bossIndex,
      encodeSnowflake(reserveData.playerData.userId),
      reserveData.attackType,
    );
  }

  delete(categoryId: string, bossIndex: number, reserveData: ReserveData): void {
    this.database.prepare(DELETE_RESERVE_DATA_SQL).run(
      encodeSnowflake(categoryId),
      bossIndex,
      encodeSnowflake(reserveData.playerData.userId),
      reserveData.attackType,
      encodeSqliteBoolean(reserveData.carryOver),
    );
  }

  deleteAllByCategory(categoryId: string): void {
    this.database.prepare(DELETE_ALL_RESERVE_DATA_SQL).run(encodeSnowflake(categoryId));
  }

  findAllGroupedByCategory(
    playerMapByCategory: ReadonlyMap<string, ReadonlyMap<string, PlayerData>>,
  ): Map<string, ReserveData[][]> {
    const rows = this.database.prepare<[], ReserveDataRow>(SELECT_ALL_RESERVE_DATA_SQL).all();
    const reserveMapByCategory = new Map<string, ReserveData[][]>();

    for (const row of rows) {
      const categoryId = decodeSnowflake(row.category_id);
      const playerMap = playerMapByCategory.get(categoryId);

      if (!playerMap) {
        continue;
      }

      const playerData = playerMap.get(decodeSnowflake(row.user_id));
      if (!playerData) {
        continue;
      }

      const bossIndex = decodeSqliteInteger(row.boss_index);
      const reserveSlots = reserveMapByCategory.get(categoryId) ?? createReserveSlots();
      const reserveData = ReserveData.fromRecord(
        {
          playerUserId: playerData.userId,
          attackType: requireAttackType(row.attack_type),
          damage: decodeSqliteInteger(row.damage),
          memo: row.memo,
          carryOver: decodeSqliteBoolean(row.carry_over),
        },
        playerData,
      );

      reserveSlots[bossIndex]?.push(reserveData);
      reserveMapByCategory.set(categoryId, reserveSlots);
    }

    return reserveMapByCategory;
  }
}
