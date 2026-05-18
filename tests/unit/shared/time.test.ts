import { describe, expect, it } from "vitest";

import {
  createFixedClock,
  formatJstDate,
  getClanBattleDayKey,
  getClanBattleDayKeyFromClock,
  isClanBattleDayChanged,
  now,
} from "../../../src/shared/time.js";

describe("time utilities", () => {
  it("returns the injected fixed time", () => {
    const clock = createFixedClock("2026-03-06T20:00:00.000Z");

    expect(now(clock).toISOString()).toBe("2026-03-06T20:00:00.000Z");
    expect(getClanBattleDayKeyFromClock(clock)).toBe("2026-03-07");
  });

  it("treats JST 5:00 as the business day boundary", () => {
    const beforeReset = new Date("2026-03-06T19:59:59.000Z");
    const afterReset = new Date("2026-03-06T20:00:00.000Z");

    expect(getClanBattleDayKey(beforeReset)).toBe("2026-03-06");
    expect(getClanBattleDayKey(afterReset)).toBe("2026-03-07");
    expect(isClanBattleDayChanged(beforeReset, afterReset)).toBe(true);
  });

  it("formats a JST date label", () => {
    expect(formatJstDate(new Date("2026-03-06T20:00:00.000Z"))).toBe("03月07日");
  });
});
