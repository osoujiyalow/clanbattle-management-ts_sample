import { AttackEntryKind, AttackEntryStatus, type AttackEntry } from "../domain/attack-entry.js";
import { AttackStatus } from "../domain/attack-status.js";
import { AttackType } from "../domain/attack-type.js";
import { BossStatusData } from "../domain/boss-status-data.js";
import type { ClanData } from "../domain/clan-data.js";
import { CarryOver, PlayerData } from "../domain/player-data.js";
import type { PlayerResourceState } from "../domain/player-resource-state.js";

function createBossStatusList(clanData: ClanData, lap: number): BossStatusData[] {
  return Array.from({ length: clanData.bossChannelIds.length }, (_, bossIndex) => {
    return new BossStatusData({
      lap,
      bossIndex,
      guildId: clanData.guildId,
    });
  });
}

export function ensureRuntimeBossStatusList(clanData: ClanData, lap: number): BossStatusData[] {
  const existing = clanData.bossStatusByLap.get(lap);

  if (existing) {
    return existing;
  }

  const created = createBossStatusList(clanData, lap);
  clanData.bossStatusByLap.set(lap, created);
  return created;
}

function compareCarryOversOldestFirst(left: CarryOver, right: CarryOver): number {
  const createdDiff = left.created.getTime() - right.created.getTime();
  if (createdDiff !== 0) {
    return createdDiff;
  }

  const bossIndexDiff = left.bossIndex - right.bossIndex;
  if (bossIndexDiff !== 0) {
    return bossIndexDiff;
  }

  return left.attackType.localeCompare(right.attackType);
}

function compareAttackEntriesForLegacyProjection(left: AttackEntry, right: AttackEntry): number {
  const declaredDiff = left.declaredAt.getTime() - right.declaredAt.getTime();
  if (declaredDiff !== 0) {
    return declaredDiff;
  }

  const leftResolvedAt = left.resolvedAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const rightResolvedAt = right.resolvedAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  if (leftResolvedAt !== rightResolvedAt) {
    return leftResolvedAt - rightResolvedAt;
  }

  return left.attackEntryId.localeCompare(right.attackEntryId);
}

function isRenderableAttackEntryStatus(status: AttackEntryStatus): boolean {
  return (
    status === AttackEntryStatus.DECLARED ||
    status === AttackEntryStatus.FINISHED ||
    status === AttackEntryStatus.DEFEATED
  );
}

function createSyntheticCarryOverTimestamp(dayKey: string, offset: number): Date {
  const baseDate = new Date(`${dayKey}T23:50:00+09:00`);
  return new Date(baseDate.getTime() + offset * 1_000);
}

function alignLegacyCarryOverListToProjectedCount(
  baseCarryOvers: readonly CarryOver[],
  desiredCount: number,
  dayKey: string,
): CarryOver[] {
  const clonedCarryOvers = baseCarryOvers.map((carryOver) =>
    CarryOver.fromRecord(carryOver.toRecord()),
  );
  const alignedCarryOvers = clonedCarryOvers.slice(0, Math.max(0, desiredCount));

  while (alignedCarryOvers.length < desiredCount) {
    alignedCarryOvers.push(
      new CarryOver({
        attackType: AttackType.BATTLE,
        bossIndex: -1,
        created: createSyntheticCarryOverTimestamp(dayKey, alignedCarryOvers.length),
      }),
    );
  }

  return alignedCarryOvers;
}

function createDetachedRenderablePlayerData(
  detachedPlayerDataByUserId: Map<string, PlayerData>,
  attackEntry: AttackEntry,
): PlayerData | null {
  if (attackEntry.status === AttackEntryStatus.DECLARED) {
    return null;
  }

  const existing = detachedPlayerDataByUserId.get(attackEntry.userId);
  if (existing) {
    return existing;
  }

  const created = new PlayerData({
    userId: attackEntry.userId,
  });
  detachedPlayerDataByUserId.set(attackEntry.userId, created);
  return created;
}

function projectLegacyCarryOvers(attackEntries: readonly AttackEntry[]): Map<string, CarryOver[]> {
  const producedCarryOversByUserId = new Map<string, CarryOver[]>();
  const committedCarryCountByUserId = new Map<string, number>();

  const getProducedCarryOvers = (userId: string): CarryOver[] => {
    const existing = producedCarryOversByUserId.get(userId);
    if (existing) {
      return existing;
    }

    const created: CarryOver[] = [];
    producedCarryOversByUserId.set(userId, created);
    return created;
  };

  for (const attackEntry of attackEntries) {
    if (
      attackEntry.kind === AttackEntryKind.BATTLE &&
      attackEntry.status === AttackEntryStatus.DEFEATED
    ) {
      getProducedCarryOvers(attackEntry.userId).push(
        new CarryOver({
          attackType: AttackType.BATTLE,
          bossIndex: attackEntry.bossIndex,
          created: attackEntry.resolvedAt ?? attackEntry.declaredAt,
        }),
      );
      continue;
    }

    if (
      attackEntry.kind === AttackEntryKind.CARRYOVER &&
      (attackEntry.status === AttackEntryStatus.DECLARED ||
        attackEntry.status === AttackEntryStatus.FINISHED ||
        attackEntry.status === AttackEntryStatus.DEFEATED)
    ) {
      committedCarryCountByUserId.set(
        attackEntry.userId,
        (committedCarryCountByUserId.get(attackEntry.userId) ?? 0) + 1,
      );
    }
  }

  const userIds = new Set<string>([
    ...producedCarryOversByUserId.keys(),
    ...committedCarryCountByUserId.keys(),
  ]);

  return new Map(
    Array.from(userIds.values()).map((userId) => {
      const producedCarryOvers = [...(producedCarryOversByUserId.get(userId) ?? [])].sort(
        compareCarryOversOldestFirst,
      );
      const committedCarryCount = committedCarryCountByUserId.get(userId) ?? 0;
      return [userId, producedCarryOvers.slice(Math.min(committedCarryCount, producedCarryOvers.length))];
    }),
  );
}

