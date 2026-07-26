import type { SqliteDatabase } from "./db.js";
import { decodeSnowflake, encodeSnowflake } from "./sqlite-codec.js";

interface ActiveAttackerRoleConfigRow {
  role_id: bigint;
}

const SELECT_ROLE_ID_SQL =
  "select role_id from ActiveAttackerRoleConfig where category_id=?";
const UPSERT_ROLE_ID_SQL = `
insert into ActiveAttackerRoleConfig (category_id, role_id)
values (?, ?)
on conflict(category_id) do update set role_id=excluded.role_id
`;
const DELETE_ROLE_ID_SQL =
  "delete from ActiveAttackerRoleConfig where category_id=?";

export class ActiveAttackerRoleRepository {
  constructor(private readonly database: SqliteDatabase) {}

  findRoleId(categoryId: string): string | null {
    const row = this.database
      .prepare<[bigint], ActiveAttackerRoleConfigRow>(SELECT_ROLE_ID_SQL)
      .get(encodeSnowflake(categoryId));
    return row ? decodeSnowflake(row.role_id) : null;
  }

  upsert(categoryId: string, roleId: string): void {
    this.database
      .prepare(UPSERT_ROLE_ID_SQL)
      .run(encodeSnowflake(categoryId), encodeSnowflake(roleId));
  }

  delete(categoryId: string): void {
    this.database.prepare(DELETE_ROLE_ID_SQL).run(encodeSnowflake(categoryId));
  }
}
