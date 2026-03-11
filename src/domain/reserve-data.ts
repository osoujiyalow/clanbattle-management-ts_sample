import { EMOJIS } from "../constants/emojis.js";
import { type Clock, systemClock } from "../shared/time.js";
import type { AttackType } from "./attack-type.js";
import type { PlayerData } from "./player-data.js";

export enum ReserveType {
  ONLY = "🚫",
  ANY = "⚠️",
}

export const RESERVE_TYPE_BY_INPUT: Readonly<Record<string, ReserveType>> = {
  [EMOJIS.only]: ReserveType.ONLY,
  [EMOJIS.any]: ReserveType.ANY,
};

export type ReserveInfo = readonly [number, string, boolean];

export interface ReserveDataRecord {
  playerUserId: string;
  attackType: AttackType;
  damage: number;
  memo: string;
  carryOver: boolean;
}

function formatDamage(value: number): string {
  return value.toLocaleString("en-US");
}

export class ReserveData {
  readonly playerData: PlayerData;
  readonly attackType: AttackType;
  damage: number;
  memo: string;
  carryOver: boolean;

  constructor(playerData: PlayerData, attackType: AttackType) {
    this.playerData = playerData;
    this.attackType = attackType;
    this.damage = -1;
    this.memo = "";
    this.carryOver = false;
  }

  static fromRecord(record: ReserveDataRecord, playerData: PlayerData): ReserveData {
    const reserveData = new ReserveData(playerData, record.attackType);
    reserveData.damage = record.damage;
    reserveData.memo = record.memo;
    reserveData.carryOver = record.carryOver;
    return reserveData;
  }

  createReserveTxt(displayName: string, clock: Clock = systemClock): string {
    let text = this.attackType;

    if (this.damage !== -1) {
      text += ` ${formatDamage(this.damage)}万 ${this.memo} `;
      if (this.carryOver) {
        text += "持ち越し";
      }
    }

    text += this.playerData.createSimpleTxt(displayName, clock);
    return text;
  }

  setReserveInfo([damage, memo, carryOver]: ReserveInfo): void {
    this.damage = damage;
    this.memo = memo;
    this.carryOver = carryOver;
  }

  toRecord(): ReserveDataRecord {
    return {
      playerUserId: this.playerData.userId,
      attackType: this.attackType,
      damage: this.damage,
      memo: this.memo,
      carryOver: this.carryOver,
    };
  }

  toString(): string {
    let text = this.attackType;

    if (this.damage !== -1) {
      text += ` ${formatDamage(this.damage)}万 ${this.memo} `;
      if (this.carryOver) {
        text += "持ち越し";
      }
    }

    return text;
  }
}
