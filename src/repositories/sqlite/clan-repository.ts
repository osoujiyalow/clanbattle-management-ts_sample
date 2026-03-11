import type { SqliteDatabase } from "./db.js";
import {
  decodeOptionalSnowflake,
  decodeSnowflake,
  encodeOptionalSnowflake,
  encodeSnowflake,
} from "./sqlite-codec.js";
import { normalizeSqliteDate } from "./sqlite-time.js";
import { ClanData } from "../../domain/clan-data.js";

interface ClanDataRow {
  guild_id: bigint;
  category_id: bigint;
  boss1_channel_id: bigint;
  boss2_channel_id: bigint;
  boss3_channel_id: bigint;
  boss4_channel_id: bigint;
  boss5_channel_id: bigint;
  remain_attack_channel_id: bigint;
  reserve_channel_id: bigint;
  command_channel_id: bigint;
  boss1_reserve_message_id: bigint | null;
  boss2_reserve_message_id: bigint | null;
  boss3_reserve_message_id: bigint | null;
  boss4_reserve_message_id: bigint | null;
  boss5_reserve_message_id: bigint | null;
  remain_attack_message_id: bigint | null;
  summary_channel_id: bigint;
  day: string;
}

const INSERT_CLAN_DATA_SQL = `insert into ClanData values (
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
  ?,
  ?,
  ?,
  ?,
  ?
)`;

const UPDATE_CLAN_DATA_SQL = `update ClanData
set
  reserve_channel_id=?,
  boss1_reserve_message_id=?,
  boss2_reserve_message_id=?,
  boss3_reserve_message_id=?,
  boss4_reserve_message_id=?,
  boss5_reserve_message_id=?,
  remain_attack_message_id=?,
  day=?
where
  category_id=?`;

const DELETE_CLAN_DATA_SQL = "delete from ClanData where category_id=?";

const SELECT_ALL_CLAN_DATA_SQL = "select * from ClanData";

function mapClanDataRowToDomain(row: ClanDataRow): ClanData {
  return ClanData.fromRecord({
    guildId: decodeSnowflake(row.guild_id),
    categoryId: decodeSnowflake(row.category_id),
    bossChannelIds: [
      decodeSnowflake(row.boss1_channel_id),
      decodeSnowflake(row.boss2_channel_id),
      decodeSnowflake(row.boss3_channel_id),
      decodeSnowflake(row.boss4_channel_id),
      decodeSnowflake(row.boss5_channel_id),
    ],
    remainAttackChannelId: decodeSnowflake(row.remain_attack_channel_id),
    reserveChannelId: decodeSnowflake(row.reserve_channel_id),
    commandChannelId: decodeSnowflake(row.command_channel_id),
    summaryChannelId: decodeSnowflake(row.summary_channel_id),
    reserveMessageIds: [
      decodeOptionalSnowflake(row.boss1_reserve_message_id),
      decodeOptionalSnowflake(row.boss2_reserve_message_id),
      decodeOptionalSnowflake(row.boss3_reserve_message_id),
      decodeOptionalSnowflake(row.boss4_reserve_message_id),
      decodeOptionalSnowflake(row.boss5_reserve_message_id),
    ],
    remainAttackMessageId: decodeOptionalSnowflake(row.remain_attack_message_id),
    progressMessageIdsByLap: {},
    summaryMessageIdsByLap: {},
    date: normalizeSqliteDate(row.day),
  });
}

export class ClanRepository {
  constructor(private readonly database: SqliteDatabase) {}

  insert(clanData: ClanData): void {
    const record = clanData.toRecord();

    this.database.prepare(INSERT_CLAN_DATA_SQL).run(
      encodeSnowflake(record.guildId),
      encodeSnowflake(record.categoryId),
      ...record.bossChannelIds.map(encodeSnowflake),
      encodeSnowflake(record.remainAttackChannelId),
      encodeSnowflake(record.reserveChannelId),
      encodeSnowflake(record.commandChannelId),
      ...record.reserveMessageIds.map(encodeOptionalSnowflake),
      encodeOptionalSnowflake(record.remainAttackMessageId),
      encodeSnowflake(record.summaryChannelId),
      normalizeSqliteDate(record.date),
    );
  }

  update(clanData: ClanData): void {
    const record = clanData.toRecord();

    this.database.prepare(UPDATE_CLAN_DATA_SQL).run(
      encodeSnowflake(record.reserveChannelId),
      ...record.reserveMessageIds.map(encodeOptionalSnowflake),
      encodeOptionalSnowflake(record.remainAttackMessageId),
      normalizeSqliteDate(record.date),
      encodeSnowflake(record.categoryId),
    );
  }

  delete(categoryId: string): void {
    this.database.prepare(DELETE_CLAN_DATA_SQL).run(encodeSnowflake(categoryId));
  }

  findAll(): Map<string, ClanData> {
    const rows = this.database.prepare<[], ClanDataRow>(SELECT_ALL_CLAN_DATA_SQL).all();
    const clanMap = new Map<string, ClanData>();

    for (const row of rows) {
      const clanData = mapClanDataRowToDomain(row);
      clanMap.set(clanData.categoryId, clanData);
    }

    return clanMap;
  }

  findByCategoryId(categoryId: string): ClanData | null {
    return this.findAll().get(categoryId) ?? null;
  }
}
