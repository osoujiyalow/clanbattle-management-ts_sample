import { EMOJIS } from "../constants/emojis.js";

export const AttackType = {
  BATTLE: EMOJIS.physics,
  CARRYOVER: EMOJIS.carryover,
  HP_ADJUSTMENT: "修正",
} as const;

export type AttackType = (typeof AttackType)[keyof typeof AttackType];
export type CanonicalAttackType = typeof AttackType.BATTLE | typeof AttackType.CARRYOVER;

export const ATTACK_TYPE_INPUTS = {
  BATTLE: "BATTLE",
  CARRYOVER: "CARRYOVER",
} as const;

export const ATTACK_TYPE_LABELS: Readonly<Record<CanonicalAttackType, string>> = {
  [AttackType.BATTLE]: `${AttackType.BATTLE} 本戦凸`,
  [AttackType.CARRYOVER]: `${AttackType.CARRYOVER} 持越凸`,
};

export const ATTACK_TYPE_BY_INPUT: Readonly<Record<string, AttackType>> = {
  [EMOJIS.physics]: AttackType.BATTLE,
  [EMOJIS.carryover]: AttackType.CARRYOVER,
  [ATTACK_TYPE_INPUTS.BATTLE]: AttackType.BATTLE,
  [ATTACK_TYPE_INPUTS.CARRYOVER]: AttackType.CARRYOVER,
};

const USER_FACING_ATTACK_TYPE_BY_INPUT: Readonly<Record<string, CanonicalAttackType>> = {
  [ATTACK_TYPE_INPUTS.BATTLE]: AttackType.BATTLE,
  [ATTACK_TYPE_INPUTS.CARRYOVER]: AttackType.CARRYOVER,
};

export function parseAttackType(value: string): AttackType | undefined {
  return ATTACK_TYPE_BY_INPUT[value];
}

export function parseUserFacingAttackType(value: string): CanonicalAttackType | undefined {
  return USER_FACING_ATTACK_TYPE_BY_INPUT[value];
}

export function normalizeAttackType(value: string): CanonicalAttackType | undefined {
  const attackType = parseAttackType(value);
  return attackType === AttackType.BATTLE || attackType === AttackType.CARRYOVER
    ? attackType
    : undefined;
}

export function formatAttackTypeLabel(value: string): string | undefined {
  const attackType = normalizeAttackType(value);
  if (!attackType) {
    return undefined;
  }

  return ATTACK_TYPE_LABELS[attackType];
}

export function isBattleAttackType(value: string): boolean {
  return normalizeAttackType(value) === AttackType.BATTLE;
}
