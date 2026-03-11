export interface BossInfoConfig {
  hp: readonly (readonly number[])[];
  boundaries: readonly (readonly [number, number])[];
}

export const MAX_PHASE_COUNT = 20;

export const DEFAULT_BOSS_NAMES = ["1ボス", "2ボス", "3ボス", "4ボス", "5ボス"] as const;

export const DEFAULT_BOSSINFO_CONFIG: BossInfoConfig = {
  hp: [
    [1200, 1500, 2000, 2300, 3000],
    [5000, 5600, 6400, 7000, 8500],
    [100000, 104000, 108000, 112000, 116000],
  ],
  boundaries: [
    [1, 6],
    [7, 22],
    [23, -1],
  ],
};
