import { describe, expect, it } from "vitest";

import {
  AttackEntryKind,
  AttackEntryStatus,
} from "../../../src/domain/attack-entry.js";
import {
  OperationLog,
  OperationLogType,
  parseOperationLogType,
} from "../../../src/domain/operation-log.js";

describe("OperationLog", () => {
  it("round-trips records without leaking mutable dates", () => {
    const occurredAt = new Date("2026-03-28T13:00:00+09:00");
    const invalidatedAt = new Date("2026-03-28T13:05:00+09:00");
    const operationLog = new OperationLog({
      operationId: "operation-1",
      categoryId: "200",
      userId: "300",
      dayKey: "2026-03-28",
      lap: 4,
      bossIndex: 2,
      targetAttackEntryId: "attack-1",
      operationType: OperationLogType.CORRECT_KIND,
      beforeKind: AttackEntryKind.BATTLE,
      afterKind: AttackEntryKind.CARRYOVER,
      beforeStatus: AttackEntryStatus.FINISHED,
      afterStatus: AttackEntryStatus.FINISHED,
      occurredAt,
      invalidatedAt,
    });

    const record = operationLog.toRecord();
    record.occurredAt.setTime(record.occurredAt.getTime() + 1_000);
    record.invalidatedAt?.setTime(record.invalidatedAt.getTime() + 1_000);

    expect(operationLog.occurredAt.toISOString()).toBe("2026-03-28T04:00:00.000Z");
    expect(operationLog.invalidatedAt?.toISOString()).toBe("2026-03-28T04:05:00.000Z");
    expect(OperationLog.fromRecord(operationLog.toRecord()).toRecord()).toEqual(
      operationLog.toRecord(),
    );
  });

  it("parses supported operation types", () => {
    expect(parseOperationLogType("declare")).toBe(OperationLogType.DECLARE);
    expect(parseOperationLogType("correct_kind")).toBe(OperationLogType.CORRECT_KIND);
    expect(parseOperationLogType("unknown")).toBeUndefined();
  });
});