function hasFullAttackEntryCoverageForLegacyCompatibility(
  clanData: ClanData,
  attackEntries: readonly AttackEntry[],
): boolean {
  let hasRuntimeAttackStatus = false;

  for (const [lap, bossStatusList] of clanData.bossStatusByLap.entries()) {
    for (let bossIndex = 0; bossIndex < bossStatusList.length; bossIndex += 1) {
      const bossStatusData = bossStatusList[bossIndex];
      if (!bossStatusData) {
        continue;
      }

      for (const attackStatus of bossStatusData.attackPlayers) {
        hasRuntimeAttackStatus = true;
        const hasMatchingAttackEntry = attackEntries.some(
          (attackEntry) =>
            attackEntry.dayKey === clanData.date &&
            attackEntry.userId === attackStatus.playerData.userId &&
            attackEntry.lap === lap &&
            attackEntry.bossIndex === bossIndex &&
            attackEntry.declaredAt.getTime() === attackStatus.created.getTime() &&
            isRenderableAttackEntryStatus(attackEntry.status),
        );
        if (!hasMatchingAttackEntry) {
          return false;
        }
      }
    }
  }

  return hasRuntimeAttackStatus || attackEntries.length > 0;
}

function hasProjectedPlayerStateCoverageForLegacyCompatibility(
  clanData: ClanData,
  playerResourceStates: readonly PlayerResourceState[],
): boolean {
  const playerResourceStateByUserId = new Map(
    playerResourceStates
      .filter((playerResourceState) => playerResourceState.dayKey === clanData.date)
      .map((playerResourceState) => [playerResourceState.userId, playerResourceState] as const),
  );

  for (const playerData of clanData.playerDataMap.values()) {
    const playerResourceState = playerResourceStateByUserId.get(playerData.userId);
    const expectedBattleCount = playerResourceState?.battleConsumedCount ?? 0;
    const expectedCarryOverCount = playerResourceState?.carryAvailableCount ?? 0;
    if (
      playerData.battleAttackCount !== expectedBattleCount ||
      playerData.carryOverList.length !== expectedCarryOverCount
    ) {
      return false;
    }
  }

  return true;
}

export function rebuildLegacyCompatibilityState(
  clanData: ClanData,
  attackEntries: readonly AttackEntry[],
  playerResourceStates: readonly PlayerResourceState[],
): void {
  if (
    attackEntries.length === 0 ||
    !hasFullAttackEntryCoverageForLegacyCompatibility(clanData, attackEntries) ||
    !hasProjectedPlayerStateCoverageForLegacyCompatibility(clanData, playerResourceStates)
  ) {
    return;
  }

  const currentDayAttackEntries = attackEntries
    .filter((attackEntry) => attackEntry.dayKey === clanData.date)
    .sort(compareAttackEntriesForLegacyProjection);
  const playerResourceStateByUserId = new Map(
    playerResourceStates
      .filter((playerResourceState) => playerResourceState.dayKey === clanData.date)
      .map((playerResourceState) => [playerResourceState.userId, playerResourceState] as const),
  );

  const carryOverProjectionByUserId = projectLegacyCarryOvers(currentDayAttackEntries);
  for (const playerData of clanData.playerDataMap.values()) {
    const playerResourceState = playerResourceStateByUserId.get(playerData.userId);
    playerData.battleAttackCount = playerResourceState?.battleConsumedCount ?? 0;
    playerData.carryOverList = alignLegacyCarryOverListToProjectedCount(
      carryOverProjectionByUserId.get(playerData.userId) ?? [],
      playerResourceState?.carryAvailableCount ?? 0,
      clanData.date,
    );
  }

  for (const bossStatusList of clanData.bossStatusByLap.values()) {
    bossStatusList.forEach((bossStatusData) => {
      bossStatusData.attackPlayers = [];
    });
  }

  const detachedPlayerDataByUserId = new Map<string, PlayerData>();

  for (const attackEntry of currentDayAttackEntries) {
    if (!isRenderableAttackEntryStatus(attackEntry.status)) {
      continue;
    }

    const playerData =
      clanData.getPlayerData(attackEntry.userId) ??
      createDetachedRenderablePlayerData(detachedPlayerDataByUserId, attackEntry);
    if (!playerData) {
      continue;
    }

    const bossStatusList = ensureRuntimeBossStatusList(clanData, attackEntry.lap);
    const bossStatusData =
      bossStatusList[attackEntry.bossIndex] ??
      new BossStatusData({
        lap: attackEntry.lap,
        bossIndex: attackEntry.bossIndex,
        guildId: clanData.guildId,
      });
    bossStatusData.attackPlayers.push(
      new AttackStatus({
        playerData,
        attackType:
          attackEntry.kind === AttackEntryKind.CARRYOVER
            ? AttackType.CARRYOVER
            : AttackType.BATTLE,
        carryOver: attackEntry.kind === AttackEntryKind.CARRYOVER,
        attacked:
          attackEntry.status === AttackEntryStatus.FINISHED ||
          attackEntry.status === AttackEntryStatus.DEFEATED,
        damage: attackEntry.damage ?? 0,
        memo: attackEntry.memo ?? "",
        created: attackEntry.declaredAt,
      }),
    );
    bossStatusList[attackEntry.bossIndex] = bossStatusData;
  }
}
