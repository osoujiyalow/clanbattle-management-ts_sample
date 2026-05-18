function cloneDate(date: Date): Date {
  return new Date(date.getTime());
}

function cloneNullableDate(date: Date | null): Date | null {
  return date ? cloneDate(date) : null;
}

export const AttackEntryKind = {
  BATTLE: "battle",
  CARRYOVER: "carryover",
} as const;

export type AttackEntryKind = (typeof AttackEntryKind)[keyof typeof AttackEntryKind];

export function parseAttackEntryKind(value: string): AttackEntryKind | undefined {
  return (Object.values(AttackEntryKind) as readonly string[]).find(
    (candidate) => candidate === value,
  ) as AttackEntryKind | undefined;
}

export const AttackEntryStatus = {
  DECLARED: "declared",
  FINISHED: "finished",
  DEFEATED: "defeated",
  EXPIRED: "expired",
  UNDONE: "undone",
} as const;

export type AttackEntryStatus = (typeof AttackEntryStatus)[keyof typeof AttackEntryStatus];

export function parseAttackEntryStatus(value: string): AttackEntryStatus | undefined {
  return (Object.values(AttackEntryStatus) as readonly string[]).find(
    (candidate) => candidate === value,
  ) as AttackEntryStatus | undefined;
}

export interface AttackEntryRecord {
  attackEntryId: string;
  categoryId: string;
  userId: string;
  dayKey: string;
  lap: number;
  bossIndex: number;
  kind: AttackEntryKind;
  status: AttackEntryStatus;
  declaredAt: Date;
  resolvedAt: Date | null;
  damage: number | null;
  memo: string | null;
}

export interface AttackEntryParams {
  attackEntryId: string;
  categoryId: string;
  userId: string;
  dayKey: string;
  lap: number;
  bossIndex: number;
  kind: AttackEntryKind;
  status: AttackEntryStatus;
  declaredAt: Date;
  resolvedAt?: Date | null;
  damage?: number | null;
  memo?: string | null;
}

export class AttackEntry {
  attackEntryId: string;
  categoryId: string;
  userId: string;
  dayKey: string;
  lap: number;
  bossIndex: number;
  kind: AttackEntryKind;
  status: AttackEntryStatus;
  declaredAt: Date;
  resolvedAt: Date | null;
  damage: number | null;
  memo: string | null;

  constructor(params: AttackEntryParams) {
    this.attackEntryId = params.attackEntryId;
    this.categoryId = params.categoryId;
    this.userId = params.userId;
    this.dayKey = params.dayKey;
    this.lap = params.lap;
    this.bossIndex = params.bossIndex;
    this.kind = params.kind;
    this.status = params.status;
    this.declaredAt = cloneDate(params.declaredAt);
    this.resolvedAt = cloneNullableDate(params.resolvedAt ?? null);
    this.damage = params.damage ?? null;
    this.memo = params.memo ?? null;
  }

  static fromRecord(record: AttackEntryRecord): AttackEntry {
    return new AttackEntry({
      attackEntryId: record.attackEntryId,
      categoryId: record.categoryId,
      userId: record.userId,
      dayKey: record.dayKey,
      lap: record.lap,
      bossIndex: record.bossIndex,
      kind: record.kind,
      status: record.status,
      declaredAt: record.declaredAt,
      resolvedAt: record.resolvedAt,
      damage: record.damage,
      memo: record.memo,
    });
  }

  toRecord(): AttackEntryRecord {
    return {
      attackEntryId: this.attackEntryId,
      categoryId: this.categoryId,
      userId: this.userId,
      dayKey: this.dayKey,
      lap: this.lap,
      bossIndex: this.bossIndex,
      kind: this.kind,
      status: this.status,
      declaredAt: cloneDate(this.declaredAt),
      resolvedAt: cloneNullableDate(this.resolvedAt),
      damage: this.damage,
      memo: this.memo,
    };
  }
}
