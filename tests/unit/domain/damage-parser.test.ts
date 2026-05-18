import { describe, expect, it } from "vitest";

import { parseDamageMessage } from "../../../src/domain/util/damage-parser.js";

describe("parseDamageMessage", () => {
  it("parses a normal damage message", () => {
    expect(parseDamageMessage("600 60s討伐")).toEqual({
      damage: 600,
      memo: "60s討伐",
    });
  });

  it("normalizes full-width digits", () => {
    expect(parseDamageMessage("６００")).toEqual({
      damage: 600,
      memo: "",
    });
  });

  it("removes 万 from the first token", () => {
    expect(parseDamageMessage("６００万 持越し")).toEqual({
      damage: 600,
      memo: "持越し",
    });
  });

  it("keeps large man-unit values as-is", () => {
    expect(parseDamageMessage("1200000 finish")).toEqual({
      damage: 1200000,
      memo: "finish",
    });
  });

  it("joins the remaining tokens into a memo", () => {
    expect(parseDamageMessage("600  〆  よろしく")).toEqual({
      damage: 600,
      memo: "〆 よろしく",
    });
  });

  it("returns null when the first token is not numeric", () => {
    expect(parseDamageMessage("abc 600")).toBeNull();
    expect(parseDamageMessage("")).toBeNull();
  });
});
