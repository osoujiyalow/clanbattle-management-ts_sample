import { describe, expect, it } from "vitest";

import { AttackType } from "../../../src/domain/attack-type.js";
import { ClanData } from "../../../src/domain/clan-data.js";
import { CarryOver, PlayerData } from "../../../src/domain/player-data.js";
import { renderRemainAttackEmbed } from "../../../src/renderers/remain-attack-renderer.js";
import { createFixedClock } from "../../../src/shared/time.js";

describe("renderRemainAttackEmbed", () => {
  it("renders remain-attack buckets with user names only", () => {
    const alice = new PlayerData({ userId: "300" });
    const bob = new PlayerData({
      userId: "301",
      physicsAttack: 1,
      rawLimitTimeText: "19時〜20時",
      carryOverList: [
        new CarryOver({
          attackType: AttackType.BATTLE,
          bossIndex: 2,
          created: new Date("2026-03-07T12:34:00+09:00"),
        }),
      ],
    });
    const charlie = new PlayerData({
      userId: "302",
      physicsAttack: 2,
      carryOverList: [
        new CarryOver({
          attackType: AttackType.BATTLE,
          bossIndex: 0,
        }),
      ],
      taskKill: true,
    });
    const dave = new PlayerData({
      userId: "303",
      physicsAttack: 3,
      carryOverList: [
        new CarryOver({
          attackType: AttackType.BATTLE,
          bossIndex: 1,
        }),
        new CarryOver({
          attackType: AttackType.BATTLE,
          bossIndex: 2,
        }),
      ],
    });
    const eve = new PlayerData({ userId: "304", physicsAttack: 3 });

    const clanData = new ClanData({
      guildId: "100",
      categoryId: "200",
      bossChannelIds: ["11", "12", "13", "14", "15"],
      remainAttackChannelId: "16",
      commandChannelId: "18",
      summaryChannelId: "19",
      playerDataMap: new Map([
        [alice.userId, alice],
        [bob.userId, bob],
        [charlie.userId, charlie],
        [dave.userId, dave],
        [eve.userId, eve],
      ]),
      progressMessageIdsByLap: new Map([[7, ["a", "b", "c", "d", "e"]]]),
    });

    const embed = renderRemainAttackEmbed({
      clanData,
      displayNamesByUserId: new Map([
        ["300", "Alice_1"],
        ["301", "Bob_2"],
        ["302", "Charlie"],
        ["303", "Dave"],
        ["304", "Eve"],
      ]),
      clock: createFixedClock("2026-03-07T18:00:00+09:00"),
    });

    expect(embed.toJSON()).toEqual({
      title: "03月07日 の残凸状況",
      color: 15105570,
      description: "残 6凸 4持",
      fields: [
        {
          name: "残3凸 1人",
          value: "```md\n- Alice＿1\n```",
          inline: false,
        },
        {
          name: "残2凸（持越1凸） 1人",
          value: "```md\n- Bob＿2\n```",
          inline: false,
        },
        {
          name: "残1凸（持越1凸） 1人",
          value: "```md\n- Charlie 💀\n```",
          inline: false,
        },
        {
          name: "残0凸（持越2凸） 1人",
          value: "```md\n- Dave\n```",
          inline: false,
        },
        {
          name: "残0凸 1人",
          value: "```md\n- Eve\n```",
          inline: false,
        },
      ],
    });
  });

  it("falls back to user id when a display name is missing", () => {
    const player = new PlayerData({ userId: "399" });
    const clanData = new ClanData({
      guildId: "100",
      categoryId: "200",
      bossChannelIds: ["11", "12", "13", "14", "15"],
      remainAttackChannelId: "16",
      commandChannelId: "18",
      summaryChannelId: "19",
      playerDataMap: new Map([[player.userId, player]]),
      progressMessageIdsByLap: new Map([[1, ["a", "b", "c", "d", "e"]]]),
    });

    const embed = renderRemainAttackEmbed({
      clanData,
      displayNamesByUserId: new Map(),
      clock: createFixedClock("2026-03-07T18:00:00+09:00"),
    });

    expect(embed.toJSON()).toMatchObject({
      description: "残 3凸 0持",
      fields: [
        {
          name: "残3凸 1人",
          value: expect.stringContaining("- 399"),
        },
      ],
    });
  });
});
