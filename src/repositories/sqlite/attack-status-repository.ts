import { parseAttackType } from "../../domain/attack-type.js";
import { AttackStatus } from "../../domain/attack-status.js";
import type { PlayerData } from "../../domain/player-data.js";
import type { SqliteDatabase } from "./db.js";
import {
  decodeSnowflake,
  decodeSqliteBoolean,
  decodeSqliteInteger,
  encodeSnowflake,
  encodeSqliteBoolean,
} from "./sqlite-codec.js";
import { formatSqliteDateTime, parseSqliteDateTime } from "./sqlite-time.js";

interface AttackStatusRow {
  category_id: bigint;
  user_id: bigint;
  lap: bigint;
  boss_index: bigint;
  damage: bigint;
  memo: string;
  attacked: bigint | number | boolean;
  attack_type: string;
  carry_over: bigint | number | boolean;
  created: string | Date;
}

const INSERT_ATTACK_STATUS_SQL = `insert into AttackStatus values (
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

const UPDATE_ATTACK_STATUS_SQL = `update AttackStatus
set
  damage=?,
  memo=?,
  attacked=?,
  attack_type=?,
  carry_over=?
where
  category_id=? and user_id=? and lap=? and boss_index=? and created=?`;

const DELETE_ATTACK_STATUS_SQL = `delete from AttackStatus
where
  category_id=? and user_id=? and lap=? and boss_index=? and created=?`;

const REVERSE_ATTACK_STATUS_SQL = `update AttackStatus
set
  attacked=0
where
  category_id=? and user_id=? and lap=? and boss_index=? and created=?`;

const DELETE_ALL_ATTACK_STATUS_SQL = "delete from AttackStatus where category_id=?";

const SELECT_ALL_ATTACK_STATUS_SQL = "select * from AttackStatus";

function requireAttackType(value: string) {
  const attackType = parseAttackType(value);

  if (!attackType) {
    throw new Error(`unknown attack type: ${value}`);
  }

  return attackType;
}

export class AttackStatusRepository {
  constructor(private readonly database: SqliteDatabase) {}

  insert(categoryId: string, lap: number, bossIndex: number, attackStatus: AttackStatus): void {
    this.database.prepare(INSERT_ATTACK_STATUS_SQL).run(
      encodeSnowflake(categoryId),
      encodeSnowflake(attackStatus.playerData.userId),
      lap,
      bossIndex,
      attackStatus.damage,
      attackStatus.memo,
      encodeSqliteBoolean(attackStatus.attacked),
      attackStatus.attackType,
      encodeSqliteBoolean(attackStatus.carryOver),
      formatSqliteDateTime(attackStatus.created),
    );
  }

  update(categoryId: string, lap: number, bossIndex: number, attackStatus: AttackStatus): void {
    this.database.prepare(UPDATE_ATTACK_STATUS_SQL).run(
      attackStatus.damage,
      attackStatus.memo,
      encodeSqliteBoolean(attackStatus.attacked),
      attackStatus.attackType,
      encodeSqliteBoolean(attackStatus.carryOver),
      encodeSnowflake(categoryId),
      encodeSnowflake(attackStatus.playerData.userId),
      lap,
      bossIndex,
      formatSqliteDateTime(attackStatus.created),
    );
  }

  delete(categoryId: string, lap: number, bossIndex: number, attackStatus: AttackStatus): void {
    this.database.prepare(DELETE_ATTACK_STATUS_SQL).run(
      encodeSnowflake(categoryId),
      encodeSnowflake(attackStatus.playerData.userId),
      lap,
      bossIndex,
      formatSqliteDateTime(attackStatus.created),
    );
  }

  reverse(categoryId: string, lap: number, bossIndex: number, attackStatus: AttackStatus): void {
    this.database.prepare(REVERSE_ATTACK_STATUS_SQL).run(
      encodeSnowflake(categoryId),
      encodeSnowflake(attackStatus.playerData.userId),
      lap,
      bossIndex,
      formatSqliteDateTime(attackStatus.created),
    );
  }

  deleteAllByCategory(categoryId: string): void {
    this.database.prepare(DELETE_ALL_ATTACK_STATUS_SQL).run(encodeSnowflake(categoryId));
  }

  findAllGroupedByCategory(
    playerMapByCategory: ReadonlyMap<string, ReadonlyMap<string, PlayerData>>,
  ): Map<string, Map<number, Map<number, AttackStatus[]>>> {
    const rows = this.database.prepare<[], AttackStatusRow>(SELECT_ALL_ATTACK_STATUS_SQL).all();
    const statusMapByCategory = new Map<string, Map<number, Map<number, AttackStatus[]>>>();

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

      const lap = decodeSqliteInteger(row.lap);
      const bossIndex = decodeSqliteInteger(row.boss_index);
      const categoryStatusMap = statusMapByCategory.get(categoryId) ?? new Map<number, Map<number, AttackStatus[]>>();
      const lapStatusMap = categoryStatusMap.get(lap) ?? new Map<number, AttackStatus[]>();
      const attackStatusList = lapStatusMap.get(bossIndex) ?? [];
      const attackStatus = AttackStatus.fromRecord(
        {
          playerUserId: playerData.userId,
          damage: decodeSqliteInteger(row.damage),
          memo: row.memo,
          attacked: decodeSqliteBoolean(row.attacked),
          attackType: requireAttackType(row.attack_type),
          carryOver: decodeSqliteBoolean(row.carry_over),
          created: parseSqliteDateTime(row.created),
        },
        playerData,
      );

      attackStatusList.push(attackStatus);
      lapStatusMap.set(bossIndex, attackStatusList);
      categoryStatusMap.set(lap, lapStatusMap);
      statusMapByCategory.set(categoryId, categoryStatusMap);
    }

    return statusMapByCategory;
  }
}
