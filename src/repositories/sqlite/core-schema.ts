import { runInTransaction, type SqliteDatabase } from "./db.js";

const CORE_SCHEMA_SQL = `
create table if not exists ClanData (
  guild_id int,
  category_id int,
  boss1_channel_id int,
  boss2_channel_id int,
  boss3_channel_id int,
  boss4_channel_id int,
  boss5_channel_id int,
  remain_attack_channel_id int,
  reserve_channel_id int,
  command_channel_id int,
  boss1_reserve_message_id int,
  boss2_reserve_message_id int,
  boss3_reserve_message_id int,
  boss4_reserve_message_id int,
  boss5_reserve_message_id int,
  remain_attack_message_id int,
  summary_channel_id int,
  day date
);

create table if not exists PlayerData (
  category_id int,
  user_id int,
  physics_attack int default 0,
  magic_attack int default 0,
  task_kill boolean
);

create table if not exists ReserveData (
  category_id int,
  boss_index int,
  user_id int,
  attack_type varchar,
  damage int,
  memo varchar,
  carry_over boolean
);

create table if not exists AttackStatus (
  category_id int,
  user_id int,
  lap int,
  boss_index int,
  damage int,
  memo varchar,
  attacked boolean,
  attack_type varchar,
  carry_over boolean,
  created datetime
);

create table if not exists BossStatusData (
  category_id int,
  boss_index int,
  lap int,
  beated boolean
);

create table if not exists CarryOver (
  category_id int,
  user_id int,
  boss_index int,
  attack_type varchar,
  carry_over_time int,
  created datetime
);

create table if not exists ProgressMessageIdData (
  category_id int,
  lap int,
  boss1 int,
  boss2 int,
  boss3 int,
  boss4 int,
  boss5 int
);

create table if not exists SummaryMessageIdData (
  category_id int,
  lap int,
  boss1 int,
  boss2 int,
  boss3 int,
  boss4 int,
  boss5 int
);

create table if not exists GuildBossInfoConfig (
  guild_id int primary key,
  hp_json text not null,
  boundaries_json text not null,
  updated_by int,
  updated_at datetime default current_timestamp
);
`;

const CREATE_PLAYER_DATA_UNIQUE_INDEX_SQL = `
create unique index if not exists idx_player_data_category_user
on PlayerData (category_id, user_id)
`;

interface DuplicatePlayerDataRow {
  category_id: bigint;
  user_id: bigint;
  physics_attack: bigint;
  magic_attack: bigint;
  task_kill: bigint;
  keeper_rowid: bigint;
}

const SELECT_DUPLICATE_PLAYER_DATA_SQL = `
select
  category_id,
  user_id,
  max(physics_attack) as physics_attack,
  max(magic_attack) as magic_attack,
  max(task_kill) as task_kill,
  min(rowid) as keeper_rowid
from PlayerData
group by category_id, user_id
having count(*) > 1
`;

const UPDATE_DUPLICATE_PLAYER_DATA_SQL = `
update PlayerData
set
  physics_attack=?,
  magic_attack=?,
  task_kill=?
where
  rowid=?
`;

const DELETE_DUPLICATE_PLAYER_DATA_SQL = `
delete from PlayerData
where
  category_id=? and user_id=? and rowid<>?
`;

function deduplicatePlayerData(database: SqliteDatabase): void {
  runInTransaction(database, () => {
    const duplicateRows = database
      .prepare<[], DuplicatePlayerDataRow>(SELECT_DUPLICATE_PLAYER_DATA_SQL)
      .all();

    for (const duplicateRow of duplicateRows) {
      database.prepare(UPDATE_DUPLICATE_PLAYER_DATA_SQL).run(
        Number(duplicateRow.physics_attack),
        Number(duplicateRow.magic_attack),
        Number(duplicateRow.task_kill),
        duplicateRow.keeper_rowid,
      );
      database.prepare(DELETE_DUPLICATE_PLAYER_DATA_SQL).run(
        duplicateRow.category_id,
        duplicateRow.user_id,
        duplicateRow.keeper_rowid,
      );
    }
  });
}

export function ensureCoreSchema(database: SqliteDatabase): void {
  database.exec(CORE_SCHEMA_SQL);
  deduplicatePlayerData(database);
  database.exec(CREATE_PLAYER_DATA_UNIQUE_INDEX_SQL);
}
