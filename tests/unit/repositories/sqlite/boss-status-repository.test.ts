import { afterEach, describe, expect, it } from "vitest";

import { BossStatusData } from "../../../../src/domain/boss-status-data.js";
import { ClanData } from "../../../../src/domain/clan-data.js";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
} from "../../../../src/repositories/sqlite/db.js";
import { BossStatusRepository } from "../../../../src/repositories/sqlite/boss-status-repository.js";
import { createCoreRepositorySchema } from "./core-repository-schema.js";
import { createTempSqlitePath, type TempSqlitePath } from "./test-sqlite-path.js";

describe("BossStatusRepository", () => {
  let tempPath: TempSqlitePath | undefined;

  afterEach(() => {
    tempPath?.cleanup();
    tempPath = undefined;
  });

  function createClanData(): ClanData {
    return new ClanData({
      guildId: "100",
      categoryId: "200",
      bossChannelIds: ["11", "12", "13", "14", "15"],
      remainAttackChannelId: "16",
      commandChannelId: "18",
      summaryChannelId: "19",
    });
  }

  it("inserts and loads boss status by lap", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new BossStatusRepository(database);
      const clanData = createClanData();

      repository.insertAllForLap("200", [
        new BossStatusData({ lap: 7, bossIndex: 0, guildId: "100", beated: false }),
        new BossStatusData({ lap: 7, bossIndex: 1, guildId: "100", beated: true }),
      ]);

      const grouped = repository.findAllGroupedByCategory(new Map([["200", clanData]]));
      expect(grouped.get("200")?.get(7)?.[0]?.maxHp).toBe(5000);
      expect(grouped.get("200")?.get(7)?.[1]?.beated).toBe(true);
    } finally {
      closeSqliteDatabase(database);
    }
  });

  it("updates and deletes boss status rows", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new BossStatusRepository(database);
      const bossStatusData = new BossStatusData({
        lap: 1,
        bossIndex: 2,
        guildId: "100",
        beated: false,
      });

      repository.insert("200", bossStatusData);
      bossStatusData.beated = true;
      repository.update("200", bossStatusData);

      let row = database
        .prepare<[], { beated: bigint }>("select beated from BossStatusData")
        .get();
      expect(row?.beated).toBe(1n);

      repository.deleteByBossIndex("200", 2);
      row = database
        .prepare<[], { count: bigint }>("select count(*) as count from BossStatusData")
        .get();
      expect(row?.count).toBe(0n);
    } finally {
      closeSqliteDatabase(database);
    }
  });

  it("deletes all boss status rows for a category", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new BossStatusRepository(database);

      repository.insert("200", new BossStatusData({ lap: 1, bossIndex: 0, guildId: "100" }));
      repository.insert("200", new BossStatusData({ lap: 2, bossIndex: 1, guildId: "100" }));
      repository.deleteAllByCategory("200");

      const row = database
        .prepare<[], { count: bigint }>("select count(*) as count from BossStatusData")
        .get();
      expect(row?.count).toBe(0n);
    } finally {
      closeSqliteDatabase(database);
    }
  });

  it("rejects duplicate category/lap/boss rows once the DB-level unique constraint is installed", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new BossStatusRepository(database);

      repository.insert("200", new BossStatusData({ lap: 1, bossIndex: 0, guildId: "100" }));

      expect(() =>
        repository.insert("200", new BossStatusData({ lap: 1, bossIndex: 0, guildId: "100" })),
      ).toThrowError(/unique/i);
    } finally {
      closeSqliteDatabase(database);
    }
  });
});
