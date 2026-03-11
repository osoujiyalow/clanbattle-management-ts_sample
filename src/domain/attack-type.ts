import { EMOJIS } from "../constants/emojis.js";

export const AttackType = {
  MAGIC: EMOJIS.magic,
  PHYSICS: EMOJIS.physics,
  CARRYOVER: EMOJIS.carryover,
} as const;

export type AttackType = (typeof AttackType)[keyof typeof AttackType];

export const ATTACK_TYPE_BY_INPUT: Readonly<Record<string, AttackType>> = {
  [EMOJIS.physics]: AttackType.PHYSICS,
  [EMOJIS.magic]: AttackType.MAGIC,
  [EMOJIS.carryover]: AttackType.CARRYOVER,
};

export function parseAttackType(value: string): AttackType | undefined {
  return ATTACK_TYPE_BY_INPUT[value];
}
