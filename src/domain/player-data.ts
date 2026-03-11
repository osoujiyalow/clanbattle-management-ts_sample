import { EMOJIS } from "../constants/emojis.js";
import { type Clock, getJstDateParts, now, systemClock } from "../shared/time.js";
import type { AttackType } from "./attack-type.js";
import { ClanBattleData } from "./clan-battle-data.js";
import type { OperationType } from "./operation-type.js";

export interface CarryOverRecord {
  attackType: AttackType;
  bossIndex: number;
  carryOverTime: number;
  created: Date;
}

export interface PlayerDataSnapshot {
  physicsAttack: number;
  magicAttack: number;
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
  physicsAttack: number;
  magicAttack: number;
  log: LogData[];
  carryOverList: CarryOverRecord[];
  rawLimitTimeText: string;
  taskKill: boolean;
}

export interface CarryOverParams {
  attackType: AttackType;
  bossIndex: number;
  carryOverTime?: number;
  created?: Date;
}

export interface PlayerDataParams {
  userId: string;
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
    attackType: record.attackType,
    bossIndex: record.bossIndex,
    carryOverTime: record.carryOverTime,
    created: cloneDate(record.created),
  };
}

function clonePlayerDataSnapshot(snapshot: PlayerDataSnapshot): PlayerDataSnapshot {
  return {
    physicsAttack: snapshot.physicsAttack,
    magicAttack: snapshot.magicAttack,
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
  attackType: AttackType;
  bossIndex: number;
  carryOverTime: number;
  created: Date;

  constructor(params: CarryOverParams) {
    this.attackType = params.attackType;
    this.bossIndex = params.bossIndex;
    this.carryOverTime = params.carryOverTime ?? -1;
    this.created = params.created ? cloneDate(params.created) : now();
  }

  static fromRecord(record: CarryOverRecord): CarryOver {
    return new CarryOver(record);
  }

  toRecord(): CarryOverRecord {
    return {
      attackType: this.attackType,
      bossIndex: this.bossIndex,
      carryOverTime: this.carryOverTime,
      created: cloneDate(this.created),
    };
  }

  toString(): string {
    const bossName =
      ClanBattleData.bossNames[this.bossIndex] ?? `${this.bossIndex + 1}ボス`;
    let text = `${formatJstHourMinute(this.created)}発生 ${bossName}`;

    if (this.carryOverTime !== -1) {
      text += ` ${this.carryOverTime}秒`;
    }

    return `${text}持ち越し`;
  }
}

export class PlayerData {
  readonly userId: string;
  physicsAttack: number;
  magicAttack: number;
  log: LogData[];
  carryOverList: CarryOver[];
  rawLimitTimeText: string;
  taskKill: boolean;

  constructor(params: PlayerDataParams) {
    this.userId = params.userId;
    this.physicsAttack = params.physicsAttack ?? 0;
    this.magicAttack = params.magicAttack ?? 0;
    this.log = params.log?.map(cloneLogData) ?? [];
    this.carryOverList =
      params.carryOverList?.map((carryOver) => CarryOver.fromRecord(carryOver.toRecord())) ?? [];
    this.rawLimitTimeText = params.rawLimitTimeText ?? "";
    this.taskKill = params.taskKill ?? false;
  }

  static fromRecord(record: PlayerDataRecord): PlayerData {
    return new PlayerData({
      userId: record.userId,
      physicsAttack: record.physicsAttack,
      magicAttack: record.magicAttack,
      log: record.log,
      carryOverList: record.carryOverList.map((carryOver) => CarryOver.fromRecord(carryOver)),
      rawLimitTimeText: record.rawLimitTimeText,
      taskKill: record.taskKill,
    });
  }

  initializeAttack(): void {
    this.physicsAttack = 0;
    this.magicAttack = 0;
    this.carryOverList = [];
    this.taskKill = false;
    this.rawLimitTimeText = "";
    this.log = [];
  }

  createTxt(displayName: string, clock: Clock = systemClock): string {
    let text = `${displayName}\t${EMOJIS.physics}${this.physicsAttack} ${EMOJIS.magic}${this.magicAttack}`;

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
    let text =
      `\n　　- ${displayName} ` +
      `(${this.physicsAttack + this.magicAttack}/3 物${this.physicsAttack}魔${this.magicAttack})`;

    if (this.taskKill) {
      text += ` ${EMOJIS.taskKill}`;
    }

    if (this.rawLimitTimeText) {
      text += ` ${createLimitTimeText(this.rawLimitTimeText, clock)}`;
    }

    return text;
  }

  applySnapshot(snapshot: PlayerDataSnapshot): void {
    this.physicsAttack = snapshot.physicsAttack;
    this.magicAttack = snapshot.magicAttack;
    this.carryOverList = snapshot.carryOverList.map((carryOver) => CarryOver.fromRecord(carryOver));
  }

  toSnapshot(): PlayerDataSnapshot {
    return {
      physicsAttack: this.physicsAttack,
      magicAttack: this.magicAttack,
      carryOverList: this.carryOverList.map((carryOver) => carryOver.toRecord()),
    };
  }

  toRecord(): PlayerDataRecord {
    return {
      userId: this.userId,
      physicsAttack: this.physicsAttack,
      magicAttack: this.magicAttack,
      log: this.log.map(cloneLogData),
      carryOverList: this.carryOverList.map((carryOver) => carryOver.toRecord()),
      rawLimitTimeText: this.rawLimitTimeText,
      taskKill: this.taskKill,
    };
  }
}
