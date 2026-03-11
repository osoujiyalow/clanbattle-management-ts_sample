import { getClanBattleDayKey, getJstDateParts } from "../../shared/time.js";

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function getJstMilliseconds(date: Date): number {
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return shifted.getUTCMilliseconds();
}

function normalizeSqliteDateTimeText(value: string): string {
  const trimmed = value.trim();
  const withTimeSeparator = trimmed.includes(" ") ? trimmed.replace(" ", "T") : trimmed;

  if (/^\d{4}-\d{2}-\d{2}T/u.test(withTimeSeparator) && !/[zZ]|[+-]\d{2}:\d{2}$/u.test(withTimeSeparator)) {
    return `${withTimeSeparator}Z`;
  }

  return withTimeSeparator.replace(
    /\.(\d{3})\d+(?=(?:[zZ]|[+-]\d{2}:\d{2})$)/u,
    ".$1",
  );
}

export function formatSqliteDateTime(date: Date): string {
  const parts = getJstDateParts(date);
  const milliseconds = pad(getJstMilliseconds(date), 3);

  return [
    `${parts.year}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`,
    `${pad(parts.hour, 2)}:${pad(parts.minute, 2)}:${pad(parts.second, 2)}.${milliseconds}000+09:00`,
  ].join(" ");
}

export function parseSqliteDateTime(value: string | Date): Date {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  const parsed = new Date(normalizeSqliteDateTimeText(value));

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`invalid sqlite datetime: ${value}`);
  }

  return parsed;
}

export function formatSqliteClanBattleDate(date: Date): string {
  return getClanBattleDayKey(date);
}

export function normalizeSqliteDate(value: string | Date): string {
  if (value instanceof Date) {
    return formatSqliteClanBattleDate(value);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error(`invalid sqlite date: ${value}`);
  }

  return value;
}
