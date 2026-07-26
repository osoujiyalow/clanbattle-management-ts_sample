import {
  AttackEntryKind,
  AttackEntryStatus,
} from "../domain/attack-entry.js";
import type { AttackEntry } from "../domain/attack-entry.js";
import { PlayerResourceState } from "../domain/player-resource-state.js";
import { ResourceAdjustmentType, type ResourceAdjustment } from "../domain/resource-adjustment.js";

interface ProjectedResourceCounters {
  battleReservedCount: number;
  battleConsumedCount: number;
  carryProducedCount: number;
  carryReservedCount: number;
  carryConsumedCount: number;
}

interface RebuildPlayerResourceStatesResult {
  playerResourceStates: PlayerResourceState[];
  isValid: boolean;
}

interface LatestResourceAdjustments {
  battle: ResourceAdjustment | null;
  carryover: ResourceAdjustment | null;
}

export type BattleAttackLimitResolver = (categoryId: string, userId: string) => number;

const DEFAULT_BATTLE_ATTACK_LIMIT_RESOLVER: BattleAttackLimitResolver = () => 3;

function buildProjectionKey(categoryId: string, userId: string, dayKey: string): string {
  return `${categoryId}\u0000${userId}\u0000${dayKey}`;
}

function createProjectionState(attackEntry: AttackEntry): PlayerResourceState {
  return new PlayerResourceState({
    categoryId: attackEntry.categoryId,
    userId: attackEntry.userId,
    dayKey: attackEntry.dayKey,
  });
}

function createProjectionStateFromAdjustment(
  resourceAdjustment: ResourceAdjustment,
): PlayerResourceState {
  return new PlayerResourceState({
    categoryId: resourceAdjustment.categoryId,
    userId: resourceAdjustment.userId,
    dayKey: resourceAdjustment.dayKey,
  });
}

function createProjectedResourceCounters(): ProjectedResourceCounters {
  return {
    battleReservedCount: 0,
    battleConsumedCount: 0,
    carryProducedCount: 0,
    carryReservedCount: 0,
    carryConsumedCount: 0,
  };
}

function isCommittedCarryAttackEntryStatus(status: AttackEntryStatus): boolean {
  return (
    status === AttackEntryStatus.DECLARED ||
    status === AttackEntryStatus.FINISHED ||
    status === AttackEntryStatus.DEFEATED
  );
}

function applyAttackEntryToCounters(
  counters: ProjectedResourceCounters,
  attackEntry: AttackEntry,
): void {
  if (attackEntry.kind === AttackEntryKind.BATTLE) {
    if (attackEntry.status === AttackEntryStatus.DECLARED) {
      counters.battleReservedCount += 1;
      return;
    }

    if (
      attackEntry.status === AttackEntryStatus.FINISHED ||
      attackEntry.status === AttackEntryStatus.DEFEATED
    ) {
      counters.battleConsumedCount += 1;
      if (attackEntry.status === AttackEntryStatus.DEFEATED) {
        counters.carryProducedCount += 1;
      }
    }
    return;
  }

  if (attackEntry.kind === AttackEntryKind.CARRYOVER && isCommittedCarryAttackEntryStatus(attackEntry.status)) {
    if (attackEntry.status === AttackEntryStatus.DECLARED) {
      counters.carryReservedCount += 1;
      return;
    }

    counters.carryConsumedCount += 1;
  }
}

function resolveCarryAvailableCount(counters: ProjectedResourceCounters): number {
  return counters.carryProducedCount - counters.carryReservedCount - counters.carryConsumedCount;
}

function areProjectedResourceCountersValid(
  counters: ProjectedResourceCounters,
  battleAttackLimit: number,
): boolean {
  const carryAvailableCount = resolveCarryAvailableCount(counters);

  return (
    0 <= counters.battleReservedCount &&
    0 <= counters.battleConsumedCount &&
    counters.battleReservedCount + counters.battleConsumedCount <= battleAttackLimit &&
    0 <= counters.carryReservedCount &&
    0 <= counters.carryConsumedCount &&
    0 <= carryAvailableCount &&
    carryAvailableCount + counters.carryReservedCount <= battleAttackLimit
  );
}

function compareResourceAdjustmentsNewestFirst(
  left: Pick<ResourceAdjustment, "occurredAt" | "adjustmentId">,
  right: Pick<ResourceAdjustment, "occurredAt" | "adjustmentId">,
): number {
  const occurredAtDiff = right.occurredAt.getTime() - left.occurredAt.getTime();
  if (occurredAtDiff !== 0) {
    return occurredAtDiff;
  }

  return right.adjustmentId.localeCompare(left.adjustmentId);
}

function collectLatestResourceAdjustmentsByProjectionKey(
  resourceAdjustments: readonly ResourceAdjustment[],
): Map<string, LatestResourceAdjustments> {
  const latestByProjectionKey = new Map<string, LatestResourceAdjustments>();

  for (const resourceAdjustment of [...resourceAdjustments].sort(compareResourceAdjustmentsNewestFirst)) {
    const projectionKey = buildProjectionKey(
      resourceAdjustment.categoryId,
      resourceAdjustment.userId,
      resourceAdjustment.dayKey,
    );
    const latest = latestByProjectionKey.get(projectionKey) ?? {
      battle: null,
      carryover: null,
    };

    if (
      resourceAdjustment.resourceType === ResourceAdjustmentType.BATTLE &&
      latest.battle === null
    ) {
      latest.battle = resourceAdjustment;
    }

    if (
      resourceAdjustment.resourceType === ResourceAdjustmentType.CARRYOVER &&
      latest.carryover === null
    ) {
      latest.carryover = resourceAdjustment;
    }

    latestByProjectionKey.set(projectionKey, latest);
  }

  return latestByProjectionKey;
}

