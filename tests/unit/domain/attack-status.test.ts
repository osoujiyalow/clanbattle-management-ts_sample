import { describe, expect, it } from "vitest";

import { AttackStatus } from "../../../src/domain/attack-status.js";
import { AttackType } from "../../../src/domain/attack-type.js";
import { PlayerData } from "../../../src/domain/player-data.js";

describe("AttackStatus", () => {
  it("updates the unified battle counter from canonical attack types", () => {
    const battlePlayer = new PlayerData({ userId: "battle-user" });
    const battleStatus = new AttackStatus({
      playerData: battlePlayer,
      attackType: AttackType.BATTLE,
      carryOver: false,
    });
    battleStatus.updateAttackLog();

    const carryOverPlayer = new PlayerData({ userId: "carryover-user" });
    const carryOverStatus = new AttackStatus({
      playerData: carryOverPlayer,
      attackType: AttackType.CARRYOVER,
      carryOver: true,
    });
    carryOverStatus.updateAttackLog();

    expect(battleStatus.attackType).toBe(AttackType.BATTLE);
    expect(battlePlayer.battleAttackCount).toBe(1);
    expect(battlePlayer.physicsAttack).toBe(1);
    expect(battlePlayer.magicAttack).toBe(0);
    expect(carryOverStatus.attackType).toBe(AttackType.CARRYOVER);
    expect(carryOverPlayer.battleAttackCount).toBe(1);
    expect(carryOverPlayer.physicsAttack).toBe(1);
  });

  it("renders carry-over generation when damage exceeds current hp", () => {
    const playerData = new PlayerData({
      userId: "user-1",
      battleAttackCount: 2,
    });
    const attackStatus = new AttackStatus({
      playerData,
      attackType: AttackType.BATTLE,
      carryOver: true,
      damage: 200,
      memo: "finish",
    });

    const text = attackStatus.createAttackStatusTxt("Alice", 100);
    expect(text).toContain("finish");
    expect(text).toContain("持ち越し発生: 65秒");
    expect(text).toContain("Alice");
  });
});
