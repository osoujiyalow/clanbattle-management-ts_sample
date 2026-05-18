import {
  AttackType,
  normalizeAttackType,
  type AttackType as AttackTypeValue,
} from "../../domain/attack-type.js";
export const BATTLE_STORAGE_ATTACK_TYPE = AttackType.BATTLE;
export const CARRYOVER_STORAGE_ATTACK_TYPE = AttackType.CARRYOVER;

export function encodeAttackTypeForStorage(attackType: string): string {
  const canonicalAttackType = normalizeAttackType(attackType);

  if (canonicalAttackType === AttackType.CARRYOVER) {
    return CARRYOVER_STORAGE_ATTACK_TYPE;
  }

  if (canonicalAttackType === AttackType.BATTLE) {
    return BATTLE_STORAGE_ATTACK_TYPE;
  }

  throw new Error(`unknown attack type: ${attackType}`);
}

export function decodeAttackTypeFromStorage(attackType: string): AttackTypeValue | undefined {
  if (attackType === BATTLE_STORAGE_ATTACK_TYPE) {
    return AttackType.BATTLE;
  }

  if (attackType === CARRYOVER_STORAGE_ATTACK_TYPE) {
    return AttackType.CARRYOVER;
  }

  return undefined;
}
