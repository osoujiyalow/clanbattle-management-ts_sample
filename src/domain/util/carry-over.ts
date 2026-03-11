export function calcCarryOverTime(remainHp: number, damage: number): number {
  if (damage <= 0) {
    throw new Error("damage must be positive");
  }

  if (remainHp < 0) {
    throw new Error("remain_hp must be >= 0");
  }

  const carryOverTime = Math.ceil((1 - remainHp / damage) * 90 + 20);
  return Math.max(20, Math.min(90, carryOverTime));
}
