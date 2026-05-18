import { describe, expect, it } from "vitest";

import { AttackStatus } from "../../../src/domain/attack-status.js";
import { AttackType } from "../../../src/domain/attack-type.js";
import { BossStatusData } from "../../../src/domain/boss-status-data.js";
import { PlayerData } from "../../../src/domain/player-data.js";

describe("BossStatusData", () => {
  it("finds the latest matching attack status by user id and attacked flag", () => {
    const playerA = new PlayerData({ userId: "user-a" });
    const playerB = new PlayerData({ userId: "user-b" });
    const bossStatusData = new BossStatusData({
      lap: 3,
      bossIndex: 1,
      maxHp: 5000,
      attackPlayers: [
        new AttackStatus({
          playerData: playerA,
          attackType: AttackType.BATTLE,
          carryOver: false,
          attacked: false,
        }),
        new AttackStatus({
          playerData: playerB,
          attackType: AttackType.BATTLE,
          carryOver: false,
          attacked: true,
        }),
        new AttackStatus({
          playerData: playerA,
          attackType: AttackType.BATTLE,
          carryOver: false,
          attacked: false,
        }),
      ],
    });

    expect(bossStatusData.getAttackStatusIndex(playerA, false)).toBe(2);
    expect(bossStatusData.getAttackStatusIndex(playerB, false)).toBeUndefined();
  });
});
