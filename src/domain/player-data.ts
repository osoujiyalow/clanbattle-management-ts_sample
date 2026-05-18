import { EMOJIS } from "../constants/emojis.js";
import { type Clock, getJstDateParts, now, systemClock } from "../shared/time.js";
import {
  normalizeAttackType,
  type AttackType as AttackTypeValue,
} from "./attack-type.js";
import { ClanBattleData } from "./clan-battle-data.js";
import type { OperationType } from "./operation-type.js";

export interface CarryOverRecord {
  attackType: AttackTypeValue;
  bossIndex: number;
  created: Date;
}

export interface PlayerDataSnapshot {
  battleAttackCount?: number;
  physicsAttack?: number;
  magicAttack?: number;
  carryOverList: CarryOverRecord[];
}

export interface LogData {
  operationType: OperationType;
  lap: number;
  bossIndex: number;
  playerData?: PlayerDataSnapshot;
  beated?: boolean;
}

export interface PlayerDataRecord {
  userId: string;
  battleAttackCount?: number;
  physicsAttack?: number;
  magicAttack?: number;
  log: LogData[];
  carryOverList: CarryOverRecord[];
  rawLimitTimeText: string;
  taskKill: boolean;
}

export interface CarryOverParams {
  attackType: AttackTypeValue;
  bossIndex: number;
  created?: Date;
}

export interface PlayerDataParams {
  userId: string;
  battleAttackCount?: number;
  physicsAttack?: number;
  magicAttack?: number;
  log?: LogData[];
  carryOverList?: CarryOver[];
  rawLimitTimeText?: string;
  taskKill?: boolean;
}

function cloneDate(date: Date): Date {
  return new Date(date.getTime());
}

function cloneCarryOverRecord(record: CarryOverRecord): CarryOverRecord {
  return {
    attackType: normalizeAttackType(record.attackType) ?? record.attackType,
    bossIndex: record.bossIndex,
    created: cloneDate(record.created),
  };
}

function clonePlayerDataSnapshot(snapshot: PlayerDataSnapshot): PlayerDataSnapshot {
  return {
    ...(snapshot.battleAttackCount !== undefined
      ? { battleAttackCount: snapshot.battleAttackCount }
      : {}),
    ...(snapshot.physicsAttack !== undefined ? { physicsAttack: snapshot.physicsAttack } : {}),
    ...(snapshot.magicAttack !== undefined ? { magicAttack: snapshot.magicAttack } : {}),
    carryOverList: snapshot.carryOverList.map(cloneCarryOverRecord),
  };
}

function cloneLogData(log: LogData): LogData {
  const clonedLog: LogData = {
    operationType: log.operationType,
    lap: log.lap,
    bossIndex: log.bossIndex,
  };

  if (log.playerData) {
    clonedLog.playerData = clonePlayerDataSnapshot(log.playerData);
  }

  if (log.beated !== undefined) {
    clonedLog.beated = log.beated;
  }

  return clonedLog;
}

function formatJstHourMinute(date: Date): string {
  const parts = getJstDateParts(date);
  return `${String(parts.hour).padStart(2, "0")}時${String(parts.minute).padStart(2, "0")}分`;
}

function mergeLimitTimeSpans(rawLimitTimeText: string): [number, number][] {
  const spans = rawLimitTimeText
    .split(", ")
    .filter((span) => span.length > 0)
    .map((span) => {
      const [minHour, maxHour] = span.replaceAll("時", "").split("～");
      return [Number.parseInt(minHour ?? "", 10), Number.parseInt(maxHour ?? "", 10)] as [
        number,
        number,
      ];
    });

  if (spans.length === 0) {
    return [];
  }

  const merged: [number, number][] = [];
  let [minHour, maxHour] = spans[0]!;

  for (const [nextMinHour, nextMaxHour] of spans.slice(1)) {
    if (maxHour === nextMinHour) {
      maxHour = nextMaxHour;
      continue;
    }

    merged.push([minHour, maxHour]);
    minHour = nextMinHour;
    maxHour = nextMaxHour;
  }

  merged.push([minHour, maxHour]);
  return merged;
}

