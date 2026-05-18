import type { ClanData } from "../domain/clan-data.js";
import { type Clock, getClanBattleDayKeyFromClock, systemClock } from "./time.js";

export interface ClanBattleDayGuardResult {
  changed: boolean;
  previousDayKey: string;
  currentDayKey: string;
  shouldCreateRemainAttackMessage: boolean;
}

export function ensureClanBattleDay(
  clanData: ClanData,
  clock: Clock = systemClock,
): ClanBattleDayGuardResult {
  const currentDayKey = getClanBattleDayKeyFromClock(clock);
  const previousDayKey = clanData.date;

  if (previousDayKey === currentDayKey) {
    return {
      changed: false,
      previousDayKey,
      currentDayKey,
      shouldCreateRemainAttackMessage: false,
    };
  }

  clanData.date = currentDayKey;
  clanData.remainAttackMessageId = null;
  clanData.summaryMessageIdsByLap = new Map();

  for (const playerData of clanData.playerDataMap.values()) {
    playerData.initializeAttack();
  }

  return {
    changed: true,
    previousDayKey,
    currentDayKey,
    shouldCreateRemainAttackMessage: true,
  };
}
