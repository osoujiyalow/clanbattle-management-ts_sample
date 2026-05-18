import { describe, expect, it } from "vitest";

import { AttackType } from "../../../src/domain/attack-type.js";
import { CarryOver, PlayerData } from "../../../src/domain/player-data.js";

describe("PlayerData", () => {
  it("tracks unified battle attacks while keeping legacy counters available", () => {
    const playerData = new PlayerData({
      userId: "user-1",
      physicsAttack: 1,
      magicAttack: 2,
    });

    expect(playerData.battleAttackCount).toBe(3);
    expect(playerData.physicsAttack).toBe(1);
    expect(playerData.magicAttack).toBe(2);

    playerData.battleAttackCount = 2;

    expect(playerData.battleAttackCount).toBe(2);
    expect(playerData.physicsAttack).toBe(2);
    expect(playerData.magicAttack).toBe(0);
  });

  it("resets attack progress and transient state", () => {
    const playerData = new PlayerData({
      userId: "user-1",
      physicsAttack: 1,
      magicAttack: 2,
      carryOverList: [new CarryOver({ attackType: AttackType.BATTLE, bossIndex: 0 })],
      rawLimitTimeText: "19-20",
      taskKill: true,
      log: [],
    });

    playerData.initializeAttack();

    expect(playerData.battleAttackCount).toBe(0);
    expect(playerData.physicsAttack).toBe(0);
    expect(playerData.magicAttack).toBe(0);
    expect(playerData.carryOverList).toEqual([]);
    expect(playerData.taskKill).toBe(false);
    expect(playerData.rawLimitTimeText).toBe("");
  });

  it("creates snapshots compatible with later restore", () => {
    const playerData = new PlayerData({
      userId: "user-1",
      physicsAttack: 2,
      magicAttack: 1,
      carryOverList: [
        new CarryOver({
          attackType: AttackType.CARRYOVER,
          bossIndex: 4,
          created: new Date("2026-03-07T05:00:00+09:00"),
        }),
      ],
    });

    const restored = new PlayerData({ userId: "user-1" });
    restored.applySnapshot(playerData.toSnapshot());

    expect(restored.toSnapshot()).toEqual(playerData.toSnapshot());
    expect(restored.battleAttackCount).toBe(3);
    expect(restored.toSnapshot().carryOverList[0]).not.toHaveProperty("carryOverTime");
  });

  it("renders carry-overs without carry-over seconds", () => {
    const carryOver = new CarryOver({
      attackType: AttackType.BATTLE,
      bossIndex: 0,
      created: new Date("2026-03-07T12:00:00+09:00"),
    });

    expect(carryOver.toString()).toBe("12時00分発生 1ボス持ち越し");
  });
});
