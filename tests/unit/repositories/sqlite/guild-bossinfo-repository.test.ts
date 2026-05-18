import { afterEach, describe, expect, it } from "vitest";

import { GuildBossInfoConfig } from "../../../../src/domain/guild-bossinfo-config.js";
import { GuildBossInfoRepository } from "../../../../src/repositories/sqlite/guild-bossinfo-repository.js";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
} from "../../../../src/repositories/sqlite/db.js";
import { createTempSqlitePath, type TempSqlitePath } from "./test-sqlite-path.js";

describe("GuildBossInfoRepository", () => {
  let tempPath: TempSqlitePath | undefined;

  afterEach(() => {
    tempPath?.cleanup();
    tempPath = undefined;
  });

  it("upserts and loads guild bossinfo config", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      const repository = new GuildBossInfoRepository(database);
      repository.upsert(
        "123456789012345678",
        new GuildBossInfoConfig({
          hp: [
            [100, 200, 300, 400, 500],
            [600, 700, 800, 900, 1000],
          ],
          boundaries: [
            [1, 2],
            [3, -1],
          ],
        }),
        "999999999999999999",
      );

      const loaded = repository.loadAll();
      expect(loaded.get("123456789012345678")?.hp[1]?.[4]).toBe(1000);
      expect(loaded.get("123456789012345678")?.boundaries).toEqual([
        [1, 2],
        [3, -1],
      ]);
    } finally {
      closeSqliteDatabase(database);
    }
  });

  it("deletes guild bossinfo config by guild id", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      const repository = new GuildBossInfoRepository(database);
      repository.upsert(
        "1",
        new GuildBossInfoConfig({
          hp: [[1, 2, 3, 4, 5]],
          boundaries: [[1, -1]],
        }),
      );

      repository.delete("1");
      expect(repository.loadAll().size).toBe(0);
    } finally {
      closeSqliteDatabase(database);
    }
  });
});
