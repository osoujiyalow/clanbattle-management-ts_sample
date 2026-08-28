import { afterEach, describe, expect, it } from "vitest";

import { AttackStatus } from "../../../../src/domain/attack-status.js";
import { AttackType } from "../../../../src/domain/attack-type.js";
import { PlayerData } from "../../../../src/domain/player-data.js";
import { closeSqliteDatabase, openSqliteDatabase } from "../../../../src/repositories/sqlite/db.js";
import { AttackStatusRepository } from "../../../../src/repositories/sqlite/attack-status-repository.js";
import { createCoreRepositorySchema } from "./core-repository-schema.js";
import { createTempSqlitePath, type TempSqlitePath } from "./test-sqlite-path.js";

describe("AttackStatusRepository", () => {
  let tempPath: TempSqlitePath | undefined;

  afterEach(() => {
    tempPath?.cleanup();
    tempPath = undefined;
  });

  it("inserts and loads attack statuses grouped by category, lap, and boss", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new AttackStatusRepository(database);
      const playerData = new PlayerData({ userId: "300" });
      const attackStatus = new AttackStatus({
        playerData,
        attackType: AttackType.BATTLE,
        carryOver: false,
        damage: 3456,
        memo: "finish",
        attacked: true,
        created: new Date("2026-03-07T21:34:56.789+09:00"),
      });

      repository.insert("200", 7, 3, attackStatus);

      const row = database
        .prepare<[], { created: string; attack_type: string }>("select created, attack_type from AttackStatus")
        .get();
      expect(row?.created).toBe("2026-03-07 21:34:56.789000+09:00");
      expect(row?.attack_type).toBe(AttackType.BATTLE);

      const grouped = repository.findAllGroupedByCategory(
        new Map([["200", new Map([["300", playerData]])]]),
      );
      const loaded = grouped.get("200")?.get(7)?.get(3)?.[0];

      expect(loaded?.memo).toBe("finish");
      expect(loaded?.carryOver).toBe(false);
      expect(loaded?.attackType).toBe(AttackType.BATTLE);
      expect(loaded?.created.toISOString()).toBe("2026-03-07T12:34:56.789Z");
    } finally {
      closeSqliteDatabase(database);
    }
  });

  it("updates, reverses, and deletes attack statuses", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new AttackStatusRepository(database);
      const attackStatus = new AttackStatus({
        playerData: new PlayerData({ userId: "300" }),
        attackType: AttackType.BATTLE,
        carryOver: false,
        created: new Date("2026-03-07T12:00:00+09:00"),
      });

      repository.insert("200", 1, 0, attackStatus);
      attackStatus.damage = 999;
      attackStatus.memo = "updated";
      attackStatus.attacked = true;
      attackStatus.carryOver = true;
      repository.update("200", 1, 0, attackStatus);

      let row = database
        .prepare<[], { damage: bigint; memo: string; attacked: bigint; carry_over: bigint }>(
          "select damage, memo, attacked, carry_over from AttackStatus",
        )
        .get();
      expect(row).toEqual({
        damage: 999n,
        memo: "updated",
        attacked: 1n,
        carry_over: 1n,
      });

      repository.reverse("200", 1, 0, attackStatus);
      row = database.prepare<[], { attacked: bigint }>("select attacked from AttackStatus").get();
      expect(row?.attacked).toBe(0n);

      repository.delete("200", 1, 0, attackStatus);
      const count = database
        .prepare<[], { count: bigint }>("select count(*) as count from AttackStatus")
        .get();
      expect(count?.count).toBe(0n);
    } finally {
      closeSqliteDatabase(database);
    }
  });

  it("persists an HP correction by an unmanaged actor across reloads", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new AttackStatusRepository(database);
      repository.insert(
        "200",
        7,
        2,
        new AttackStatus({
          playerData: new PlayerData({ userId: "400" }),
          attackType: AttackType.HP_ADJUSTMENT,
          carryOver: false,
          damage: -500,
          attacked: true,
          created: new Date("2026-03-07T21:34:56.789+09:00"),
        }),
      );

      const loaded = repository.findAllGroupedByCategory(new Map()).get("200")?.get(7)?.get(2)?.[0];
      expect(loaded).toMatchObject({
        attackType: AttackType.HP_ADJUSTMENT,
        damage: -500,
        attacked: true,
        carryOver: false,
      });
      expect(loaded?.playerData.userId).toBe("400");
    } finally {
      closeSqliteDatabase(database);
    }
  });

  it("deletes all statuses for a category", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new AttackStatusRepository(database);

      repository.insert(
        "200",
        1,
        0,
        new AttackStatus({
          playerData: new PlayerData({ userId: "300" }),
          attackType: AttackType.BATTLE,
          carryOver: false,
        }),
      );
      repository.deleteAllByCategory("200");

      const row = database
        .prepare<[], { count: bigint }>("select count(*) as count from AttackStatus")
        .get();
      expect(row?.count).toBe(0n);
    } finally {
      closeSqliteDatabase(database);
    }
  });

  it("rejects duplicate category/user/lap/boss/created rows once the DB-level unique constraint is installed", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new AttackStatusRepository(database);
      const created = new Date("2026-03-07T12:00:00+09:00");

      repository.insert(
        "200",
        1,
        0,
        new AttackStatus({
          playerData: new PlayerData({ userId: "300" }),
          attackType: AttackType.BATTLE,
          carryOver: false,
          created,
        }),
      );

      expect(() =>
        repository.insert(
          "200",
          1,
          0,
          new AttackStatus({
            playerData: new PlayerData({ userId: "300" }),
            attackType: AttackType.CARRYOVER,
            carryOver: true,
            created,
          }),
        ),
      ).toThrowError(/unique/i);
    } finally {
      closeSqliteDatabase(database);
    }
  });

  it("restores attacked rows even after the managed player row has been deleted", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new AttackStatusRepository(database);

      database
        .prepare("insert into AttackStatus values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          200n,
          300n,
          1,
          0,
          123456,
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
          301n,
          1,
          1,
          654321,
          "declared",
          0,
          AttackType.BATTLE,
          0,
          "2026-03-07 12:05:00.000000+09:00",
        );

      const grouped = repository.findAllGroupedByCategory(new Map());

      expect(grouped.get("200")?.get(1)?.get(0)?.[0]?.playerData.userId).toBe("300");
      expect(grouped.get("200")?.get(1)?.get(0)?.[0]?.attacked).toBe(true);
      expect(grouped.get("200")?.get(1)?.get(1)).toBeUndefined();
    } finally {
      closeSqliteDatabase(database);
    }
  });
});
