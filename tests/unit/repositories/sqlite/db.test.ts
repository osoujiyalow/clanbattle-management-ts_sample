import { afterEach, describe, expect, it } from "vitest";

import {
  closeSqliteDatabase,
  openSqliteDatabase,
  runInTransaction,
} from "../../../../src/repositories/sqlite/db.js";
import { decodeSnowflake } from "../../../../src/repositories/sqlite/sqlite-codec.js";
import { createTempSqlitePath, type TempSqlitePath } from "./test-sqlite-path.js";

describe("db", () => {
  let tempPath: TempSqlitePath | undefined;

  afterEach(() => {
    tempPath?.cleanup();
    tempPath = undefined;
  });

  it("opens a temp sqlite database and preserves integer precision on reads", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      database.exec("create table snowflakes (id integer primary key, discord_id integer not null)");
      database
        .prepare<[bigint]>("insert into snowflakes (discord_id) values (?)")
        .run(1234567890123456789n);

      const row = database
        .prepare<[], { id: bigint; discord_id: bigint }>("select id, discord_id from snowflakes")
        .get();

      expect(database.open).toBe(true);
      expect(row).toEqual({
        id: 1n,
        discord_id: 1234567890123456789n,
      });
      expect(decodeSnowflake(row!.discord_id)).toBe("1234567890123456789");
    } finally {
      closeSqliteDatabase(database);
    }
  });

  it("commits transactions when the callback succeeds", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      database.exec("create table entries (value text not null)");

      runInTransaction(database, (transactionDb) => {
        transactionDb.prepare<[string]>("insert into entries (value) values (?)").run("ok");
      });

      const row = database.prepare<[], { count: bigint }>("select count(*) as count from entries").get();
      expect(row?.count).toBe(1n);
    } finally {
      closeSqliteDatabase(database);
    }
  });

  it("rolls back transactions when the callback throws", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      database.exec("create table entries (value text not null)");

      expect(() =>
        runInTransaction(database, (transactionDb) => {
          transactionDb.prepare<[string]>("insert into entries (value) values (?)").run("ng");
          throw new Error("boom");
        }),
      ).toThrow("boom");

      const row = database.prepare<[], { count: bigint }>("select count(*) as count from entries").get();
      expect(row?.count).toBe(0n);
    } finally {
      closeSqliteDatabase(database);
    }
  });
});
