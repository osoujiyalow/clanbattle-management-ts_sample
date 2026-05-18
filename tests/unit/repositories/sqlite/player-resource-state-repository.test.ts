import { afterEach, describe, expect, it } from "vitest";

import { PlayerResourceState } from "../../../../src/domain/player-resource-state.js";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
} from "../../../../src/repositories/sqlite/db.js";
import { PlayerResourceStateRepository } from "../../../../src/repositories/sqlite/player-resource-state-repository.js";
import { createCoreRepositorySchema } from "./core-repository-schema.js";
import { createTempSqlitePath, type TempSqlitePath } from "./test-sqlite-path.js";

describe("PlayerResourceStateRepository", () => {
  let tempPath: TempSqlitePath | undefined;

  afterEach(() => {
    tempPath?.cleanup();
    tempPath = undefined;
  });

  it("inserts and loads player resource states", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new PlayerResourceStateRepository(database);
      const playerResourceState = new PlayerResourceState({
        categoryId: "200",
        userId: "300",
        dayKey: "2026-03-28",
        battleReservedCount: 1,
        battleConsumedCount: 2,
        carryAvailableCount: 0,
        carryReservedCount: 1,
      });

      repository.insert(playerResourceState);

      const row = database
        .prepare<[], { battle_consumed_count: bigint }>(
          "select battle_consumed_count from PlayerResourceState",
        )
        .get();
      expect(row?.battle_consumed_count).toBe(2n);
      expect(repository.findByKey("200", "300", "2026-03-28")?.toRecord()).toEqual(
        playerResourceState.toRecord(),
      );
    } finally {
      closeSqliteDatabase(database);
    }
  });

  it("updates, upserts, and deletes player resource states", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new PlayerResourceStateRepository(database);
      const playerResourceState = new PlayerResourceState({
        categoryId: "200",
        userId: "300",
        dayKey: "2026-03-28",
        carryAvailableCount: 1,
      });

      repository.insert(playerResourceState);
      playerResourceState.battleReservedCount = 1;
      playerResourceState.battleConsumedCount = 1;
      repository.update(playerResourceState);
      expect(repository.findByKey("200", "300", "2026-03-28")?.occupiedBattleCount).toBe(2);

      const upserted = new PlayerResourceState({
        categoryId: "200",
        userId: "300",
        dayKey: "2026-03-28",
        carryAvailableCount: 2,
        carryReservedCount: 1,
      });
      repository.upsert(upserted);
      expect(repository.findByKey("200", "300", "2026-03-28")?.toRecord()).toEqual(
        upserted.toRecord(),
      );

      repository.delete("200", "300", "2026-03-28");
      expect(repository.findByKey("200", "300", "2026-03-28")).toBeNull();
    } finally {
      closeSqliteDatabase(database);
    }
  });

  it("deletes all player resource states for a category", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new PlayerResourceStateRepository(database);
      repository.insert(
        new PlayerResourceState({
          categoryId: "200",
          userId: "300",
          dayKey: "2026-03-28",
        }),
      );

      repository.deleteAllByCategory("200");

      const row = database
        .prepare<[], { count: bigint }>("select count(*) as count from PlayerResourceState")
        .get();
      expect(row?.count).toBe(0n);
    } finally {
      closeSqliteDatabase(database);
    }
  });
});
