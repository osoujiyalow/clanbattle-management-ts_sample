import { describe, expect, it } from "vitest";

import { PlayerResourceState } from "../../../src/domain/player-resource-state.js";

describe("PlayerResourceState", () => {
  it("defaults counts to zero and exposes derived totals", () => {
    const playerResourceState = new PlayerResourceState({
      categoryId: "200",
      userId: "300",
      dayKey: "2026-03-28",
    });

    expect(playerResourceState.toRecord()).toEqual({
      categoryId: "200",
      userId: "300",
      dayKey: "2026-03-28",
      battleReservedCount: 0,
      battleConsumedCount: 0,
      carryAvailableCount: 0,
      carryReservedCount: 0,
    });
    expect(playerResourceState.occupiedBattleCount).toBe(0);
    expect(playerResourceState.totalCarryCount).toBe(0);
  });

  it("round-trips explicit resource counts", () => {
    const playerResourceState = PlayerResourceState.fromRecord({
      categoryId: "200",
      userId: "300",
      dayKey: "2026-03-28",
      battleReservedCount: 1,
      battleConsumedCount: 2,
      carryAvailableCount: 1,
      carryReservedCount: 1,
    });

    expect(playerResourceState.occupiedBattleCount).toBe(3);
    expect(playerResourceState.totalCarryCount).toBe(2);
    expect(playerResourceState.toRecord()).toEqual({
      categoryId: "200",
      userId: "300",
      dayKey: "2026-03-28",
      battleReservedCount: 1,
      battleConsumedCount: 2,
      carryAvailableCount: 1,
      carryReservedCount: 1,
    });
  });
});
