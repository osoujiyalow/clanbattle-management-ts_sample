import { afterEach, describe, expect, it } from "vitest";

import {
  ProgressMessageIdRepository,
  SummaryMessageIdRepository,
} from "../../../../src/repositories/sqlite/boss-message-id-repository.js";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
  type SqliteDatabase,
} from "../../../../src/repositories/sqlite/db.js";
import { createCoreRepositorySchema } from "./core-repository-schema.js";
import { createTempSqlitePath, type TempSqlitePath } from "./test-sqlite-path.js";

describe("boss message id repositories", () => {
  let tempPath: TempSqlitePath | undefined;
  let database: SqliteDatabase | undefined;

  afterEach(() => {
    if (database) {
      closeSqliteDatabase(database);
      database = undefined;
    }

    tempPath?.cleanup();
    tempPath = undefined;
  });

  it("stores and loads progress message ids grouped by category and lap", () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const repository = new ProgressMessageIdRepository(database);
    repository.insert("123456789012345678", 1, ["1", "2", null, null, null]);
    repository.update("123456789012345678", 1, ["10", "20", "30", null, null]);

    expect(repository.findByCategoryId("123456789012345678").get(1)).toEqual([
      "10",
      "20",
      "30",
      null,
      null,
    ]);
  });

  it("stores and loads summary message ids grouped by category and lap", () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const repository = new SummaryMessageIdRepository(database);
    repository.insert("223456789012345678", 7, ["11", null, null, null, null]);

    expect(repository.findAllGroupedByCategory().get("223456789012345678")?.get(7)).toEqual([
      "11",
      null,
      null,
      null,
      null,
    ]);
  });

  it("rejects duplicate progress message rows for the same category and lap", () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const repository = new ProgressMessageIdRepository(database);
    repository.insert("123456789012345678", 1, ["1", null, null, null, null]);

    expect(() =>
      repository.insert("123456789012345678", 1, ["2", null, null, null, null]),
    ).toThrowError(/unique/i);
  });

  it("rejects duplicate summary message rows for the same category and lap", () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const repository = new SummaryMessageIdRepository(database);
    repository.insert("223456789012345678", 7, ["11", null, null, null, null]);

    expect(() =>
      repository.insert("223456789012345678", 7, ["12", null, null, null, null]),
    ).toThrowError(/unique/i);
  });
});
