import { afterEach, describe, expect, it } from "vitest";

import { ClanData } from "../../../../src/domain/clan-data.js";
import { ClanRepository } from "../../../../src/repositories/sqlite/clan-repository.js";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
} from "../../../../src/repositories/sqlite/db.js";
import { createCoreRepositorySchema } from "./core-repository-schema.js";
import { createTempSqlitePath, type TempSqlitePath } from "./test-sqlite-path.js";

describe("ClanRepository", () => {
  let tempPath: TempSqlitePath | undefined;

  afterEach(() => {
    tempPath?.cleanup();
    tempPath = undefined;
  });

  it("inserts and loads clan data with string snowflake ids", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new ClanRepository(database);
      const clanData = new ClanData({
        guildId: "123456789012345678",
        categoryId: "223456789012345678",
        bossChannelIds: [
          "323456789012345678",
          "423456789012345678",
          "523456789012345678",
          "623456789012345678",
          "723456789012345678",
        ],
        remainAttackChannelId: "823456789012345678",
        commandChannelId: "103456789012345678",
        summaryChannelId: "113456789012345678",
        remainAttackMessageId: "999888777666555444",
        date: "2026-03-07",
      });

      repository.insert(clanData);
      const loaded = repository.findByCategoryId("223456789012345678");

      expect(loaded).not.toBeNull();
      expect(loaded?.guildId).toBe("123456789012345678");
      expect(loaded?.bossChannelIds[4]).toBe("723456789012345678");
      expect(loaded?.remainAttackMessageId).toBe("999888777666555444");
      expect(typeof loaded?.guildId).toBe("string");
    } finally {
      closeSqliteDatabase(database);
    }
  });

  it("updates remain message id and day", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new ClanRepository(database);
      const clanData = new ClanData({
        guildId: "1",
        categoryId: "2",
        bossChannelIds: ["11", "12", "13", "14", "15"],
        remainAttackChannelId: "16",
        commandChannelId: "18",
        summaryChannelId: "19",
      });

      repository.insert(clanData);
      clanData.remainAttackMessageId = "26";
      clanData.date = "2026-03-08";
      repository.update(clanData);

      const loaded = repository.findByCategoryId("2");
      expect(loaded?.remainAttackMessageId).toBe("26");
      expect(loaded?.date).toBe("2026-03-08");
    } finally {
      closeSqliteDatabase(database);
    }
  });

  it("deletes clan rows by category id", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new ClanRepository(database);
      repository.insert(
        new ClanData({
          guildId: "1",
          categoryId: "2",
          bossChannelIds: ["11", "12", "13", "14", "15"],
          remainAttackChannelId: "16",
          commandChannelId: "18",
          summaryChannelId: "19",
        }),
      );

      repository.delete("2");
      expect(repository.findAll().size).toBe(0);
    } finally {
      closeSqliteDatabase(database);
    }
  });

  it("rejects duplicate category rows once the DB-level unique constraint is installed", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new ClanRepository(database);
      repository.insert(
        new ClanData({
          guildId: "1",
          categoryId: "2",
          bossChannelIds: ["11", "12", "13", "14", "15"],
          remainAttackChannelId: "16",
          commandChannelId: "18",
          summaryChannelId: "19",
        }),
      );

      expect(() =>
        repository.insert(
          new ClanData({
            guildId: "10",
            categoryId: "2",
            bossChannelIds: ["21", "22", "23", "24", "25"],
            remainAttackChannelId: "26",
            commandChannelId: "28",
            summaryChannelId: "29",
          }),
        ),
      ).toThrowError(/unique/i);
    } finally {
      closeSqliteDatabase(database);
    }
  });
});
