import { afterEach, describe, expect, it } from "vitest";

import {
  AttackEntry,
  AttackEntryKind,
  AttackEntryStatus,
} from "../../../../src/domain/attack-entry.js";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
} from "../../../../src/repositories/sqlite/db.js";
import { AttackEntryRepository } from "../../../../src/repositories/sqlite/attack-entry-repository.js";
import { createCoreRepositorySchema } from "./core-repository-schema.js";
import { createTempSqlitePath, type TempSqlitePath } from "./test-sqlite-path.js";

describe("AttackEntryRepository", () => {
  let tempPath: TempSqlitePath | undefined;

  afterEach(() => {
    tempPath?.cleanup();
    tempPath = undefined;
  });

  it("inserts and loads attack entries in declared order", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new AttackEntryRepository(database);
      repository.insert(
        new AttackEntry({
          attackEntryId: "attack-2",
          categoryId: "200",
          userId: "300",
          dayKey: "2026-03-28",
          lap: 4,
          bossIndex: 2,
          kind: AttackEntryKind.CARRYOVER,
          status: AttackEntryStatus.DECLARED,
          declaredAt: new Date("2026-03-28T12:30:00+09:00"),
        }),
      );
      repository.insert(
        new AttackEntry({
          attackEntryId: "attack-1",
          categoryId: "200",
          userId: "300",
          dayKey: "2026-03-28",
          lap: 4,
          bossIndex: 1,
          kind: AttackEntryKind.BATTLE,
          status: AttackEntryStatus.FINISHED,
          declaredAt: new Date("2026-03-28T12:00:00+09:00"),
          resolvedAt: new Date("2026-03-28T12:05:00+09:00"),
          damage: 1_234_567,
          memo: "finish",
        }),
      );

      const row = database
        .prepare<[], { declared_at: string; kind: string }>(
          "select declared_at, kind from AttackEntry where attack_entry_id='attack-1'",
        )
        .get();
      expect(row).toEqual({
        declared_at: "2026-03-28 12:00:00.000000+09:00",
        kind: AttackEntryKind.BATTLE,
      });

      const loaded = repository.findAllByCategory("200");
      expect(loaded.map((attackEntry) => attackEntry.attackEntryId)).toEqual(["attack-1", "attack-2"]);
      expect(loaded[0]?.resolvedAt?.toISOString()).toBe("2026-03-28T03:05:00.000Z");
      expect(loaded[0]?.damage).toBe(1_234_567);
    } finally {
      closeSqliteDatabase(database);
    }
  });

  it("updates and deletes attack entries", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new AttackEntryRepository(database);
      const attackEntry = new AttackEntry({
        attackEntryId: "attack-1",
        categoryId: "200",
        userId: "300",
        dayKey: "2026-03-28",
        lap: 4,
        bossIndex: 0,
        kind: AttackEntryKind.BATTLE,
        status: AttackEntryStatus.DECLARED,
        declaredAt: new Date("2026-03-28T12:00:00+09:00"),
      });

      repository.insert(attackEntry);
      attackEntry.kind = AttackEntryKind.CARRYOVER;
      attackEntry.status = AttackEntryStatus.DEFEATED;
      attackEntry.resolvedAt = new Date("2026-03-28T12:03:00+09:00");
      attackEntry.damage = 765_432;
      attackEntry.memo = "defeat";
      repository.update(attackEntry);

      const loaded = repository.findById("attack-1");
      expect(loaded?.toRecord()).toEqual(attackEntry.toRecord());

      repository.delete("attack-1");
      expect(repository.findById("attack-1")).toBeNull();
    } finally {
      closeSqliteDatabase(database);
    }
  });

  it("deletes all attack entries for a category", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new AttackEntryRepository(database);
      repository.insert(
        new AttackEntry({
          attackEntryId: "attack-1",
          categoryId: "200",
          userId: "300",
          dayKey: "2026-03-28",
          lap: 4,
          bossIndex: 0,
          kind: AttackEntryKind.BATTLE,
          status: AttackEntryStatus.DECLARED,
          declaredAt: new Date("2026-03-28T12:00:00+09:00"),
        }),
      );

      repository.deleteAllByCategory("200");

      const row = database
        .prepare<[], { count: bigint }>("select count(*) as count from AttackEntry")
        .get();
      expect(row?.count).toBe(0n);
    } finally {
      closeSqliteDatabase(database);
    }
  });
});
