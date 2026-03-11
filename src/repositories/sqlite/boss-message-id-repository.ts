import type { SqliteDatabase } from "./db.js";
import {
  decodeOptionalSnowflake,
  decodeSnowflake,
  decodeSqliteInteger,
  encodeOptionalSnowflake,
  encodeSnowflake,
} from "./sqlite-codec.js";

export type BossMessageIds = [string | null, string | null, string | null, string | null, string | null];

interface BossMessageIdRow {
  category_id: bigint;
  lap: bigint;
  boss1: bigint | null;
  boss2: bigint | null;
  boss3: bigint | null;
  boss4: bigint | null;
  boss5: bigint | null;
}

function normalizeBossMessageIds(messageIds: readonly (string | null)[]): BossMessageIds {
  return [
    messageIds[0] ?? null,
    messageIds[1] ?? null,
    messageIds[2] ?? null,
    messageIds[3] ?? null,
    messageIds[4] ?? null,
  ];
}

function mapRowToBossMessageIds(row: BossMessageIdRow): BossMessageIds {
  return normalizeBossMessageIds([
    decodeOptionalSnowflake(row.boss1),
    decodeOptionalSnowflake(row.boss2),
    decodeOptionalSnowflake(row.boss3),
    decodeOptionalSnowflake(row.boss4),
    decodeOptionalSnowflake(row.boss5),
  ]);
}

abstract class BaseBossMessageIdRepository {
  constructor(
    protected readonly database: SqliteDatabase,
    private readonly tableName: "ProgressMessageIdData" | "SummaryMessageIdData",
  ) {}

  insert(categoryId: string, lap: number, messageIds: readonly (string | null)[]): void {
    const normalized = normalizeBossMessageIds(messageIds);
    this.database
      .prepare(
        `insert into ${this.tableName} values (
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?
        )`,
      )
      .run(encodeSnowflake(categoryId), lap, ...normalized.map(encodeOptionalSnowflake));
  }

  update(categoryId: string, lap: number, messageIds: readonly (string | null)[]): void {
    const normalized = normalizeBossMessageIds(messageIds);
    this.database
      .prepare(
        `update ${this.tableName}
         set
           boss1=?,
           boss2=?,
           boss3=?,
           boss4=?,
           boss5=?
         where
           category_id=? and lap=?`,
      )
      .run(...normalized.map(encodeOptionalSnowflake), encodeSnowflake(categoryId), lap);
  }

  deleteByLap(categoryId: string, lap: number): void {
    this.database
      .prepare(`delete from ${this.tableName} where category_id=? and lap=?`)
      .run(encodeSnowflake(categoryId), lap);
  }

  deleteAllByCategory(categoryId: string): void {
    this.database
      .prepare(`delete from ${this.tableName} where category_id=?`)
      .run(encodeSnowflake(categoryId));
  }

  findByCategoryId(categoryId: string): Map<number, BossMessageIds> {
    return this.findAllGroupedByCategory().get(categoryId) ?? new Map<number, BossMessageIds>();
  }

  findAllGroupedByCategory(): Map<string, Map<number, BossMessageIds>> {
    const rows = this.database.prepare<[], BossMessageIdRow>(`select * from ${this.tableName}`).all();
    const messageIdMapByCategory = new Map<string, Map<number, BossMessageIds>>();

    for (const row of rows) {
      const categoryId = decodeSnowflake(row.category_id);
      const lap = decodeSqliteInteger(row.lap);
      const messageIdMapByLap =
        messageIdMapByCategory.get(categoryId) ?? new Map<number, BossMessageIds>();
      messageIdMapByLap.set(lap, mapRowToBossMessageIds(row));
      messageIdMapByCategory.set(categoryId, messageIdMapByLap);
    }

    return messageIdMapByCategory;
  }
}

export class ProgressMessageIdRepository extends BaseBossMessageIdRepository {
  constructor(database: SqliteDatabase) {
    super(database, "ProgressMessageIdData");
  }
}

export class SummaryMessageIdRepository extends BaseBossMessageIdRepository {
  constructor(database: SqliteDatabase) {
    super(database, "SummaryMessageIdData");
  }
}
