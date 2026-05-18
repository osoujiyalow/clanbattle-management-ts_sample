import { describe, expect, it } from "vitest";

import { EMOJIS } from "../../../src/constants/emojis.js";
import {
  ATTACK_TYPE_INPUTS,
  AttackType,
  formatAttackTypeLabel,
  normalizeAttackType,
  parseAttackType,
  parseUserFacingAttackType,
} from "../../../src/domain/attack-type.js";

describe("AttackType", () => {
  it("keeps only the canonical attack-type values", () => {
    expect(AttackType.BATTLE).toBe(EMOJIS.physics);
    expect(AttackType.CARRYOVER).toBe(EMOJIS.carryover);
  });

  it("parses only canonical storage values and current slash inputs", () => {
    expect(parseAttackType(EMOJIS.physics)).toBe(AttackType.BATTLE);
    expect(parseAttackType(EMOJIS.carryover)).toBe(AttackType.CARRYOVER);
    expect(parseAttackType(ATTACK_TYPE_INPUTS.BATTLE)).toBe(AttackType.BATTLE);
    expect(parseAttackType(ATTACK_TYPE_INPUTS.CARRYOVER)).toBe(AttackType.CARRYOVER);
    expect(normalizeAttackType(EMOJIS.physics)).toBe(AttackType.BATTLE);
    expect(normalizeAttackType(EMOJIS.carryover)).toBe(AttackType.CARRYOVER);
    expect(parseAttackType(EMOJIS.magic)).toBeUndefined();
    expect(normalizeAttackType(EMOJIS.magic)).toBeUndefined();
    expect(parseAttackType("PHYSICS")).toBeUndefined();
    expect(normalizeAttackType("MAGIC")).toBeUndefined();
    expect(parseAttackType("unknown")).toBeUndefined();
    expect(normalizeAttackType("unknown")).toBeUndefined();
  });

  it("accepts only current slash/button inputs at the user-facing boundary", () => {
    expect(parseUserFacingAttackType(ATTACK_TYPE_INPUTS.BATTLE)).toBe(AttackType.BATTLE);
    expect(parseUserFacingAttackType(ATTACK_TYPE_INPUTS.CARRYOVER)).toBe(AttackType.CARRYOVER);
    expect(parseUserFacingAttackType("PHYSICS")).toBeUndefined();
    expect(parseUserFacingAttackType("MAGIC")).toBeUndefined();
    expect(parseUserFacingAttackType(EMOJIS.physics)).toBeUndefined();
    expect(parseUserFacingAttackType(EMOJIS.magic)).toBeUndefined();
  });

  it("formats labels only for canonical attack types", () => {
    expect(formatAttackTypeLabel(AttackType.BATTLE)).toBe("⚔️ 本戦凸");
    expect(formatAttackTypeLabel(AttackType.CARRYOVER)).toBe("☕ 持越凸");
    expect(formatAttackTypeLabel("MAGIC")).toBeUndefined();
  });
});
