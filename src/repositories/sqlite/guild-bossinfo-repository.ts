import { GuildBossInfoConfig } from "../../domain/guild-bossinfo-config.js";
import type { SqliteDatabase } from "./db.js";
import { decodeSnowflake, encodeOptionalSnowflake, encodeSnowflake } from "./sqlite-codec.js";

interface GuildBossInfoConfigRow {
  guild_id: bigint;
  hp_json: string;
  boundaries_json: string;
}

const CREATE_GUILD_BOSSINFO_CONFIG_TABLE_SQL = `
create table if not exists GuildBossInfoConfig (
  guild_id integer primary key,
  hp_json text not null,
  boundaries_json text not null,
  updated_by integer,
  updated_at datetime default current_timestamp
)`;

const UPSERT_GUILD_BOSSINFO_CONFIG_SQL = `
insert into GuildBossInfoConfig (guild_id, hp_json, boundaries_json, updated_by, updated_at)
values (?, ?, ?, ?, current_timestamp)
on conflict(guild_id) do update set
  hp_json=excluded.hp_json,
  boundaries_json=excluded.boundaries_json,
  updated_by=excluded.updated_by,
  updated_at=current_timestamp
`;

const DELETE_GUILD_BOSSINFO_CONFIG_SQL = "delete from GuildBossInfoConfig where guild_id=?";

const SELECT_GUILD_BOSSINFO_CONFIG_SQL = `
select guild_id, hp_json, boundaries_json
from GuildBossInfoConfig
`;

function parseConfigRow(row: GuildBossInfoConfigRow): GuildBossInfoConfig {
  const hp = JSON.parse(row.hp_json) as number[][];
  const boundaries = JSON.parse(row.boundaries_json) as [number, number][];

  return new GuildBossInfoConfig({
    hp: hp.map((phase) => phase.map((value) => Number.parseInt(String(value), 10))),
    boundaries: boundaries.map(([start, end]) => [
      Number.parseInt(String(start), 10),
      Number.parseInt(String(end), 10),
    ]),
  });
}

export class GuildBossInfoRepository {
  constructor(private readonly database: SqliteDatabase) {}

  ensureTable(): void {
    this.database.exec(CREATE_GUILD_BOSSINFO_CONFIG_TABLE_SQL);
  }

  loadAll(): Map<string, GuildBossInfoConfig> {
    this.ensureTable();
    const rows = this.database
      .prepare<[], GuildBossInfoConfigRow>(SELECT_GUILD_BOSSINFO_CONFIG_SQL)
      .all();
    const configMap = new Map<string, GuildBossInfoConfig>();

    for (const row of rows) {
      configMap.set(decodeSnowflake(row.guild_id), parseConfigRow(row));
    }

    return configMap;
  }

  upsert(guildId: string, config: GuildBossInfoConfig, updatedBy?: string | null): void {
    this.ensureTable();
    this.database.prepare(UPSERT_GUILD_BOSSINFO_CONFIG_SQL).run(
      encodeSnowflake(guildId),
      JSON.stringify(config.hp),
      JSON.stringify(config.boundaries),
      encodeOptionalSnowflake(updatedBy),
    );
  }

  delete(guildId: string): void {
    this.ensureTable();
    this.database.prepare(DELETE_GUILD_BOSSINFO_CONFIG_SQL).run(encodeSnowflake(guildId));
  }
}
