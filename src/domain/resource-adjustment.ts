function cloneDate(date: Date): Date {
  return new Date(date.getTime());
}

export const ResourceAdjustmentType = {
  BATTLE: "battle",
  CARRYOVER: "carryover",
} as const;

export type ResourceAdjustmentType =
  (typeof ResourceAdjustmentType)[keyof typeof ResourceAdjustmentType];

export function parseResourceAdjustmentType(value: string): ResourceAdjustmentType | undefined {
  return (Object.values(ResourceAdjustmentType) as readonly string[]).find(
    (candidate) => candidate === value,
  ) as ResourceAdjustmentType | undefined;
}

export interface ResourceAdjustmentRecord {
  adjustmentId: string;
  categoryId: string;
  userId: string;
  actorUserId: string;
  dayKey: string;
  resourceType: ResourceAdjustmentType;
  remaining: number;
  occurredAt: Date;
}

export interface ResourceAdjustmentParams {
  adjustmentId: string;
  categoryId: string;
  userId: string;
  actorUserId: string;
  dayKey: string;
  resourceType: ResourceAdjustmentType;
  remaining: number;
  occurredAt: Date;
}

export class ResourceAdjustment {
  adjustmentId: string;
  categoryId: string;
  userId: string;
  actorUserId: string;
  dayKey: string;
  resourceType: ResourceAdjustmentType;
  remaining: number;
  occurredAt: Date;

  constructor(params: ResourceAdjustmentParams) {
    this.adjustmentId = params.adjustmentId;
    this.categoryId = params.categoryId;
    this.userId = params.userId;
    this.actorUserId = params.actorUserId;
    this.dayKey = params.dayKey;
    this.resourceType = params.resourceType;
    this.remaining = params.remaining;
    this.occurredAt = cloneDate(params.occurredAt);
  }

  static fromRecord(record: ResourceAdjustmentRecord): ResourceAdjustment {
    return new ResourceAdjustment(record);
  }

  toRecord(): ResourceAdjustmentRecord {
    return {
      adjustmentId: this.adjustmentId,
      categoryId: this.categoryId,
      userId: this.userId,
      actorUserId: this.actorUserId,
      dayKey: this.dayKey,
      resourceType: this.resourceType,
      remaining: this.remaining,
      occurredAt: cloneDate(this.occurredAt),
    };
  }
}
