import { describe, expect, it } from "vitest";

import {
  AttackEntry,
  AttackEntryKind,
  AttackEntryStatus,
  parseAttackEntryKind,
  parseAttackEntryStatus,
} from "../../../src/domain/attack-entry.js";

describe("AttackEntry", () => {
  it("round-trips records without leaking mutable dates", () => {
    const declaredAt = new Date("2026-03-28T12:34:56+09:00");
    const resolvedAt = new Date("2026-03-28T12:39:56+09:00");
    const attackEntry = new AttackEntry({
      attackEntryId: "attack-1",
      categoryId: "200",
      userId: "300",
      dayKey: "2026-03-28",
      lap: 4,
      bossIndex: 1,
      kind: AttackEntryKind.BATTLE,
      status: AttackEntryStatus.FINISHED,
      declaredAt,
      resolvedAt,
      damage: 1_234_567,
      memo: "finish",
    });

    const record = attackEntry.toRecord();
    record.declaredAt.setTime(record.declaredAt.getTime() + 1_000);
    record.resolvedAt?.setTime(record.resolvedAt.getTime() + 1_000);

    expect(attackEntry.declaredAt.toISOString()).toBe("2026-03-28T03:34:56.000Z");
    expect(attackEntry.resolvedAt?.toISOString()).toBe("2026-03-28T03:39:56.000Z");
    expect(AttackEntry.fromRecord(attackEntry.toRecord()).toRecord()).toEqual(attackEntry.toRecord());
  });

  it("parses supported kinds and statuses", () => {
    expect(parseAttackEntryKind("battle")).toBe(AttackEntryKind.BATTLE);
    expect(parseAttackEntryKind("carryover")).toBe(AttackEntryKind.CARRYOVER);
    expect(parseAttackEntryKind("unknown")).toBeUndefined();

    expect(parseAttackEntryStatus("declared")).toBe(AttackEntryStatus.DECLARED);
    expect(parseAttackEntryStatus("expired")).toBe(AttackEntryStatus.EXPIRED);
    expect(parseAttackEntryStatus("unknown")).toBeUndefined();
  });
});
