export type PhaseBoundary = [number, number];

export interface GuildBossInfoConfigParams {
  hp: readonly (readonly number[])[];
  boundaries: readonly (readonly [number, number])[];
}

function cloneHp(hp: readonly (readonly number[])[]): number[][] {
  return hp.map((row) => [...row]);
}

function cloneBoundaries(
  boundaries: readonly (readonly [number, number])[],
): PhaseBoundary[] {
  return boundaries.map(([lapFrom, lapTo]) => [lapFrom, lapTo]);
}

export class GuildBossInfoConfig {
  readonly hp: number[][];
  readonly boundaries: PhaseBoundary[];

  constructor(params: GuildBossInfoConfigParams) {
    this.hp = cloneHp(params.hp);
    this.boundaries = cloneBoundaries(params.boundaries);
  }

  copy(): GuildBossInfoConfig {
    return new GuildBossInfoConfig({
      hp: this.hp,
      boundaries: this.boundaries,
    });
  }
}
