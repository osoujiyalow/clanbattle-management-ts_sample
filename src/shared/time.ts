const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const CLAN_BATTLE_RESET_OFFSET_MS = 5 * 60 * 60 * 1000;

export const JST_TIMEZONE = "Asia/Tokyo";
export const CLAN_BATTLE_RESET_HOUR_JST = 5;

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function createFixedClock(value: Date | string | number): Clock {
  const fixedDate = new Date(value);

  return {
    now: () => new Date(fixedDate.getTime()),
  };
}

export function now(clock: Clock = systemClock): Date {
  return clock.now();
}

function toShiftedUtcDate(date: Date, offsetMs: number): Date {
  return new Date(date.getTime() + offsetMs);
}

export function getJstDateParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const shifted = toShiftedUtcDate(date, JST_OFFSET_MS);

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

export function formatJstDate(date: Date): string {
  const parts = getJstDateParts(date);

  return `${String(parts.month).padStart(2, "0")}月${String(parts.day).padStart(2, "0")}日`;
}

export function getClanBattleDayKey(date: Date): string {
  const shifted = toShiftedUtcDate(date, JST_OFFSET_MS - CLAN_BATTLE_RESET_OFFSET_MS);

  return [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export function getClanBattleDayKeyFromClock(clock: Clock = systemClock): string {
  return getClanBattleDayKey(now(clock));
}

export function isClanBattleDayChanged(previous: Date, next: Date): boolean {
  return getClanBattleDayKey(previous) !== getClanBattleDayKey(next);
}
