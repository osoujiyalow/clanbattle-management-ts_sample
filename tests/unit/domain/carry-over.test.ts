import { describe, expect, it } from "vitest";

import { calcCarryOverTime } from "../../../src/domain/util/carry-over.js";

describe("calcCarryOverTime", () => {
  it("matches the Python formula for a normal value", () => {
    expect(calcCarryOverTime(100, 200)).toBe(65);
  });

  it("clamps to the minimum of 20 seconds", () => {
    expect(calcCarryOverTime(1000, 100)).toBe(20);
  });

  it("clamps to the maximum of 90 seconds", () => {
    expect(calcCarryOverTime(0, 1)).toBe(90);
  });

  it("rejects invalid inputs", () => {
    expect(() => calcCarryOverTime(0, 0)).toThrow("damage must be positive");
    expect(() => calcCarryOverTime(-1, 100)).toThrow("remain_hp must be >= 0");
  });
});
