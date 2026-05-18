import { USER_MESSAGES } from "../constants/messages.js";
import { AttackEntry, AttackEntryStatus } from "../domain/attack-entry.js";
import type { ClanData } from "../domain/clan-data.js";
import {
  type OperationLog,
  OperationLogType,
} from "../domain/operation-log.js";
import { OperationType } from "../domain/operation-type.js";
import type { LogData } from "../domain/player-data.js";
import type { ResourceAdjustment } from "../domain/resource-adjustment.js";
import {
  compareOperationLogsNewestFirst,
  isUndoableLogOperationType,
  isUndoableOperationLogType,
  matchesUndoOperationProgressContext,
  matchesUndoProgressContext,
} from "./attack-service-support.js";
import { validateAttackEntryResourceProgression } from "./player-resource-state-projection.js";

interface UndoBossIndexResponseChannel {
  send(payload: { content?: string }): Promise<void>;
}

export interface UndoBossIndexRequest {
  bossNumber?: number;
  channelId?: string;
  responseChannel: UndoBossIndexResponseChannel;
}

export interface UndoOperationTarget {
  attackEntry: AttackEntry;
  operationLog: OperationLog;
}

interface FindUndoOperationTargetParams {
  operationLogs: readonly OperationLog[];
  findAttackEntryById: (attackEntryId: string) => AttackEntry | null;
  userId: string;
  dayKey: string;
}

interface FindUndoOperationTargetForBossParams extends FindUndoOperationTargetParams {
  bossIndex: number;
}

interface FindUndoOperationTargetForProgressContextParams extends FindUndoOperationTargetParams {
  bossIndex: number;
  lap: number;
}

interface UndoBlockCheckParams {
  targetOperationLog: OperationLog;
  targetAttackEntry: AttackEntry;
  attackEntries: readonly AttackEntry[];
  resourceAdjustments: readonly ResourceAdjustment[];
  operationLogs: readonly OperationLog[];
}

interface RestoreExpiredAttackEntriesAfterDefeatUndoInMemoryParams {
  operationLogs: readonly OperationLog[];
  lap: number;
  bossIndex: number;
  defeatOccurredAt: Date | null;
  attackEntries: AttackEntry[];
}

export function hasProjectedUndoState(params: {
  attackEntries: readonly AttackEntry[];
  operationLogs: readonly OperationLog[];
}): boolean {
  return params.attackEntries.length > 0 || params.operationLogs.length > 0;
}

export function findUndoOperationTargetForBoss(
  params: FindUndoOperationTargetForBossParams,
): UndoOperationTarget | null {
  const operationLog =
    params.operationLogs
      .filter(
        (candidate) =>
          candidate.userId === params.userId &&
          candidate.dayKey === params.dayKey &&
          candidate.bossIndex === params.bossIndex &&
          candidate.invalidatedAt === null &&
          isUndoableOperationLogType(candidate.operationType),
      )
      .sort(compareOperationLogsNewestFirst)[0] ?? null;

  if (!operationLog) {
    return null;
  }

  const attackEntry = params.findAttackEntryById(operationLog.targetAttackEntryId);
  if (!attackEntry) {
    return null;
  }

  return {
    attackEntry,
    operationLog,
  };
}

export function findUndoOperationTargetForProgressContext(
  params: FindUndoOperationTargetForProgressContextParams,
): UndoOperationTarget | null {
  const operationLog =
    params.operationLogs
      .filter(
        (candidate) =>
          candidate.userId === params.userId &&
          candidate.dayKey === params.dayKey &&
          candidate.invalidatedAt === null &&
          isUndoableOperationLogType(candidate.operationType) &&
          matchesUndoOperationProgressContext(candidate, {
            lap: params.lap,
            bossIndex: params.bossIndex,
          }),
      )
      .sort(compareOperationLogsNewestFirst)[0] ?? null;

  if (!operationLog) {
    return null;
  }

  const attackEntry = params.findAttackEntryById(operationLog.targetAttackEntryId);
  if (!attackEntry) {
    return null;
  }

  return {
    attackEntry,
    operationLog,
  };
}

export function isUndoBlockedByLaterOperations(params: UndoBlockCheckParams): boolean {
  if (params.targetOperationLog.operationType === OperationLogType.DECLARE) {
    return false;
  }

  const simulatedAttackEntries = params.attackEntries.map((attackEntry) =>
    AttackEntry.fromRecord(attackEntry.toRecord()),
  );
  const simulatedTargetAttackEntry = simulatedAttackEntries.find(
    (attackEntry) => attackEntry.attackEntryId === params.targetAttackEntry.attackEntryId,
  );
  if (!simulatedTargetAttackEntry) {
    return true;
  }

  simulatedTargetAttackEntry.status = AttackEntryStatus.DECLARED;
  simulatedTargetAttackEntry.resolvedAt = null;

  if (params.targetOperationLog.operationType === OperationLogType.DEFEAT) {
    restoreExpiredAttackEntriesAfterDefeatUndoInMemory({
      operationLogs: params.operationLogs,
      lap: params.targetOperationLog.lap,
      bossIndex: params.targetOperationLog.bossIndex,
      defeatOccurredAt: params.targetAttackEntry.resolvedAt,
      attackEntries: simulatedAttackEntries,
    });
  }

  return !validateAttackEntryResourceProgression(
    simulatedAttackEntries,
    params.resourceAdjustments,
  );
}

