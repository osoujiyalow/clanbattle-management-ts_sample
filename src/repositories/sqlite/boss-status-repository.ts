import { BossStatusData } from "../../domain/boss-status-data.js";
import type { ClanData } from "../../domain/clan-data.js";
import type { SqliteDatabase } from "./db.js";
import {
  decodeSnowflake,
  decodeSqliteBoolean,
  decodeSqliteInteger,
  encodeSnowflake,
  encodeSqliteBoolean,
} from "./sqlite-codec.js";

interface BossStatusDataRow {
  category_id: bigint;
  boss_index: bigint;
  lap: bigint;
  beated: bigint | number | boolean;
}

const INSERT_BOSS_STATUS_DATA_SQL = `insert into BossStatusData values (
  ?,
  ?,
  ?,
  ?
)`;

const UPDATE_BOSS_STATUS_DATA_SQL = `update BossStatusData
set
  beated=?
where
  category_id=? and boss_index=? and lap=?`;

const DELETE_BOSS_STATUS_DATA_SQL = `delete from BossStatusData
where
  category_id=? and boss_index=?`;

const DELETE_ALL_BOSS_STATUS_DATA_SQL = `delete from BossStatusData
where
  category_id=?`;

const SELECT_ALL_BOSS_STATUS_DATA_SQL = "select * from BossStatusData";

export class BossStatusRepository {
  constructor(private readonly database: SqliteDatabase) {}

  insert(categoryId: string, bossStatusData: BossStatusData): void {
    this.database.prepare(INSERT_BOSS_STATUS_DATA_SQL).run(
      encodeSnowflake(categoryId),
      bossStatusData.bossIndex,
      bossStatusData.lap,
      encodeSqliteBoolean(bossStatusData.beated),
    );
  }

  insertAllForLap(categoryId: string, bossStatusList: readonly BossStatusData[]): void {
    const statement = this.database.prepare(INSERT_BOSS_STATUS_DATA_SQL);

    for (const bossStatusData of bossStatusList) {
      statement.run(
        encodeSnowflake(categoryId),
        bossStatusData.bossIndex,
        bossStatusData.lap,
        encodeSqliteBoolean(bossStatusData.beated),
      );
    }
  }

  update(categoryId: string, bossStatusData: BossStatusData): void {
    this.database.prepare(UPDATE_BOSS_STATUS_DATA_SQL).run(
      encodeSqliteBoolean(bossStatusData.beated),
      encodeSnowflake(categoryId),
      bossStatusData.bossIndex,
      bossStatusData.lap,
    );
  }

  deleteByBossIndex(categoryId: string, bossIndex: number): void {
    this.database.prepare(DELETE_BOSS_STATUS_DATA_SQL).run(encodeSnowflake(categoryId), bossIndex);
  }

  deleteAllByCategory(categoryId: string): void {
    this.database.prepare(DELETE_ALL_BOSS_STATUS_DATA_SQL).run(encodeSnowflake(categoryId));
  }

  findAllGroupedByCategory(
    clanMap: ReadonlyMap<string, ClanData>,
  ): Map<string, Map<number, BossStatusData[]>> {
    const rows = this.database.prepare<[], BossStatusDataRow>(SELECT_ALL_BOSS_STATUS_DATA_SQL).all();
    const bossStatusMapByCategory = new Map<string, Map<number, BossStatusData[]>>();

    for (const row of rows) {
      const categoryId = decodeSnowflake(row.category_id);
      const clanData = clanMap.get(categoryId);

      if (!clanData) {
        continue;
      }

      const lap = decodeSqliteInteger(row.lap);
      const bossIndex = decodeSqliteInteger(row.boss_index);
      const categoryBossStatusMap = bossStatusMapByCategory.get(categoryId) ?? new Map<number, BossStatusData[]>();
      const bossStatusList =
        categoryBossStatusMap.get(lap) ??
        Array.from({ length: clanData.bossChannelIds.length }, (_, index) =>
          new BossStatusData({
            lap,
            bossIndex: index,
            guildId: clanData.guildId,
          }),
        );

      bossStatusList[bossIndex] = new BossStatusData({
        lap,
        bossIndex,
        guildId: clanData.guildId,
        beated: decodeSqliteBoolean(row.beated),
      });

      categoryBossStatusMap.set(lap, bossStatusList);
      bossStatusMapByCategory.set(categoryId, categoryBossStatusMap);
    }

    return bossStatusMapByCategory;
  }
}
