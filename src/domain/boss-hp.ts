import type { BossStatusData } from "./boss-status-data.js";

export function resolveCurrentBossHp(bossStatusData: BossStatusData): number {
  if (bossStatusData.beated) {
    return 0;
  }

  const attackedDamage = bossStatusData.attackPlayers.reduce((sum, attackStatus) => {
    return attackStatus.attacked ? sum + attackStatus.damage : sum;
  }, 0);

  return Math.max(0, bossStatusData.maxHp - attackedDamage);
}