function applyResourceAdjustmentsToPlayerState(
  playerResourceState: PlayerResourceState,
  latestAdjustments: LatestResourceAdjustments | undefined,
  battleAttackLimit: number,
): boolean {
  if (!latestAdjustments) {
    return true;
  }

  if (latestAdjustments.battle) {
    const nextBattleConsumedCount =
      battleAttackLimit -
      playerResourceState.battleReservedCount -
      latestAdjustments.battle.remaining;
    if (nextBattleConsumedCount < 0 || battleAttackLimit < nextBattleConsumedCount) {
      return false;
    }

    playerResourceState.battleConsumedCount = nextBattleConsumedCount;
  }

  if (latestAdjustments.carryover) {
    const nextCarryAvailableCount = latestAdjustments.carryover.remaining;
    if (nextCarryAvailableCount < 0 || battleAttackLimit < nextCarryAvailableCount) {
      return false;
    }

    if (nextCarryAvailableCount + playerResourceState.carryReservedCount > battleAttackLimit) {
      return false;
    }

    playerResourceState.carryAvailableCount = nextCarryAvailableCount;
  }

  return true;
}

function buildPlayerResourceStates(
  attackEntries: readonly AttackEntry[],
  resourceAdjustments: readonly ResourceAdjustment[] = [],
  resolveBattleAttackLimit: BattleAttackLimitResolver = DEFAULT_BATTLE_ATTACK_LIMIT_RESOLVER,
): RebuildPlayerResourceStatesResult {
  const states = new Map<string, PlayerResourceState>();
  const countersByProjectionKey = new Map<string, ProjectedResourceCounters>();
  const latestAdjustmentsByProjectionKey =
    collectLatestResourceAdjustmentsByProjectionKey(resourceAdjustments);

  for (const attackEntry of attackEntries) {
    const projectionKey = buildProjectionKey(
      attackEntry.categoryId,
      attackEntry.userId,
      attackEntry.dayKey,
    );

    if (!states.has(projectionKey)) {
      states.set(projectionKey, createProjectionState(attackEntry));
    }

    const counters = countersByProjectionKey.get(projectionKey) ?? createProjectedResourceCounters();
    applyAttackEntryToCounters(counters, attackEntry);
    countersByProjectionKey.set(projectionKey, counters);
  }

  for (const resourceAdjustment of resourceAdjustments) {
    const projectionKey = buildProjectionKey(
      resourceAdjustment.categoryId,
      resourceAdjustment.userId,
      resourceAdjustment.dayKey,
    );

    if (!states.has(projectionKey)) {
      states.set(projectionKey, createProjectionStateFromAdjustment(resourceAdjustment));
    }
  }

  for (const [projectionKey, playerResourceState] of states.entries()) {
    const counters = countersByProjectionKey.get(projectionKey) ?? createProjectedResourceCounters();
    const battleAttackLimit = resolveBattleAttackLimit(
      playerResourceState.categoryId,
      playerResourceState.userId,
    );
    if (!areProjectedResourceCountersValid(counters, battleAttackLimit)) {
      return {
        playerResourceStates: [],
        isValid: false,
      };
    }

    playerResourceState.battleReservedCount = counters.battleReservedCount;
    playerResourceState.battleConsumedCount = counters.battleConsumedCount;
    playerResourceState.carryReservedCount = counters.carryReservedCount;
    playerResourceState.carryAvailableCount = resolveCarryAvailableCount(counters);

    if (
      !applyResourceAdjustmentsToPlayerState(
        playerResourceState,
        latestAdjustmentsByProjectionKey.get(projectionKey),
        battleAttackLimit,
      )
    ) {
      return {
        playerResourceStates: [],
        isValid: false,
      };
    }
  }

  return {
    playerResourceStates: Array.from(states.values()).sort((left, right) => {
      if (left.categoryId !== right.categoryId) {
        return left.categoryId.localeCompare(right.categoryId);
      }

      if (left.userId !== right.userId) {
        return left.userId.localeCompare(right.userId);
      }

      return left.dayKey.localeCompare(right.dayKey);
    }),
    isValid: true,
  };
}

export function validateAttackEntryResourceProgression(
  attackEntries: readonly AttackEntry[],
  resourceAdjustments: readonly ResourceAdjustment[] = [],
  resolveBattleAttackLimit: BattleAttackLimitResolver = DEFAULT_BATTLE_ATTACK_LIMIT_RESOLVER,
): boolean {
  return buildPlayerResourceStates(
    attackEntries,
    resourceAdjustments,
    resolveBattleAttackLimit,
  ).isValid;
}

export function rebuildPlayerResourceStates(
  attackEntries: readonly AttackEntry[],
  resourceAdjustments: readonly ResourceAdjustment[] = [],
  resolveBattleAttackLimit: BattleAttackLimitResolver = DEFAULT_BATTLE_ATTACK_LIMIT_RESOLVER,
): PlayerResourceState[] {
  return buildPlayerResourceStates(
    attackEntries,
    resourceAdjustments,
    resolveBattleAttackLimit,
  ).playerResourceStates;
}
