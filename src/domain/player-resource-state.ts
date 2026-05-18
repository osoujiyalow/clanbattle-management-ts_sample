export interface PlayerResourceStateRecord {
  categoryId: string;
  userId: string;
  dayKey: string;
  battleReservedCount: number;
  battleConsumedCount: number;
  carryAvailableCount: number;
  carryReservedCount: number;
}

export interface PlayerResourceStateParams {
  categoryId: string;
  userId: string;
  dayKey: string;
  battleReservedCount?: number;
  battleConsumedCount?: number;
  carryAvailableCount?: number;
  carryReservedCount?: number;
}

export class PlayerResourceState {
  categoryId: string;
  userId: string;
  dayKey: string;
  battleReservedCount: number;
  battleConsumedCount: number;
  carryAvailableCount: number;
  carryReservedCount: number;

  constructor(params: PlayerResourceStateParams) {
    this.categoryId = params.categoryId;
    this.userId = params.userId;
    this.dayKey = params.dayKey;
    this.battleReservedCount = params.battleReservedCount ?? 0;
    this.battleConsumedCount = params.battleConsumedCount ?? 0;
    this.carryAvailableCount = params.carryAvailableCount ?? 0;
    this.carryReservedCount = params.carryReservedCount ?? 0;
  }

  static fromRecord(record: PlayerResourceStateRecord): PlayerResourceState {
    return new PlayerResourceState(record);
  }

  get occupiedBattleCount(): number {
    return this.battleReservedCount + this.battleConsumedCount;
  }

  get totalCarryCount(): number {
    return this.carryAvailableCount + this.carryReservedCount;
  }

  toRecord(): PlayerResourceStateRecord {
    return {
      categoryId: this.categoryId,
      userId: this.userId,
      dayKey: this.dayKey,
      battleReservedCount: this.battleReservedCount,
      battleConsumedCount: this.battleConsumedCount,
      carryAvailableCount: this.carryAvailableCount,
      carryReservedCount: this.carryReservedCount,
    };
  }
}