export function createLimitTimeText(
  rawLimitTimeText: string,
  clock: Clock = systemClock,
): string {
  if (!rawLimitTimeText) {
    return "";
  }

  const mergedSpans = mergeLimitTimeSpans(rawLimitTimeText);
  let nowHour = getJstDateParts(now(clock)).hour;
  if (nowHour < 5) {
    nowHour += 24;
  }

  const timeTextList: string[] = [];

  mergedSpans.forEach(([spanStart, spanEnd], index) => {
    if (spanEnd <= nowHour) {
      if (index === mergedSpans.length - 1) {
        timeTextList.push(`～${spanEnd}時`);
      }
      return;
    }

    if (spanStart > nowHour) {
      timeTextList.push(`${spanStart}～${spanEnd}時`);
      return;
    }

    timeTextList.push(`～${spanEnd}時`);
  });

  return timeTextList.join(", ");
}

export class CarryOver {
  attackType: AttackTypeValue;
  bossIndex: number;
  created: Date;

  constructor(params: CarryOverParams) {
    this.attackType = normalizeAttackType(params.attackType) ?? params.attackType;
    this.bossIndex = params.bossIndex;
    this.created = params.created ? cloneDate(params.created) : now();
  }

  static fromRecord(record: CarryOverRecord): CarryOver {
    return new CarryOver(record);
  }

  toRecord(): CarryOverRecord {
    return {
      attackType: this.attackType,
      bossIndex: this.bossIndex,
      created: cloneDate(this.created),
    };
  }

  toString(): string {
    if (this.bossIndex < 0) {
      return `${formatJstHourMinute(this.created)}発生 管理補正持越し`;
    }

    const bossName =
      ClanBattleData.bossNames[this.bossIndex] ?? `${this.bossIndex + 1}ボス`;
    return `${formatJstHourMinute(this.created)}発生 ${bossName}持ち越し`;
  }
}

interface ResolvedBattleAttackCounters {
  battleAttackCount: number;
  physicsAttack: number;
  magicAttack: number;
}

function resolveBattleAttackCounters(params: PlayerDataParams | PlayerDataRecord | PlayerDataSnapshot): ResolvedBattleAttackCounters {
  const battleAttackCount = params.battleAttackCount;
  const physicsAttack = params.physicsAttack;
  const magicAttack = params.magicAttack;

  if (physicsAttack !== undefined || magicAttack !== undefined) {
    const resolvedPhysicsAttack = physicsAttack ?? 0;
    const resolvedMagicAttack = magicAttack ?? 0;

    return {
      battleAttackCount: battleAttackCount ?? resolvedPhysicsAttack + resolvedMagicAttack,
      physicsAttack: resolvedPhysicsAttack,
      magicAttack: resolvedMagicAttack,
    };
  }

  return {
    battleAttackCount: battleAttackCount ?? 0,
    physicsAttack: battleAttackCount ?? 0,
    magicAttack: 0,
  };
}

export class PlayerData {
  readonly userId: string;
  private _battleAttackCount: number;
  private _physicsAttack: number;
  private _magicAttack: number;
  log: LogData[];
  carryOverList: CarryOver[];
  rawLimitTimeText: string;
  taskKill: boolean;

  constructor(params: PlayerDataParams) {
    const resolvedCounters = resolveBattleAttackCounters(params);

    this.userId = params.userId;
    this._battleAttackCount = resolvedCounters.battleAttackCount;
    this._physicsAttack = resolvedCounters.physicsAttack;
    this._magicAttack = resolvedCounters.magicAttack;
    this.log = params.log?.map(cloneLogData) ?? [];
    this.carryOverList =
      params.carryOverList?.map((carryOver) => CarryOver.fromRecord(carryOver.toRecord())) ?? [];
    this.rawLimitTimeText = params.rawLimitTimeText ?? "";
    this.taskKill = params.taskKill ?? false;
  }

