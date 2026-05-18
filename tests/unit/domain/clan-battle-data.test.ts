import { afterEach, describe, expect, it } from "vitest";

import { ClanBattleData } from "../../../src/domain/clan-battle-data.js";
import { GuildBossInfoConfig } from "../../../src/domain/guild-bossinfo-config.js";

describe("ClanBattleData", () => {
  afterEach(() => {
    ClanBattleData.deleteGuildConfig("guild-1");
  });

  it("returns a defensive copy of the default config", () => {
    const config = ClanBattleData.getDefaultConfig();
    config.hp[0]![0] = 9999;

    expect(ClanBattleData.getDefaultConfig().hp[0]![0]).toBe(1200);
  });

  it("uses guild-specific config when present", () => {
    ClanBattleData.setGuildConfig(
      "guild-1",
      new GuildBossInfoConfig({
        hp: [
          [1, 2, 3, 4, 5],
          [6, 7, 8, 9, 10],
        ],
        boundaries: [
          [1, 3],
          [4, -1],
        ],
      }),
    );

    expect(ClanBattleData.getHp(2, 3, "guild-1")).toBe(4);
    expect(ClanBattleData.getHp(9, 1, "guild-1")).toBe(7);
  });

  it("validates and round-trips json config", () => {
    const config = ClanBattleData.validateConfig(
      [
        [100, 200, 300, 400, 500],
        [600, 700, 800, 900, 1000],
      ],
      [
        [1, 2],
        [3, -1],
      ],
    );

    const restored = ClanBattleData.configFromJsonText(ClanBattleData.configToJson(config));
    expect(restored.hp).toEqual(config.hp);
    expect(restored.boundaries).toEqual(config.boundaries);
  });

  it("rejects discontinuous phase boundaries", () => {
    expect(() =>
      ClanBattleData.validateConfig(
        [
          [100, 200, 300, 400, 500],
          [600, 700, 800, 900, 1000],
        ],
        [
          [1, 2],
          [4, -1],
        ],
      ),
    ).toThrow("開始周は前段階の終了周+1 (3) にしてください。");
  });
});
