import { DEFAULT_BOSS_NAMES } from "../constants/bossinfo-defaults.js";
import { type Clock, getClanBattleDayKeyFromClock, systemClock } from "../shared/time.js";
import { BossStatusData } from "./boss-status-data.js";
import type { PlayerData } from "./player-data.js";
import type { ReserveData } from "./reserve-data.js";

type BossMessageId = string | null;

export interface ClanDataParams {
  guildId: string;
  categoryId: string;
  bossChannelIds: readonly string[];
  remainAttackChannelId: string;
  reserveChannelId: string;
  commandChannelId: string;
  summaryChannelId: string;
  playerDataMap?: ReadonlyMap<string, PlayerData>;
  reserveList?: readonly ReserveData[][];
  bossStatusByLap?: ReadonlyMap<number, BossStatusData[]>;
  reserveMessageIds?: readonly BossMessageId[];
  remainAttackMessageId?: BossMessageId;
  progressMessageIdsByLap?: ReadonlyMap<number, readonly BossMessageId[]>;
  summaryMessageIdsByLap?: ReadonlyMap<number, readonly BossMessageId[]>;
  date?: string;
  clock?: Clock;
}

export interface ClanDataRecord {
  guildId: string;
  categoryId: string;
  bossChannelIds: string[];
  remainAttackChannelId: string;
  reserveChannelId: string;
  commandChannelId: string;
  summaryChannelId: string;
  reserveMessageIds: BossMessageId[];
  remainAttackMessageId: BossMessageId;
  progressMessageIdsByLap: Record<string, BossMessageId[]>;
  summaryMessageIdsByLap: Record<string, BossMessageId[]>;
  date: string;
}

function createBossSlots(): BossMessageId[] {
  return Array.from({ length: DEFAULT_BOSS_NAMES.length }, () => null);
}

function cloneBossMessageIds(value: readonly BossMessageId[] | undefined): BossMessageId[] {
  const row = value ? [...value] : createBossSlots();
  while (row.length < DEFAULT_BOSS_NAMES.length) {
    row.push(null);
  }
  return row.slice(0, DEFAULT_BOSS_NAMES.length);
}

function cloneMessageIdMap(
  value: ReadonlyMap<number, readonly BossMessageId[]> | undefined,
): Map<number, BossMessageId[]> {
  const nextMap = new Map<number, BossMessageId[]>();

  value?.forEach((messageIds, lap) => {
    nextMap.set(lap, cloneBossMessageIds(messageIds));
  });

  return nextMap;
}

function cloneReserveList(value: readonly ReserveData[][] | undefined): ReserveData[][] {
  const reserveList = value ? value.map((bossReserveList) => [...bossReserveList]) : [];

  while (reserveList.length < DEFAULT_BOSS_NAMES.length) {
    reserveList.push([]);
  }

  return reserveList.slice(0, DEFAULT_BOSS_NAMES.length);
}

function cloneBossStatusMap(
  value: ReadonlyMap<number, BossStatusData[]> | undefined,
): Map<number, BossStatusData[]> {
  const nextMap = new Map<number, BossStatusData[]>();

  value?.forEach((bossStatusList, lap) => {
    nextMap.set(
      lap,
      bossStatusList.map(
        (bossStatus) =>
          new BossStatusData({
            lap: bossStatus.lap,
            bossIndex: bossStatus.bossIndex,
            maxHp: bossStatus.maxHp,
            attackPlayers: bossStatus.attackPlayers,
            beated: bossStatus.beated,
          }),
      ),
    );
  });

  return nextMap;
}

export class ClanData {
  readonly guildId: string;
  readonly categoryId: string;
  readonly bossChannelIds: string[];
  readonly remainAttackChannelId: string;
  reserveChannelId: string;
  readonly commandChannelId: string;
  readonly summaryChannelId: string;

  readonly playerDataMap: Map<string, PlayerData>;
  reserveList: ReserveData[][];
  bossStatusByLap: Map<number, BossStatusData[]>;
  reserveMessageIds: BossMessageId[];
  remainAttackMessageId: BossMessageId;
  progressMessageIdsByLap: Map<number, BossMessageId[]>;
  summaryMessageIdsByLap: Map<number, BossMessageId[]>;
  date: string;