  static fromRecord(record: PlayerDataRecord): PlayerData {
    return new PlayerData({
      userId: record.userId,
      ...(record.battleAttackCount !== undefined
        ? { battleAttackCount: record.battleAttackCount }
        : {}),
      ...(record.physicsAttack !== undefined ? { physicsAttack: record.physicsAttack } : {}),
      ...(record.magicAttack !== undefined ? { magicAttack: record.magicAttack } : {}),
      log: record.log,
      carryOverList: record.carryOverList.map((carryOver) => CarryOver.fromRecord(carryOver)),
      rawLimitTimeText: record.rawLimitTimeText,
      taskKill: record.taskKill,
    });
  }

  get battleAttackCount(): number {
    return this._battleAttackCount;
  }

  set battleAttackCount(value: number) {
    this._battleAttackCount = value;
    this._physicsAttack = value;
    this._magicAttack = 0;
  }

  get physicsAttack(): number {
    return this._physicsAttack;
  }

  set physicsAttack(value: number) {
    this._physicsAttack = value;
    this._battleAttackCount = this._physicsAttack + this._magicAttack;
  }

  get magicAttack(): number {
    return this._magicAttack;
  }

  set magicAttack(value: number) {
    this._magicAttack = value;
    this._battleAttackCount = this._physicsAttack + this._magicAttack;
  }

  incrementBattleAttackCount(): void {
    if (this._battleAttackCount >= 3) {
      return;
    }

    this._battleAttackCount += 1;
    this._physicsAttack += 1;
  }

  initializeAttack(): void {
    this._battleAttackCount = 0;
    this._physicsAttack = 0;
    this._magicAttack = 0;
    this.carryOverList = [];
    this.taskKill = false;
    this.rawLimitTimeText = "";
    this.log = [];
  }

  createTxt(displayName: string, clock: Clock = systemClock): string {
    let text = displayName;

    if (this.taskKill) {
      text += ` ${EMOJIS.taskKill}`;
    }

    if (this.rawLimitTimeText) {
      text += ` ${createLimitTimeText(this.rawLimitTimeText, clock)}`;
    }

    if (this.carryOverList.length > 0) {
      text += `\n　　- ${this.carryOverList.map((carryOver) => carryOver.toString()).join("\n　　- ")}`;
    }

    return text;
  }

  createSimpleTxt(displayName: string, clock: Clock = systemClock): string {
    let text = `\n　　- ${displayName} (本戦凸 ${this.battleAttackCount}/3)`;

    if (this.taskKill) {
      text += ` ${EMOJIS.taskKill}`;
    }

    if (this.rawLimitTimeText) {
      text += ` ${createLimitTimeText(this.rawLimitTimeText, clock)}`;
    }

    return text;
  }

  createCompactProgressTxt(displayName: string, clock: Clock = systemClock): string {
    let text = `\n　　- ${displayName} (${this.battleAttackCount}/3)`;

    if (this.taskKill) {
      text += ` ${EMOJIS.taskKill}`;
    }

    if (this.rawLimitTimeText) {
      text += ` ${createLimitTimeText(this.rawLimitTimeText, clock)}`;
    }

    return text;
  }

  applySnapshot(snapshot: PlayerDataSnapshot): void {
    const resolvedCounters = resolveBattleAttackCounters(snapshot);
    this._battleAttackCount = resolvedCounters.battleAttackCount;
    this._physicsAttack = resolvedCounters.physicsAttack;
    this._magicAttack = resolvedCounters.magicAttack;
    this.carryOverList = snapshot.carryOverList.map((carryOver) => CarryOver.fromRecord(carryOver));
  }

  toSnapshot(): PlayerDataSnapshot {
    return {
      battleAttackCount: this.battleAttackCount,
      physicsAttack: this.physicsAttack,
      magicAttack: this.magicAttack,
      carryOverList: this.carryOverList.map((carryOver) => carryOver.toRecord()),
    };
  }

  toRecord(): PlayerDataRecord {
    return {
      userId: this.userId,
      battleAttackCount: this.battleAttackCount,
      physicsAttack: this.physicsAttack,
      magicAttack: this.magicAttack,
      log: this.log.map(cloneLogData),
      carryOverList: this.carryOverList.map((carryOver) => carryOver.toRecord()),
      rawLimitTimeText: this.rawLimitTimeText,
      taskKill: this.taskKill,
    };
  }
}
