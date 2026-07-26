import {
  AttackType,
  normalizeAttackType,
  type AttackType as AttackTypeValue,
} from "./attack-type.js";
import type { PlayerData } from "./player-data.js";
import { calcCarryOverTime } from "./util/carry-over.js";

export interface AttackStatusParams {
  playerData: PlayerData;
  attackType: AttackTypeValue;
  carryOver: boolean;
  damage?: number;
  memo?: string;
  attacked?: boolean;
  created?: Date;
}

export interface AttackStatusRecord {
  playerUserId: string;
  damage: number;
  memo: string;
  attacked: boolean;
  attackType: AttackTypeValue;
  carryOver: boolean;
  created: Date;
}

function cloneDate(date: Date): Date {
  return new Date(date.getTime());
}

function formatDamage(value: number): string {
  return value.toLocaleString("en-US");
}

export class AttackStatus {
  readonly playerData: PlayerData;
  damage: number;
  memo: string;
  attacked: boolean;
  attackType: AttackTypeValue;
  carryOver: boolean;
  created: Date;

  constructor(params: AttackStatusParams) {
    this.playerData = params.playerData;
    this.damage = params.damage ?? 0;
    this.memo = params.memo ?? "";
    this.attacked = params.attacked ?? false;
    this.attackType = normalizeAttackType(params.attackType) ?? params.attackType;
    this.carryOver = params.carryOver;
    this.created = params.created ? cloneDate(params.created) : new Date();
  }

  static fromRecord(record: AttackStatusRecord, playerData: PlayerData): AttackStatus {
    return new AttackStatus({
      playerData,
      damage: record.damage,
      memo: record.memo,
      attacked: record.attacked,
      attackType: record.attackType,
      carryOver: record.carryOver,
      created: record.created,
    });
  }

  createAttackStatusTxt(displayName: string, currentHp: number): string {
    const segments = [this.attackType, `${formatDamage(this.damage)}万`];
    if (this.memo) {
      segments.push(this.memo);
    }

    let text = segments.join(" ");

    if (0 < currentHp && currentHp < this.damage) {
      text += ` 持ち越し発生: ${calcCarryOverTime(currentHp, this.damage)}秒`;
    }

    text += this.playerData.createCompactProgressTxt(displayName);
    return text;
  }

  updateAttackLog(): void {
    if (this.playerData.battleAttackCount >= this.playerData.battleAttackLimit) {
      return;
    }

    this.playerData.incrementBattleAttackCount();
  }

  setAttackType(attackType: AttackTypeValue): void {
    this.attackType = normalizeAttackType(attackType) ?? attackType;
    this.carryOver = this.attackType === AttackType.CARRYOVER;
  }

  toRecord(): AttackStatusRecord {
    return {
      playerUserId: this.playerData.userId,
      damage: this.damage,
      memo: this.memo,
      attacked: this.attacked,
      attackType: this.attackType,
      carryOver: this.carryOver,
      created: cloneDate(this.created),
    };
  }
}
