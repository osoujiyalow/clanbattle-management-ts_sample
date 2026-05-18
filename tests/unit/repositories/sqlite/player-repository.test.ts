import { afterEach, describe, expect, it } from "vitest";

import { AttackType } from "../../../../src/domain/attack-type.js";
import { PlayerData } from "../../../../src/domain/player-data.js";
import { closeSqliteDatabase, openSqliteDatabase } from "../../../../src/repositories/sqlite/db.js";
import { PlayerRepository } from "../../../../src/repositories/sqlite/player-repository.js";
import { createCoreRepositorySchema } from "./core-repository-schema.js";
import { createTempSqlitePath, type TempSqlitePath } from "./test-sqlite-path.js";

describe("PlayerRepository", () => {
  let tempPath: TempSqlitePath | undefined;

  afterEach(() => {
    tempPath?.cleanup();
    tempPath = undefined;
  });

  it("inserts and groups players by category", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new PlayerRepository(database);

      repository.insertMany("200", [
        new PlayerData({ userId: "300" }),
        new PlayerData({ userId: "400" }),
      ]);
      repository.insertMany("201", [new PlayerData({ userId: "500" })]);

      const grouped = repository.findAllGroupedByCategory();
      expect(grouped.get("200")?.size).toBe(2);
      expect(grouped.get("200")?.get("300")?.userId).toBe("300");
      expect(typeof grouped.get("201")?.get("500")?.userId).toBe("string");
    } finally {
      closeSqliteDatabase(database);
    }
  });

  it("updates unified battle counts, legacy counters, and task kill flag", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new PlayerRepository(database);
      const playerData = new PlayerData({ userId: "300" });

      repository.insertMany("200", [playerData]);
      playerData.physicsAttack = 1;
      playerData.magicAttack = 2;
      playerData.taskKill = true;
      repository.update("200", playerData);

      const loaded = repository.findByCategoryId("200").get("300");
      const row = database
        .prepare<[], { battle_attack_count: bigint }>(
          "select battle_attack_count from PlayerData where category_id=200 and user_id=300",
        )
        .get();

      expect(loaded?.battleAttackCount).toBe(3);
      expect(loaded?.physicsAttack).toBe(1);
      expect(loaded?.magicAttack).toBe(2);
      expect(loaded?.taskKill).toBe(true);
      expect(row?.battle_attack_count).toBe(3n);
    } finally {
      closeSqliteDatabase(database);
    }
  });

  it("ignores duplicate player inserts for the same category and user", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new PlayerRepository(database);

      repository.insertMany("200", [
        new PlayerData({ userId: "300" }),
        new PlayerData({ userId: "300" }),
      ]);
      repository.insertMany("200", [new PlayerData({ userId: "300" })]);

      const row = database
        .prepare<[], { count: bigint }>(
          "select count(*) as count from PlayerData where category_id=200 and user_id=300",
        )
        .get();

      expect(row?.count).toBe(1n);
      expect(repository.findByCategoryId("200").size).toBe(1);
    } finally {
      closeSqliteDatabase(database);
    }
  });

  it("deletes player rows and related battle-state rows", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new PlayerRepository(database);
      repository.insertMany("200", [new PlayerData({ userId: "300" })]);

      database
        .prepare("insert into AttackStatus values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          200n,
          300n,
          1,
          0,
          100,
          "memo",
          0,
          AttackType.BATTLE,
          0,
          "2026-03-07 12:00:00.000000+09:00",
        );
      database
        .prepare("insert into CarryOver values (?, ?, ?, ?, ?)")
        .run(
          200n,
          300n,
          0,
          AttackType.BATTLE,
          "2026-03-07 12:00:00.000000+09:00",
        );

      repository.delete("200", "300");

      expect(repository.findByCategoryId("200").size).toBe(0);
      expect(database.prepare("select count(*) as count from AttackStatus").get()).toEqual({ count: 0n });
      expect(database.prepare("select count(*) as count from CarryOver").get()).toEqual({ count: 0n });
    } finally {
      closeSqliteDatabase(database);
    }
  });

  it("can preserve resolved attack history while deleting active battle-state rows", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new PlayerRepository(database);
      repository.insertMany("200", [new PlayerData({ userId: "300" })]);

      database
        .prepare("insert into AttackStatus values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          200n,
          300n,
          1,
          0,
          100,
          "resolved",
          1,
          AttackType.BATTLE,
          0,
          "2026-03-07 12:00:00.000000+09:00",
        );
      database
        .prepare("insert into AttackStatus values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          200n,
          300n,
          1,
          1,
          200,
          "declared",
          0,
          AttackType.BATTLE,
          0,
          "2026-03-07 12:05:00.000000+09:00",
        );
      database
        .prepare("insert into CarryOver values (?, ?, ?, ?, ?)")
        .run(
          200n,
          300n,
          0,
          AttackType.BATTLE,
          "2026-03-07 12:00:00.000000+09:00",
        );

      repository.delete("200", "300", { preserveResolvedAttackStatuses: true });

      expect(repository.findByCategoryId("200").size).toBe(0);
      expect(
        database.prepare("select count(*) as count from AttackStatus where attacked=1").get(),
      ).toEqual({ count: 1n });
      expect(
        database.prepare("select count(*) as count from AttackStatus where attacked=0").get(),
      ).toEqual({ count: 0n });
      expect(database.prepare("select count(*) as count from CarryOver").get()).toEqual({ count: 0n });
    } finally {
      closeSqliteDatabase(database);
    }
  });
});