  constructor(params: ClanDataParams) {
    this.guildId = params.guildId;
    this.categoryId = params.categoryId;
    this.bossChannelIds = [...params.bossChannelIds];
    this.remainAttackChannelId = params.remainAttackChannelId;
    this.reserveChannelId = params.reserveChannelId;
    this.commandChannelId = params.commandChannelId;
    this.summaryChannelId = params.summaryChannelId;
    this.playerDataMap = new Map(params.playerDataMap);
    this.reserveList = cloneReserveList(params.reserveList);
    this.bossStatusByLap = cloneBossStatusMap(params.bossStatusByLap);
    this.reserveMessageIds = cloneBossMessageIds(params.reserveMessageIds);
    this.remainAttackMessageId = params.remainAttackMessageId ?? null;
    this.progressMessageIdsByLap = cloneMessageIdMap(params.progressMessageIdsByLap);
    this.summaryMessageIdsByLap = cloneMessageIdMap(params.summaryMessageIdsByLap);
    this.date = params.date ?? getClanBattleDayKeyFromClock(params.clock ?? systemClock);
  }

  static fromRecord(record: ClanDataRecord): ClanData {
    return new ClanData({
      guildId: record.guildId,
      categoryId: record.categoryId,
      bossChannelIds: record.bossChannelIds,
      remainAttackChannelId: record.remainAttackChannelId,
      reserveChannelId: record.reserveChannelId,
      commandChannelId: record.commandChannelId,
      summaryChannelId: record.summaryChannelId,
      reserveMessageIds: record.reserveMessageIds,
      remainAttackMessageId: record.remainAttackMessageId,
      progressMessageIdsByLap: new Map(
        Object.entries(record.progressMessageIdsByLap).map(([lap, messageIds]) => [
          Number.parseInt(lap, 10),
          messageIds,
        ]),
      ),
      summaryMessageIdsByLap: new Map(
        Object.entries(record.summaryMessageIdsByLap).map(([lap, messageIds]) => [
          Number.parseInt(lap, 10),
          messageIds,
        ]),
      ),
      date: record.date,
    });
  }

  initializeBossStatusData(lap: number): void {
    this.bossStatusByLap.set(
      lap,
      Array.from({ length: DEFAULT_BOSS_NAMES.length }, (_, bossIndex) =>
        new BossStatusData({
          lap,
          bossIndex,
          guildId: this.guildId,
        }),
      ),
    );
  }

  addPlayerData(playerData: PlayerData): void {
    this.playerDataMap.set(playerData.userId, playerData);
  }

  getPlayerData(userId: string): PlayerData | undefined {
    return this.playerDataMap.get(userId);
  }

  getBossIndexFromChannelId(channelId: string): number | undefined {
    const bossIndex = this.bossChannelIds.indexOf(channelId);
    return bossIndex === -1 ? undefined : bossIndex;
  }

  getLapFromMessageId(messageId: string, bossIndex: number): number | undefined {
    for (const [lap, messageIds] of this.progressMessageIdsByLap.entries()) {
      if (messageIds[bossIndex] === messageId) {
        return lap;
      }
    }

    return undefined;
  }

  getLatestLap(bossIndex?: number): number {
    const laps = [...this.progressMessageIdsByLap.keys()].sort((left, right) => right - left);

    if (laps.length === 0) {
      throw new Error("progress message ids are empty");
    }

    if (bossIndex === undefined) {
      return laps[0]!;
    }

    for (const lap of laps) {
      const messageId = this.progressMessageIdsByLap.get(lap)?.[bossIndex];
      if (messageId) {
        return lap;
      }
    }

    return laps[0]!;
  }

  initializeProgressData(): void {
    this.progressMessageIdsByLap = new Map();
    this.bossStatusByLap = new Map();
    this.summaryMessageIdsByLap = new Map();
  }

  retireLegacyReserve(): void {
    this.reserveChannelId = "0";
    this.reserveList = cloneReserveList(undefined);
    this.reserveMessageIds = cloneBossMessageIds(undefined);
  }

  toRecord(): ClanDataRecord {
    return {
      guildId: this.guildId,
      categoryId: this.categoryId,
      bossChannelIds: [...this.bossChannelIds],
      remainAttackChannelId: this.remainAttackChannelId,
      reserveChannelId: this.reserveChannelId,
      commandChannelId: this.commandChannelId,
      summaryChannelId: this.summaryChannelId,
      reserveMessageIds: cloneBossMessageIds(this.reserveMessageIds),
      remainAttackMessageId: this.remainAttackMessageId,
      progressMessageIdsByLap: Object.fromEntries(
        [...this.progressMessageIdsByLap.entries()].map(([lap, messageIds]) => [
          String(lap),
          cloneBossMessageIds(messageIds),
        ]),
      ),
      summaryMessageIdsByLap: Object.fromEntries(
        [...this.summaryMessageIdsByLap.entries()].map(([lap, messageIds]) => [
          String(lap),
          cloneBossMessageIds(messageIds),
        ]),
      ),
      date: this.date,
    };
  }
}
