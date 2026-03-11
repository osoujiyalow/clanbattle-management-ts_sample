import { AttackStatus, type AttackStatusRecord } from "./attack-status.js";
import { ClanBattleData } from "./clan-battle-data.js";
import type { PlayerData } from "./player-data.js";

export interface BossStatusDataParams {
  lap: number;
  bossIndex: number;
  guildId?: string | null;
  maxHp?: number;
  attackPlayers?: AttackStatus[];
  beated?: boolean;
}

export interface BossStatusDataRecord {
  lap: number;
  bossIndex: number;
  maxHp: number;
  attackPlayers: AttackStatusRecord[];
  beated: boolean;
}

export class BossStatusData {
  readonly lap: number;
  readonly bossIndex: number;
  maxHp: number;
  attackPlayers: AttackStatus[];
  beated: boolean;

  constructor(params: BossStatusDataParams) {
    this.lap = params.lap;
    this.bossIndex = params.bossIndex;
    this.maxHp = params.maxHp ?? ClanBattleData.getHp(params.lap, params.bossIndex, params.guildId);
    this.attackPlayers =
      params.attackPlayers?.map((status) =>
        AttackStatus.fromRecord(status.toRecord(), status.playerData),
      ) ?? [];
    this.beated = params.beated ?? false;
  }

  static fromRecord(
    record: BossStatusDataRecord,
    playerDataMap: ReadonlyMap<string, PlayerData>,
  ): BossStatusData {
    return new BossStatusData({
      lap: record.lap,
      bossIndex: record.bossIndex,
      maxHp: record.maxHp,
      attackPlayers: record.attackPlayers.flatMap((attackStatus) => {
        const playerData = playerDataMap.get(attackStatus.playerUserId);
        return playerData ? [AttackStatus.fromRecord(attackStatus, playerData)] : [];
      }),
      beated: record.beated,
    });
  }

  getAttackStatusIndex(playerData: PlayerData, attacked: boolean): number | undefined {
    for (let index = this.attackPlayers.length - 1; index >= 0; index -= 1) {
      const attackStatus = this.attackPlayers[index]!;
      if (attackStatus.playerData.userId === playerData.userId && attackStatus.attacked === attacked) {
        return index;
      }
    }

    return undefined;
  }

  toRecord(): BossStatusDataRecord {
    return {
      lap: this.lap,
      bossIndex: this.bossIndex,
      maxHp: this.maxHp,
      attackPlayers: this.attackPlayers.map((attackStatus) => attackStatus.toRecord()),
      beated: this.beated,
    };
  }
}
