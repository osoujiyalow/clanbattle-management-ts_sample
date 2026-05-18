import { afterEach, describe, expect, it } from "vitest";

import { AttackStatus } from "../../../../src/domain/attack-status.js";
import { AttackType } from "../../../../src/domain/attack-type.js";
import { CarryOver, PlayerData } from "../../../../src/domain/player-data.js";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
  runInTransaction,
} from "../../../../src/repositories/sqlite/db.js";
import { AttackStatusRepository } from "../../../../src/repositories/sqlite/attack-status-repository.js";
import { CarryOverRepository } from "../../../../src/repositories/sqlite/carry-over-repository.js";
import { createCoreRepositorySchema } from "./core-repository-schema.js";
import { createTempSqlitePath, type TempSqlitePath } from "./test-sqlite-path.js";

describe("CarryOverRepository", () => {
  let tempPath: TempSqlitePath | undefined;

  afterEach(() => {
    tempPath?.cleanup();
    tempPath = undefined;
  });

  it("loads carry-over rows in oldest-first order with canonical attack types", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new CarryOverRepository(database);
      const newerCarryOver = new CarryOver({
        attackType: AttackType.BATTLE,
        bossIndex: 4,
        created: new Date("2026-03-07T21:34:56.789+09:00"),
      });
      const olderCarryOver = new CarryOver({
        attackType: AttackType.BATTLE,
        bossIndex: 1,
        created: new Date("2026-03-07T18:00:00.000+09:00"),
      });

      repository.insert("200", "300", newerCarryOver);
      repository.insert("200", "300", olderCarryOver);

      const row = database
        .prepare<[], { created: string; attack_type: string }>("select created, attack_type from CarryOver")
        .get();
      expect(row?.created).toBe("2026-03-07 21:34:56.789000+09:00");
      expect(row?.attack_type).toBe(AttackType.BATTLE);

      const grouped = repository.findAllGroupedByCategory(
        new Map([["200", new Map([["300", new PlayerData({ userId: "300" })]])]]),
      );
      const loaded = grouped.get("200")?.get("300");
      expect(loaded).toHaveLength(2);
      expect(loaded?.map((carryOver) => carryOver.created.toISOString())).toEqual([
        "2026-03-07T09:00:00.000Z",
        "2026-03-07T12:34:56.789Z",
      ]);
      expect(loaded?.map((carryOver) => carryOver.bossIndex)).toEqual([1, 4]);
      expect(loaded?.map((carryOver) => carryOver.attackType)).toEqual([
        AttackType.BATTLE,
        AttackType.BATTLE,
      ]);
    } finally {
      closeSqliteDatabase(database);
    }
  });

  it("updates, replaces, and deletes carry-over rows", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new CarryOverRepository(database);
      const carryOver = new CarryOver({
        attackType: AttackType.BATTLE,
        bossIndex: 0,
        created: new Date("2026-03-07T12:00:00+09:00"),
      });

      repository.insert("200", "300", carryOver);
      carryOver.bossIndex = 2;
      carryOver.attackType = AttackType.CARRYOVER;
      repository.update("200", "300", carryOver);

      let row = database
        .prepare<[], { boss_index: bigint; attack_type: string }>(
          "select boss_index, attack_type from CarryOver",
        )
        .get();
      expect(row).toEqual({
        boss_index: 2n,
        attack_type: AttackType.CARRYOVER,
      });

      repository.replaceAll("200", "300", [
        new CarryOver({
          attackType: AttackType.CARRYOVER,
          bossIndex: 1,
          created: new Date("2026-03-07T13:00:00+09:00"),
        }),
      ]);
      row = database
        .prepare<[], { boss_index: bigint; attack_type: string }>(
          "select boss_index, attack_type from CarryOver",
        )
        .get();
      expect(row).toEqual({
        boss_index: 1n,
        attack_type: AttackType.CARRYOVER,
      });

      repository.deleteAllByUser("200", "300");
      const count = database
        .prepare<[], { count: bigint }>("select count(*) as count from CarryOver")
        .get();
      expect(count?.count).toBe(0n);
    } finally {
      closeSqliteDatabase(database);
    }
  });

  it("can be used together with other repositories inside one transaction", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const carryOverRepository = new CarryOverRepository(database);
      const attackStatusRepository = new AttackStatusRepository(database);
      const playerData = new PlayerData({ userId: "300" });
      const carryOver = new CarryOver({
        attackType: AttackType.BATTLE,
        bossIndex: 0,
        created: new Date("2026-03-07T12:00:00+09:00"),
      });
      const attackStatus = new AttackStatus({
        playerData,
        attackType: AttackType.BATTLE,
        carryOver: false,
      });

      expect(() =>
        runInTransaction(database, () => {
          carryOverRepository.insert("200", "300", carryOver);
          attackStatusRepository.insert("200", 1, 0, attackStatus);
          throw new Error("rollback");
        }),
      ).toThrow("rollback");

      const carryOverCount = database
        .prepare<[], { count: bigint }>("select count(*) as count from CarryOver")
        .get();
      const attackCount = database
        .prepare<[], { count: bigint }>("select count(*) as count from AttackStatus")
        .get();

      expect(carryOverCount?.count).toBe(0n);
      expect(attackCount?.count).toBe(0n);
    } finally {
      closeSqliteDatabase(database);
    }
  });
});
