import { describe, expect, it } from "vitest";

import {
  AttackEntry,
  AttackEntryKind,
  AttackEntryStatus,
} from "../../../src/domain/attack-entry.js";
import { AttackStatus } from "../../../src/domain/attack-status.js";
import { AttackType } from "../../../src/domain/attack-type.js";
import { ClanData } from "../../../src/domain/clan-data.js";
import { CarryOver, PlayerData } from "../../../src/domain/player-data.js";
import { PlayerResourceState } from "../../../src/domain/player-resource-state.js";
import {
  ensureRuntimeBossStatusList,
  rebuildLegacyCompatibilityState,
} from "../../../src/services/runtime-state-legacy-compatibility.js";

function createClanData(params?: Partial<ConstructorParameters<typeof ClanData>[0]>): ClanData {
  return new ClanData({
    guildId: "123456789012345678",
    categoryId: "223456789012345678",
    bossChannelIds: [
      "323456789012345678",
      "423456789012345678",
      "523456789012345678",
      "623456789012345678",
      "723456789012345678",
    ],
    remainAttackChannelId: "823456789012345678",
    commandChannelId: "103456789012345678",
    summaryChannelId: "113456789012345678",
    date: "2026-03-28",
    ...params,
  });
}

describe("runtime-state-legacy-compatibility", () => {
  it("creates and reuses runtime boss status slots by lap", () => {
    const clanData = createClanData();

    const first = ensureRuntimeBossStatusList(clanData, 4);
    const second = ensureRuntimeBossStatusList(clanData, 4);

    expect(first).toBe(second);
    expect(first).toHaveLength(5);
    expect(first[0]?.lap).toBe(4);
    expect(clanData.bossStatusByLap.get(4)).toBe(first);
  });

  it("rebuilds player counters, synthetic carryovers, and renderable attack rows on explicit invocation", () => {
    const playerData = new PlayerData({
      userId: "123456789012345679",
      battleAttackCount: 2,
      carryOverList: [
        new CarryOver({
          attackType: AttackType.BATTLE,
          bossIndex: 1,
          created: new Date("2026-03-28T08:00:00+09:00"),
        }),
      ],
    });
    const clanData = createClanData({
      playerDataMap: new Map([[playerData.userId, playerData]]),
    });
    clanData.initializeBossStatusData(4);

    const existingAttackStatus = new AttackStatus({
      playerData,
      attackType: AttackType.BATTLE,
      carryOver: false,
      attacked: true,
      damage: 123_456,
      memo: "existing",
      created: new Date("2026-03-28T09:00:00+09:00"),
    });
    clanData.bossStatusByLap.get(4)![0]!.attackPlayers.push(existingAttackStatus);

    rebuildLegacyCompatibilityState(
      clanData,
      [
        new AttackEntry({
          attackEntryId: "attack-1",
          categoryId: clanData.categoryId,
          userId: playerData.userId,
          dayKey: "2026-03-28",
          lap: 4,
          bossIndex: 0,
          kind: AttackEntryKind.BATTLE,
          status: AttackEntryStatus.FINISHED,
          declaredAt: new Date("2026-03-28T09:00:00+09:00"),
          resolvedAt: new Date("2026-03-28T09:03:00+09:00"),
          damage: 123_456,
          memo: "existing",
        }),
        new AttackEntry({
          attackEntryId: "attack-2",
          categoryId: clanData.categoryId,
          userId: playerData.userId,
          dayKey: "2026-03-28",
          lap: 4,
          bossIndex: 2,
          kind: AttackEntryKind.CARRYOVER,
          status: AttackEntryStatus.DECLARED,
          declaredAt: new Date("2026-03-28T09:10:00+09:00"),
          memo: "carry declared",
        }),
      ],
      [
        new PlayerResourceState({
          categoryId: clanData.categoryId,
          userId: playerData.userId,
          dayKey: "2026-03-28",
          battleConsumedCount: 2,
          carryAvailableCount: 1,
        }),
      ],
    );

    expect(playerData.battleAttackCount).toBe(2);
    expect(playerData.carryOverList).toHaveLength(1);
    expect(playerData.carryOverList[0]?.bossIndex).toBe(-1);
    expect(clanData.bossStatusByLap.get(4)?.[0]?.attackPlayers).toHaveLength(1);
    expect(clanData.bossStatusByLap.get(4)?.[0]?.attackPlayers[0]?.memo).toBe("existing");
    expect(clanData.bossStatusByLap.get(4)?.[2]?.attackPlayers).toHaveLength(1);
    expect(clanData.bossStatusByLap.get(4)?.[2]?.attackPlayers[0]).toMatchObject({
      carryOver: true,
      attacked: false,
      memo: "carry declared",
    });
  });

  it("does nothing when projected player-state coverage is missing", () => {
    const playerData = new PlayerData({
      userId: "123456789012345679",
      battleAttackCount: 0,
      carryOverList: [],
    });
    const clanData = createClanData({
      playerDataMap: new Map([[playerData.userId, playerData]]),
    });
    clanData.initializeBossStatusData(4);

    const existingAttackStatus = new AttackStatus({
      playerData,
      attackType: AttackType.BATTLE,
      carryOver: false,
      attacked: true,
      damage: 123_456,
      memo: "keep me",
      created: new Date("2026-03-28T09:00:00+09:00"),
    });
    clanData.bossStatusByLap.get(4)![0]!.attackPlayers.push(existingAttackStatus);

    rebuildLegacyCompatibilityState(
      clanData,
      [
        new AttackEntry({
          attackEntryId: "attack-1",
          categoryId: clanData.categoryId,
          userId: playerData.userId,
          dayKey: "2026-03-28",
          lap: 4,
          bossIndex: 0,
          kind: AttackEntryKind.BATTLE,
          status: AttackEntryStatus.FINISHED,
          declaredAt: new Date("2026-03-28T09:00:00+09:00"),
          resolvedAt: new Date("2026-03-28T09:03:00+09:00"),
          damage: 123_456,
          memo: "keep me",
        }),
      ],
      [
        new PlayerResourceState({
          categoryId: clanData.categoryId,
          userId: playerData.userId,
          dayKey: "2026-03-28",
          battleConsumedCount: 1,
          carryAvailableCount: 0,
        }),
      ],
    );

    expect(playerData.battleAttackCount).toBe(0);
    expect(playerData.carryOverList).toHaveLength(0);
    expect(clanData.bossStatusByLap.get(4)?.[0]?.attackPlayers).toHaveLength(1);
    expect(clanData.bossStatusByLap.get(4)?.[0]?.attackPlayers[0]?.memo).toBe("keep me");
    expect(clanData.bossStatusByLap.get(4)?.[2]?.attackPlayers).toHaveLength(0);
  });
});
