import { describe, expect, it } from "vitest";

import {
  formatSqliteClanBattleDate,
  formatSqliteDateTime,
  normalizeSqliteDate,
  parseSqliteDateTime,
} from "../../../../src/repositories/sqlite/sqlite-time.js";

describe("sqlite-time", () => {
  it("formats JST datetimes in the Python-compatible sqlite shape", () => {
    expect(formatSqliteDateTime(new Date("2026-03-07T21:34:56.789+09:00"))).toBe(
      "2026-03-07 21:34:56.789000+09:00",
    );
  });

  it("parses timezone-aware and current_timestamp-like values", () => {
    expect(parseSqliteDateTime("2026-03-07 21:34:56.789000+09:00").toISOString()).toBe(
      "2026-03-07T12:34:56.789Z",
    );
    expect(parseSqliteDateTime("2026-03-07 12:00:00").toISOString()).toBe(
      "2026-03-07T12:00:00.000Z",
    );
  });

  it("formats clan battle day dates with the JST 5:00 boundary", () => {
    expect(formatSqliteClanBattleDate(new Date("2026-03-07T04:59:59+09:00"))).toBe("2026-03-06");
    expect(normalizeSqliteDate(new Date("2026-03-07T05:00:00+09:00"))).toBe("2026-03-07");
    expect(normalizeSqliteDate("2026-03-08")).toBe("2026-03-08");
  });
});
