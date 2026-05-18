import { AttackEntryKind } from "../domain/attack-entry.js";
import { AttackType } from "../domain/attack-type.js";
import type { BossStatusData } from "../domain/boss-status-data.js";
import { type OperationLog, OperationLogType } from "../domain/operation-log.js";
import { OPERATION_TYPE_DESCRIPTION, OperationType } from "../domain/operation-type.js";
import { type CarryOver, type LogData } from "../domain/player-data.js";
import { formatSqliteDateTime } from "../repositories/sqlite/sqlite-time.js";

const TRANSIENT_INTERACTION_MESSAGE_DELETE_AFTER_MS = 15_000;

export const CARRYOVER_DECLARE_BLOCKED_MESSAGE =
  "持ち越しを所持していません。凸宣言をキャンセルします。";
export const ATTACK_NOT_DECLARED_MESSAGE = "凸宣言がされていません。処理を中断します。";
export const ALREADY_DEFEATED_MESSAGE = "既に討伐済みのボスです";
export const UNDO_NOTHING_MESSAGE = "元に戻す内容がありませんでした";
export const UNDO_BLOCKED_BY_LATER_OPERATIONS_MESSAGE =
  "このボスの後に別の操作があるため自動巻き戻しできません";
export const UNDO_DEFEAT_BLOCKED_BY_NEXT_LAP_MESSAGE =
  "次周に既に操作があるため自動巻き戻しできません";
export const CORRECT_ATTACK_KIND_NOTHING_MESSAGE = "入替え対象の攻撃が見つかりませんでした";
export const CORRECT_ATTACK_KIND_CANCELLED_MESSAGE = "入替えをキャンセルしました";
export const CORRECT_ATTACK_KIND_INVALID_MESSAGE =
  "その入替えでは本戦数または持越数の整合が取れません";
export const DECLARE_RESOURCE_EXHAUSTED_MESSAGE =
  "本戦凸は全て使っています。凸宣言をキャンセルします。";

export const MESSAGE_DAMAGE_ALL_ATTACKS_CONSUMED_MESSAGE =
  "\u65e2\u306b\u5168\u3066\u306e\u51f8\u3092\u6d88\u8cbb\u3057\u3066\u3044\u307e\u3059\u3088";

interface AttackResponsePayload {
  content?: string;
}

interface AttackResponseChannel {
  send(payload: AttackResponsePayload): Promise<void>;
  sendTransient?(payload: AttackResponsePayload, deleteAfterMs?: number): Promise<void>;
}

export function createBossSlots(): [string | null, string | null, string | null, string | null, string | null] {
  return [null, null, null, null, null];
}

export async function sendAttackResponse(
  responseChannel: AttackResponseChannel,
  payload: AttackResponsePayload,
  options?: {
    transient?: boolean;
    deleteAfterMs?: number;
  },
): Promise<void> {
  if (options?.transient && typeof responseChannel.sendTransient === "function") {
    await responseChannel.sendTransient(
      payload,
      options.deleteAfterMs ?? TRANSIENT_INTERACTION_MESSAGE_DELETE_AFTER_MS,
    );
    return;
  }

  await responseChannel.send(payload);
}

export function compareCarryOversOldestFirst(left: CarryOver, right: CarryOver): number {
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

export function isUndoableLogOperationType(operationType: OperationType): boolean {
  return (
    operationType === OperationType.ATTACK_DECLAR ||
    operationType === OperationType.ATTACK ||
    operationType === OperationType.LAST_ATTACK
  );
}

export function matchesUndoProgressContext(
  logData: LogData,
  context: {
    lap: number;
    bossIndex: number;
  },
): boolean {
  if (logData.bossIndex !== context.bossIndex) {
    return false;
  }

  if (logData.lap === context.lap) {
    return true;
  }

  return logData.operationType === OperationType.LAST_ATTACK && logData.lap + 1 === context.lap;
}

export function toAttackEntryKind(attackType: AttackType): AttackEntryKind {
  if (attackType === AttackType.CARRYOVER) {
    return AttackEntryKind.CARRYOVER;
  }

  return AttackEntryKind.BATTLE;
}

export function createAttackEntryId(
  categoryId: string,
  userId: string,
  lap: number,
  bossIndex: number,
  createdAt: Date,
): string {
  return [
    categoryId,
    userId,
    String(lap),
    String(bossIndex),
    formatSqliteDateTime(createdAt),
  ].join(":");
}

export function mentionUser(userId: string): string {
  return `<@${userId}>`;
}

export function formatNotManagedMessage(displayName: string): string {
  return `${displayName}は凸管理対象ではありません。`;
}

export function formatDeclareMessage(
  displayName: string,
  attackTypeText: string,
  lap: number,
  bossNumber: number,
): string {
  return `${displayName}の凸を${attackTypeText}で${lap}周目${bossNumber}ボスに宣言します`;
}

export function formatAttackFinishMessage(
  displayName: string,
  lap: number,
  bossNumber: number,
): string {
  return `${displayName}の凸を${lap}周目${bossNumber}ボスに消化します`;
}

export function formatDefeatBossMessage(displayName: string, bossNumber: number): string {
  return `${displayName}の凸で${bossNumber}ボスを討伐します`;
}

export function formatUndoMemberNotManagedMessage(displayName: string): string {
  return `${displayName}さんは凸管理のメンバーに指定されていません。`;
}

export function formatUndoMessage(
  displayName: string,
  bossNumber: number,
  operationType: OperationType,
): string {
  return `${displayName}の${bossNumber}ボスに対する\`${OPERATION_TYPE_DESCRIPTION[operationType]}\`を元に戻します。`;
}

export function formatCarryOverMissingMessage(userId: string): string {
  return `${mentionUser(userId)} 持ち越しを所持していません。キャンセルします。`;
}

export function formatCarryOverSelectionPrompt(userId: string): string {
  return `${mentionUser(userId)} 持ち越しが二つ以上発生しています。以下から使用した持ち越しを選択してください`;
}

export function hasAnyAttackPlayers(bossStatusData: BossStatusData | undefined): boolean {
  return (bossStatusData?.attackPlayers.length ?? 0) > 0;
}

export function isUndoableOperationLogType(operationType: OperationLogType): boolean {
  return (
    operationType === OperationLogType.DECLARE ||
    operationType === OperationLogType.FINISH ||
    operationType === OperationLogType.DEFEAT
  );
}

function getUndoOperationLogPrecedence(operationType: OperationLogType): number {
  switch (operationType) {
    case OperationLogType.DECLARE:
      return 0;
    case OperationLogType.FINISH:
      return 1;
    case OperationLogType.DEFEAT:
      return 2;
    default:
      return -1;
  }
}

export function compareOperationLogsNewestFirst(left: OperationLog, right: OperationLog): number {
  const occurredAtDiff = right.occurredAt.getTime() - left.occurredAt.getTime();
  if (occurredAtDiff !== 0) {
    return occurredAtDiff;
  }

  const precedenceDiff =
    getUndoOperationLogPrecedence(right.operationType) -
    getUndoOperationLogPrecedence(left.operationType);
  if (precedenceDiff !== 0) {
    return precedenceDiff;
  }

  return right.operationId.localeCompare(left.operationId);
}

export function matchesUndoOperationProgressContext(
  operationLog: OperationLog,
  context: {
    lap: number;
    bossIndex: number;
  },
): boolean {
  if (operationLog.bossIndex !== context.bossIndex) {
    return false;
  }

  if (operationLog.lap === context.lap) {
    return true;
  }

  return (
    operationLog.operationType === OperationLogType.DEFEAT &&
    operationLog.lap + 1 === context.lap
  );
}
