import { PlayerData } from "../../domain/player-data.js";
import type { SqliteDatabase } from "./db.js";
import {
  decodeSnowflake,
  encodeSnowflake,
  encodeSqliteBoolean,
  decodeSqliteBoolean,
} from "./sqlite-codec.js";

interface PlayerDataRow {
  category_id: bigint;
  user_id: bigint;
  physics_attack: bigint;
  magic_attack: bigint;
  task_kill: bigint | number | boolean;
}

const INSERT_PLAYER_DATA_SQL = `insert or ignore into PlayerData values (
  ?,
  ?,
  0,
  0,
  0
)`;

const UPDATE_PLAYER_DATA_SQL = `update PlayerData
set
  physics_attack=?,
  magic_attack=?,
  task_kill=?
where
  category_id=? and user_id=?`;

const DELETE_PLAYER_DATA_SQL = `delete from PlayerData
where
  category_id=? and user_id=?`;

const DELETE_PLAYER_DATA_FROM_RESERVE_DATA_SQL = `delete from ReserveData
where
  category_id=? and user_id=?`;

const DELETE_PLAYER_DATA_FROM_ATTACK_STATUS_SQL = `delete from AttackStatus
where
  category_id=? and user_id=?`;

const DELETE_PLAYER_DATA_FROM_CARRY_OVER_SQL = `delete from CarryOver
where
  category_id=? and user_id=?`;

const SELECT_ALL_PLAYER_DATA_SQL = "select * from PlayerData";

function mapPlayerDataRowToDomain(row: PlayerDataRow): PlayerData {
  return PlayerData.fromRecord({
    userId: decodeSnowflake(row.user_id),
    physicsAttack: Number(row.physics_attack),
    magicAttack: Number(row.magic_attack),
    taskKill: decodeSqliteBoolean(row.task_kill),
    rawLimitTimeText: "",
    log: [],
    carryOverList: [],
  });
}

export class PlayerRepository {
  constructor(private readonly database: SqliteDatabase) {}

  insertMany(categoryId: string, playerDataList: readonly PlayerData[]): void {
    const statement = this.database.prepare(INSERT_PLAYER_DATA_SQL);

    for (const playerData of playerDataList) {
      statement.run(encodeSnowflake(categoryId), encodeSnowflake(playerData.userId));
    }
  }

  update(categoryId: string, playerData: PlayerData): void {
    this.database.prepare(UPDATE_PLAYER_DATA_SQL).run(
      playerData.physicsAttack,
      playerData.magicAttack,
      encodeSqliteBoolean(playerData.taskKill),
      encodeSnowflake(categoryId),
      encodeSnowflake(playerData.userId),
    );
  }

  delete(categoryId: string, userId: string): void {
    const encodedCategoryId = encodeSnowflake(categoryId);
    const encodedUserId = encodeSnowflake(userId);

    this.database.prepare(DELETE_PLAYER_DATA_SQL).run(encodedCategoryId, encodedUserId);
    this.database.prepare(DELETE_PLAYER_DATA_FROM_CARRY_OVER_SQL).run(encodedCategoryId, encodedUserId);
    this.database.prepare(DELETE_PLAYER_DATA_FROM_ATTACK_STATUS_SQL).run(encodedCategoryId, encodedUserId);
    this.database.prepare(DELETE_PLAYER_DATA_FROM_RESERVE_DATA_SQL).run(encodedCategoryId, encodedUserId);
  }

  findByCategoryId(categoryId: string): Map<string, PlayerData> {
    const allPlayers = this.findAllGroupedByCategory();
    return allPlayers.get(categoryId) ?? new Map<string, PlayerData>();
  }

  findAllGroupedByCategory(): Map<string, Map<string, PlayerData>> {
    const rows = this.database.prepare<[], PlayerDataRow>(SELECT_ALL_PLAYER_DATA_SQL).all();
    const playerMapByCategory = new Map<string, Map<string, PlayerData>>();

    for (const row of rows) {
      const categoryId = decodeSnowflake(row.category_id);
      const playerMap = playerMapByCategory.get(categoryId) ?? new Map<string, PlayerData>();
      const playerData = mapPlayerDataRowToDomain(row);
      playerMap.set(playerData.userId, playerData);
      playerMapByCategory.set(categoryId, playerMap);
    }

    return playerMapByCategory;
  }
}
