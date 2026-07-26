import { describe, expect, it } from "vitest";

import {
  AttackEntry,
  AttackEntryKind,
  AttackEntryStatus,
} from "../../../src/domain/attack-entry.js";
import {
  rebuildPlayerResourceStates,
  validateAttackEntryResourceProgression,
} from "../../../src/services/player-resource-state-projection.js";

function createFinishedBattleEntry(index: number): AttackEntry {
  return new AttackEntry({
    attackEntryId: `entry-${index}`,
    categoryId: "category-1",
    userId: "user-1",
    dayKey: "2026-03-08",
    lap: 1,
    bossIndex: 0,
    kind: AttackEntryKind.BATTLE,
    status: AttackEntryStatus.FINISHED,
    declaredAt: new Date(`2026-03-08T0${index}:00:00+09:00`),
    resolvedAt: new Date(`2026-03-08T0${index}:01:00+09:00`),
  });
}

describe("player resource state projection", () => {
  it("accepts more than three battle attacks when the member limit was increased", () => {
    const attackEntries = [1, 2, 3, 4].map(createFinishedBattleEntry);

    expect(validateAttackEntryResourceProgression(attackEntries)).toBe(false);
    expect(validateAttackEntryResourceProgression(attackEntries, [], () => 6)).toBe(true);
    expect(rebuildPlayerResourceStates(attackEntries, [], () => 6)[0]?.battleConsumedCount).toBe(4);
  });
});