async function sendUndoBossIndexRequired(
  responseChannel: UndoBossIndexResponseChannel,
): Promise<null> {
  await responseChannel.send({
    content: USER_MESSAGES.errors.bossNumberRequired,
  });
  return null;
}

export async function resolveUndoBossIndex(
  clanData: ClanData,
  request: UndoBossIndexRequest,
): Promise<number | null> {
  if (request.bossNumber === undefined) {
    if (!request.channelId) {
      return sendUndoBossIndexRequired(request.responseChannel);
    }

    const bossIndex = clanData.getBossIndexFromChannelId(request.channelId);
    if (bossIndex === undefined) {
      return sendUndoBossIndexRequired(request.responseChannel);
    }

    return bossIndex;
  }

  if (!(0 < request.bossNumber && request.bossNumber < 6)) {
    await request.responseChannel.send({
      content: USER_MESSAGES.errors.invalidBossNumber,
    });
    return null;
  }

  return request.bossNumber - 1;
}

export function findUndoLogIndexForBoss(
  logList: readonly LogData[],
  bossIndex: number,
): number | undefined {
  for (let index = logList.length - 1; index >= 0; index -= 1) {
    const logData = logList[index];
    if (
      !logData ||
      logData.bossIndex !== bossIndex ||
      !isUndoableLogOperationType(logData.operationType)
    ) {
      continue;
    }

    return index;
  }

  return undefined;
}

export function findUndoLogIndexForProgressContext(
  logList: readonly LogData[],
  bossIndex: number,
  lap: number,
): number | undefined {
  for (let index = logList.length - 1; index >= 0; index -= 1) {
    const logData = logList[index];
    if (!logData || !isUndoableLogOperationType(logData.operationType)) {
      continue;
    }

    if (matchesUndoProgressContext(logData, { lap, bossIndex })) {
      return index;
    }
  }

  return undefined;
}

export function isUndoBlockedByLaterPlayerOperations(
  logList: readonly LogData[],
  targetIndex: number,
  targetLogData: LogData,
): boolean {
  if (targetLogData.operationType === OperationType.ATTACK_DECLAR) {
    return false;
  }

  return targetIndex < logList.length - 1;
}

export function toOperationLogType(operationType: OperationType): OperationLogType {
  switch (operationType) {
    case OperationType.ATTACK_DECLAR:
      return OperationLogType.DECLARE;
    case OperationType.ATTACK:
      return OperationLogType.FINISH;
    case OperationType.LAST_ATTACK:
      return OperationLogType.DEFEAT;
    default:
      throw new Error(`Unsupported undo operation type: ${operationType}`);
  }
}

export function toLegacyOperationType(operationType: OperationLogType): OperationType {
  switch (operationType) {
    case OperationLogType.DECLARE:
      return OperationType.ATTACK_DECLAR;
    case OperationLogType.FINISH:
      return OperationType.ATTACK;
    case OperationLogType.DEFEAT:
      return OperationType.LAST_ATTACK;
    default:
      throw new Error(`Unsupported operation log type for undo message: ${operationType}`);
  }
}

function restoreExpiredAttackEntriesAfterDefeatUndoInMemory(
  params: RestoreExpiredAttackEntriesAfterDefeatUndoInMemoryParams,
): void {
  if (!params.defeatOccurredAt) {
    return;
  }

  const defeatOccurredAtTime = params.defeatOccurredAt.getTime();
  const expireOperationLogs = params.operationLogs.filter(
    (operationLog) =>
      operationLog.operationType === OperationLogType.EXPIRE &&
      operationLog.lap === params.lap &&
      operationLog.bossIndex === params.bossIndex &&
      operationLog.invalidatedAt === null &&
      operationLog.occurredAt.getTime() === defeatOccurredAtTime,
  );

  for (const expireOperationLog of expireOperationLogs) {
    const attackEntry = params.attackEntries.find(
      (candidate) => candidate.attackEntryId === expireOperationLog.targetAttackEntryId,
    );
    if (!attackEntry || attackEntry.status !== AttackEntryStatus.EXPIRED) {
      continue;
    }

    attackEntry.status = AttackEntryStatus.DECLARED;
    attackEntry.resolvedAt = null;
  }
}
