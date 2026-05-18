import { afterEach, describe, expect, it } from "vitest";

import {
  ResourceAdjustment,
  ResourceAdjustmentType,
} from "../../../../src/domain/resource-adjustment.js";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
} from "../../../../src/repositories/sqlite/db.js";
import { ResourceAdjustmentRepository } from "../../../../src/repositories/sqlite/resource-adjustment-repository.js";
import { createCoreRepositorySchema } from "./core-repository-schema.js";
import { createTempSqlitePath, type TempSqlitePath } from "./test-sqlite-path.js";

describe("ResourceAdjustmentRepository", () => {
  let tempPath: TempSqlitePath | undefined;

  afterEach(() => {
    tempPath?.cleanup();
    tempPath = undefined;
  });

  it("inserts and loads resource adjustments in occurred order", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new ResourceAdjustmentRepository(database);
      repository.insert(
        new ResourceAdjustment({
          adjustmentId: "adjustment-2",
          categoryId: "200",
          userId: "300",
          actorUserId: "400",
          dayKey: "2026-03-29",
          resourceType: ResourceAdjustmentType.CARRYOVER,
          remaining: 1,
          occurredAt: new Date("2026-03-29T12:30:00+09:00"),
        }),
      );
      repository.insert(
        new ResourceAdjustment({
          adjustmentId: "adjustment-1",
          categoryId: "200",
          userId: "300",
          actorUserId: "401",
          dayKey: "2026-03-29",
          resourceType: ResourceAdjustmentType.BATTLE,
          remaining: 2,
          occurredAt: new Date("2026-03-29T12:00:00+09:00"),
        }),
      );

      const row = database
        .prepare<[], { occurred_at: string; resource_type: string; remaining: bigint }>(
          "select occurred_at, resource_type, remaining from ResourceAdjustmentLog where adjustment_id='adjustment-1'",
        )
        .get();
      expect(row).toEqual({
        occurred_at: "2026-03-29 12:00:00.000000+09:00",
        resource_type: ResourceAdjustmentType.BATTLE,
        remaining: 2n,
      });

      const loaded = repository.findAllByCategory("200");
      expect(loaded.map((adjustment) => adjustment.adjustmentId)).toEqual([
        "adjustment-1",
        "adjustment-2",
      ]);
      expect(loaded[0]?.toRecord()).toEqual(
        new ResourceAdjustment({
          adjustmentId: "adjustment-1",
          categoryId: "200",
          userId: "300",
          actorUserId: "401",
          dayKey: "2026-03-29",
          resourceType: ResourceAdjustmentType.BATTLE,
          remaining: 2,
          occurredAt: new Date("2026-03-29T12:00:00+09:00"),
        }).toRecord(),
      );
    } finally {
      closeSqliteDatabase(database);
    }
  });

  it("deletes resource adjustments by user and category", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new ResourceAdjustmentRepository(database);
      repository.insert(
        new ResourceAdjustment({
          adjustmentId: "adjustment-1",
          categoryId: "200",
          userId: "300",
          actorUserId: "400",
          dayKey: "2026-03-29",
          resourceType: ResourceAdjustmentType.BATTLE,
          remaining: 2,
          occurredAt: new Date("2026-03-29T12:00:00+09:00"),
        }),
      );
      repository.insert(
        new ResourceAdjustment({
          adjustmentId: "adjustment-2",
          categoryId: "200",
          userId: "301",
          actorUserId: "400",
          dayKey: "2026-03-29",
          resourceType: ResourceAdjustmentType.CARRYOVER,
          remaining: 1,
          occurredAt: new Date("2026-03-29T12:05:00+09:00"),
        }),
      );

      repository.deleteAllByUser("200", "300");
      expect(repository.findAllByCategory("200").map((adjustment) => adjustment.adjustmentId)).toEqual([
        "adjustment-2",
      ]);

      repository.deleteAllByCategory("200");
      const row = database
        .prepare<[], { count: bigint }>("select count(*) as count from ResourceAdjustmentLog")
        .get();
      expect(row?.count).toBe(0n);
    } finally {
      closeSqliteDatabase(database);
    }
  });
});
