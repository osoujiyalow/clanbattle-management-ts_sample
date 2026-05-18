import { afterEach, describe, expect, it } from "vitest";

import {
  AttackEntryKind,
  AttackEntryStatus,
} from "../../../../src/domain/attack-entry.js";
import {
  OperationLog,
  OperationLogType,
} from "../../../../src/domain/operation-log.js";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
} from "../../../../src/repositories/sqlite/db.js";
import { OperationLogRepository } from "../../../../src/repositories/sqlite/operation-log-repository.js";
import { createCoreRepositorySchema } from "./core-repository-schema.js";
import { createTempSqlitePath, type TempSqlitePath } from "./test-sqlite-path.js";

describe("OperationLogRepository", () => {
  let tempPath: TempSqlitePath | undefined;

  afterEach(() => {
    tempPath?.cleanup();
    tempPath = undefined;
  });

  it("inserts and loads operation logs in occurred order", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new OperationLogRepository(database);
      repository.insert(
        new OperationLog({
          operationId: "operation-2",
          categoryId: "200",
          userId: "300",
          dayKey: "2026-03-28",
          lap: 4,
          bossIndex: 2,
          targetAttackEntryId: "attack-2",
          operationType: OperationLogType.DECLARE,
          afterKind: AttackEntryKind.CARRYOVER,
          afterStatus: AttackEntryStatus.DECLARED,
          occurredAt: new Date("2026-03-28T12:30:00+09:00"),
        }),
      );
      repository.insert(
        new OperationLog({
          operationId: "operation-1",
          categoryId: "200",
          userId: "300",
          dayKey: "2026-03-28",
          lap: 4,
          bossIndex: 1,
          targetAttackEntryId: "attack-1",
          operationType: OperationLogType.CORRECT_KIND,
          beforeKind: AttackEntryKind.BATTLE,
          afterKind: AttackEntryKind.CARRYOVER,
          beforeStatus: AttackEntryStatus.FINISHED,
          afterStatus: AttackEntryStatus.FINISHED,
          occurredAt: new Date("2026-03-28T12:00:00+09:00"),
        }),
      );

      const row = database
        .prepare<[], { occurred_at: string; operation_type: string }>(
          "select occurred_at, operation_type from OperationLog where operation_id='operation-1'",
        )
        .get();
      expect(row).toEqual({
        occurred_at: "2026-03-28 12:00:00.000000+09:00",
        operation_type: OperationLogType.CORRECT_KIND,
      });

      const loaded = repository.findAllByCategory("200");
      expect(loaded.map((operationLog) => operationLog.operationId)).toEqual([
        "operation-1",
        "operation-2",
      ]);
    } finally {
      closeSqliteDatabase(database);
    }
  });

  it("updates and deletes operation logs", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new OperationLogRepository(database);
      const operationLog = new OperationLog({
        operationId: "operation-1",
        categoryId: "200",
        userId: "300",
        dayKey: "2026-03-28",
        lap: 4,
        bossIndex: 0,
        targetAttackEntryId: "attack-1",
        operationType: OperationLogType.DECLARE,
        afterKind: AttackEntryKind.BATTLE,
        afterStatus: AttackEntryStatus.DECLARED,
        occurredAt: new Date("2026-03-28T12:00:00+09:00"),
      });

      repository.insert(operationLog);
      operationLog.operationType = OperationLogType.UNDO;
      operationLog.beforeKind = AttackEntryKind.BATTLE;
      operationLog.beforeStatus = AttackEntryStatus.DECLARED;
      operationLog.afterStatus = AttackEntryStatus.UNDONE;
      operationLog.invalidatedAt = new Date("2026-03-28T12:10:00+09:00");
      repository.update(operationLog);

      expect(repository.findById("operation-1")?.toRecord()).toEqual(operationLog.toRecord());

      repository.delete("operation-1");
      expect(repository.findById("operation-1")).toBeNull();
    } finally {
      closeSqliteDatabase(database);
    }
  });

  it("deletes all operation logs for a category", () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const repository = new OperationLogRepository(database);
      repository.insert(
        new OperationLog({
          operationId: "operation-1",
          categoryId: "200",
          userId: "300",
          dayKey: "2026-03-28",
          lap: 4,
          bossIndex: 0,
          targetAttackEntryId: "attack-1",
          operationType: OperationLogType.DECLARE,
          afterKind: AttackEntryKind.BATTLE,
          afterStatus: AttackEntryStatus.DECLARED,
          occurredAt: new Date("2026-03-28T12:00:00+09:00"),
        }),
      );

      repository.deleteAllByCategory("200");

      const row = database
        .prepare<[], { count: bigint }>("select count(*) as count from OperationLog")
        .get();
      expect(row?.count).toBe(0n);
    } finally {
      closeSqliteDatabase(database);
    }
  });
});
