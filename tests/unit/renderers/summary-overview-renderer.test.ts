import { describe, expect, it } from "vitest";

import { AttackStatus } from "../../../src/domain/attack-status.js";
import { AttackType } from "../../../src/domain/attack-type.js";
import { ClanData } from "../../../src/domain/clan-data.js";
import { CarryOver, PlayerData } from "../../../src/domain/player-data.js";
import { renderSummaryOverviewEmbed } from "../../../src/renderers/summary-overview-renderer.js";

describe("renderSummaryOverviewEmbed", () => {
  it("renders the current day remain summary and boss hp overview", () => {
    const alice = new PlayerData({ userId: "300", physicsAttack: 1 });
    const bob = new PlayerData({
      userId: "301",
      physicsAttack: 2,
      carryOverList: [
        new CarryOver({
          attackType: AttackType.CARRYOVER,
          bossIndex: 0,
          created: new Date("2026-03-07T12:00:00+09:00"),
        }),
      ],
    });

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
      ]),
      progressMessageIdsByLap: new Map([
        [1, ["p11", "p12", "p13", "p14", "p15"]],
        [2, ["p21", null, null, null, null]],
      ]),
      date: "2026-03-08",
    });
    clanData.initializeBossStatusData(1);
    clanData.initializeBossStatusData(2);
    clanData.bossStatusByLap.get(1)?.[1]?.attackPlayers.push(
      new AttackStatus({
        playerData: alice,
        attackType: AttackType.BATTLE,
        carryOver: false,
        attacked: true,
        damage: 500,
      }),
    );
    clanData.bossStatusByLap.get(1)![4]!.beated = true;
    clanData.bossStatusByLap.get(2)?.[0]?.attackPlayers.push(
      new AttackStatus({
        playerData: bob,
        attackType: AttackType.CARRYOVER,
        carryOver: true,
        attacked: true,
        damage: 700,
      }),
    );

    const embed = renderSummaryOverviewEmbed(clanData).toJSON();

    expect(embed).toMatchObject({
      color: 3066993,
      title: "3月8日の進行状況",
    });
    expect(embed.description).toContain("残 3凸 1持");
    expect(embed.description).toContain("1ボス（2周）");
    expect(embed.description).toContain("500万/1200万");
    expect(embed.description).toContain("2ボス（1周）");
    expect(embed.description).toContain("1000万/1500万");
    expect(embed.description).toContain("5ボス（1周）");
    expect(embed.description).toContain("0万/3000万");
  });
});
