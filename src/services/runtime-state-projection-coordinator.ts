import { randomUUID } from "node:crypto";

import { AttackEntryStatus, type AttackEntry } from "../domain/attack-entry.js";
import { OperationLog, OperationLogType } from "../domain/operation-log.js";
import type { PlayerResourceState } from "../domain/player-resource-state.js";
import type { AttackEntryRepository } from "../repositories/sqlite/attack-entry-repository.js";
import type { OperationLogRepository } from "../repositories/sqlite/operation-log-repository.js";
import type { PlayerResourceStateRepository } from "../repositories/sqlite/player-resource-state-repository.js";
import type { ResourceAdjustmentRepository } from "../repositories/sqlite/resource-adjustment-repository.js";
import { rebuildPlayerResourceStates } from "./player-resource-state-projection.js";

export interface ProjectedStateRefreshResult {
  attackEntries: AttackEntry[];
  playerResourceStates: PlayerResourceState[];
  operationLogs: OperationLog[];
  expiredAttackEntryCount: number;
}

export interface HistoricalPruneRefreshResult extends ProjectedStateRefreshResult {
  prunedAttackEntryCount: number;
  prunedOperationLogCount: number;
  prunedPlayerResourceStateCount: number;
  prunedResourceAdjustmentCount: number;
}

export interface RuntimeStateProjectionCoordinatorOptions {
  attackEntryRepository: AttackEntryRepository;
  playerResourceStateRepository: PlayerResourceStateRepository;
  operationLogRepository: OperationLogRepository;
  resourceAdjustmentRepository: ResourceAdjustmentRepository;
}

export class RuntimeStateProjectionCoordinator {
  constructor(private readonly options: RuntimeStateProjectionCoordinatorOptions) {}

  pruneHistoricalStateAndRefreshCategory(
    categoryId: string,
    currentDayKey: string,
    transitionAt: Date,
  ): HistoricalPruneRefreshResult {
    const prunedAttackEntryCount = this.options.attackEntryRepository.deleteBeforeDayKey(
      categoryId,
      currentDayKey,
    );
    const prunedOperationLogCount = this.options.operationLogRepository.deleteBeforeDayKey(
      categoryId,
      currentDayKey,
    );
    const prunedPlayerResourceStateCount =
      this.options.playerResourceStateRepository.deleteBeforeDayKey(categoryId, currentDayKey);
    const prunedResourceAdjustmentCount =
      this.options.resourceAdjustmentRepository.deleteBeforeDayKey(categoryId, currentDayKey);
    const refreshed = this.refreshCategory(categoryId, currentDayKey, transitionAt);

    return {
      ...refreshed,
      prunedAttackEntryCount,
      prunedOperationLogCount,
      prunedPlayerResourceStateCount,
      prunedResourceAdjustmentCount,
    };
  }

  refreshCategory(
    categoryId: string,
    currentDayKey: string,
    transitionAt: Date,
  ): ProjectedStateRefreshResult {
    const attackEntries = this.options.attackEntryRepository.findAllByCategory(categoryId);
    const expiredAttackEntries = this.expireStaleDeclaredAttackEntries(
      attackEntries,
      currentDayKey,
      transitionAt,
    );

    for (const attackEntry of expiredAttackEntries) {
      this.options.attackEntryRepository.update(attackEntry);
      this.options.operationLogRepository.insert(
        new OperationLog({
          operationId: randomUUID(),
          categoryId: attackEntry.categoryId,
          userId: attackEntry.userId,
          dayKey: attackEntry.dayKey,
          lap: attackEntry.lap,
          bossIndex: attackEntry.bossIndex,
          targetAttackEntryId: attackEntry.attackEntryId,
          operationType: OperationLogType.EXPIRE,
          beforeKind: attackEntry.kind,
          afterKind: attackEntry.kind,
          beforeStatus: AttackEntryStatus.DECLARED,
          afterStatus: AttackEntryStatus.EXPIRED,
          occurredAt: attackEntry.resolvedAt ?? transitionAt,
        }),
      );
    }

    const resourceAdjustments = this.options.resourceAdjustmentRepository.findAllByCategory(categoryId);
    const playerResourceStates = rebuildPlayerResourceStates(attackEntries, resourceAdjustments);
    this.options.playerResourceStateRepository.deleteAllByCategory(categoryId);
    for (const playerResourceState of playerResourceStates) {
      this.options.playerResourceStateRepository.insert(playerResourceState);
    }

    return {
      attackEntries,
      playerResourceStates,
      operationLogs: this.options.operationLogRepository.findAllByCategory(categoryId),
      expiredAttackEntryCount: expiredAttackEntries.length,
    };
  }

  groupPlayerResourceStates(
    playerResourceStates: readonly PlayerResourceState[],
  ): Map<string, Map<string, PlayerResourceState>> {
    const grouped = new Map<string, Map<string, PlayerResourceState>>();

    for (const playerResourceState of playerResourceStates) {
      const dayMap = grouped.get(playerResourceState.userId) ?? new Map<string, PlayerResourceState>();
      dayMap.set(playerResourceState.dayKey, playerResourceState);
      grouped.set(playerResourceState.userId, dayMap);
    }

    return grouped;
  }

  private expireStaleDeclaredAttackEntries(
    attackEntries: readonly AttackEntry[],
    currentDayKey: string,
    resolvedAt: Date,
  ): AttackEntry[] {
    const expiredAttackEntries: AttackEntry[] = [];

    for (const attackEntry of attackEntries) {
      if (attackEntry.status !== AttackEntryStatus.DECLARED) {
        continue;
      }

      if (attackEntry.dayKey === currentDayKey) {
        continue;
      }

      attackEntry.status = AttackEntryStatus.EXPIRED;
      attackEntry.resolvedAt = resolvedAt;
      expiredAttackEntries.push(attackEntry);
    }

    return expiredAttackEntries;
  }
}
