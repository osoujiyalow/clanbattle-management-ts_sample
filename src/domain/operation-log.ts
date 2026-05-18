import {
  type AttackEntryKind,
  type AttackEntryStatus,
} from "./attack-entry.js";

function cloneDate(date: Date): Date {
  return new Date(date.getTime());
}

function cloneNullableDate(date: Date | null): Date | null {
  return date ? cloneDate(date) : null;
}

export const OperationLogType = {
  DECLARE: "declare",
  FINISH: "finish",
  DEFEAT: "defeat",
  EXPIRE: "expire",
  UNDO: "undo",
  CORRECT_KIND: "correct_kind",
} as const;

export type OperationLogType = (typeof OperationLogType)[keyof typeof OperationLogType];

export function parseOperationLogType(value: string): OperationLogType | undefined {
  return (Object.values(OperationLogType) as readonly string[]).find(
    (candidate) => candidate === value,
  ) as OperationLogType | undefined;
}

export interface OperationLogRecord {
  operationId: string;
  categoryId: string;
  userId: string;
  dayKey: string;
  lap: number;
  bossIndex: number;
  targetAttackEntryId: string;
  operationType: OperationLogType;
  beforeKind: AttackEntryKind | null;
  afterKind: AttackEntryKind | null;
  beforeStatus: AttackEntryStatus | null;
  afterStatus: AttackEntryStatus | null;
  occurredAt: Date;
  invalidatedAt: Date | null;
}

export interface OperationLogParams {
  operationId: string;
  categoryId: string;
  userId: string;
  dayKey: string;
  lap: number;
  bossIndex: number;
  targetAttackEntryId: string;
  operationType: OperationLogType;
  beforeKind?: AttackEntryKind | null;
  afterKind?: AttackEntryKind | null;
  beforeStatus?: AttackEntryStatus | null;
  afterStatus?: AttackEntryStatus | null;
  occurredAt: Date;
  invalidatedAt?: Date | null;
}

export class OperationLog {
  operationId: string;
  categoryId: string;
  userId: string;
  dayKey: string;
  lap: number;
  bossIndex: number;
  targetAttackEntryId: string;
  operationType: OperationLogType;
  beforeKind: AttackEntryKind | null;
  afterKind: AttackEntryKind | null;
  beforeStatus: AttackEntryStatus | null;
  afterStatus: AttackEntryStatus | null;
  occurredAt: Date;
  invalidatedAt: Date | null;

  constructor(params: OperationLogParams) {
    this.operationId = params.operationId;
    this.categoryId = params.categoryId;
    this.userId = params.userId;
    this.dayKey = params.dayKey;
    this.lap = params.lap;
    this.bossIndex = params.bossIndex;
    this.targetAttackEntryId = params.targetAttackEntryId;
    this.operationType = params.operationType;
    this.beforeKind = params.beforeKind ?? null;
    this.afterKind = params.afterKind ?? null;
    this.beforeStatus = params.beforeStatus ?? null;
    this.afterStatus = params.afterStatus ?? null;
    this.occurredAt = cloneDate(params.occurredAt);
    this.invalidatedAt = cloneNullableDate(params.invalidatedAt ?? null);
  }

  static fromRecord(record: OperationLogRecord): OperationLog {
    return new OperationLog({
      operationId: record.operationId,
      categoryId: record.categoryId,
      userId: record.userId,
      dayKey: record.dayKey,
      lap: record.lap,
      bossIndex: record.bossIndex,
      targetAttackEntryId: record.targetAttackEntryId,
      operationType: record.operationType,
      beforeKind: record.beforeKind,
      afterKind: record.afterKind,
      beforeStatus: record.beforeStatus,
      afterStatus: record.afterStatus,
      occurredAt: record.occurredAt,
      invalidatedAt: record.invalidatedAt,
    });
  }

  toRecord(): OperationLogRecord {
    return {
      operationId: this.operationId,
      categoryId: this.categoryId,
      userId: this.userId,
      dayKey: this.dayKey,
      lap: this.lap,
      bossIndex: this.bossIndex,
      targetAttackEntryId: this.targetAttackEntryId,
      operationType: this.operationType,
      beforeKind: this.beforeKind,
      afterKind: this.afterKind,
      beforeStatus: this.beforeStatus,
      afterStatus: this.afterStatus,
      occurredAt: cloneDate(this.occurredAt),
      invalidatedAt: cloneNullableDate(this.invalidatedAt),
    };
  }
}
