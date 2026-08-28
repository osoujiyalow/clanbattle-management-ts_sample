import { describe, expect, it } from "vitest";

import { AttackStatus } from "../../../src/domain/attack-status.js";
import { AttackType } from "../../../src/domain/attack-type.js";
import { ClanData } from "../../../src/domain/clan-data.js";
import { PlayerData } from "../../../src/domain/player-data.js";
import { renderProgressEmbed } from "../../../src/renderers/progress-renderer.js";

describe("renderProgressEmbed", () => {
  it("renders the progress embed with attacked and unattacked rows", () => {
    const clanData = new ClanData({
      guildId: "100",
      categoryId: "200",
      bossChannelIds: ["11", "12", "13", "14", "15"],
      remainAttackChannelId: "16",
      commandChannelId: "18",
      summaryChannelId: "19",
      progressMessageIdsByLap: new Map([[7, ["a", "b", "c", "d", "e"]]]),
    });
    clanData.initializeBossStatusData(7);

    const alice = new PlayerData({ userId: "300", physicsAttack: 1 });
    const bob = new PlayerData({ userId: "301", magicAttack: 1 });
    clanData.bossStatusByLap.get(7)?.[0]?.attackPlayers.push(
      new AttackStatus({
        playerData: alice,
        attackType: AttackType.BATTLE,
        carryOver: false,
        damage: 1500,
        attacked: true,
      }),
      new AttackStatus({
        playerData: bob,
        attackType: AttackType.CARRYOVER,
        carryOver: true,
        damage: 1200,
        memo: "予約中",
      }),
    );

    const embed = renderProgressEmbed({
      clanData,
      lap: 7,
      bossIndex: 0,
      displayNamesByUserId: new Map([
        ["300", "Alice"],
        ["301", "Bob"],
      ]),
    });

    expect(embed.toJSON()).toMatchInlineSnapshot(`
      {
        "color": 15158332,
        "description": "(⚔️済み) 1,500万 Alice
      ☕ 1,200万 予約中
      　　- Bob (1/3)",
        "title": "[7周目] 1ボス 3,500万/5,000万 合計 1,200万",
      }
    `);
  });

  it("renders treasure chest thumbnail for beated boss", () => {
    const clanData = new ClanData({
      guildId: "100",
      categoryId: "200",
      bossChannelIds: ["11", "12", "13", "14", "15"],
      remainAttackChannelId: "16",
      commandChannelId: "18",
      summaryChannelId: "19",
      progressMessageIdsByLap: new Map([[1, ["a", null, null, null, null]]]),
    });
    clanData.initializeBossStatusData(1);
    clanData.bossStatusByLap.get(1)![0]!.beated = true;

    const embed = renderProgressEmbed({
      clanData,
      lap: 1,
      bossIndex: 0,
      displayNamesByUserId: new Map(),
    });

    expect(embed.toJSON()).toMatchObject({
      title: "[1周目] 1ボス **討伐済み**",
      thumbnail: {
        url: "https://cdn.discordapp.com/attachments/845661889161068559/876325765434712144/unknown.png",
      },
    });
  });

  it("renders HP decreases and increases as compact correction rows", () => {
    const clanData = new ClanData({
      guildId: "100",
      categoryId: "200",
      bossChannelIds: ["11", "12", "13", "14", "15"],
      remainAttackChannelId: "16",
      commandChannelId: "18",
      summaryChannelId: "19",
      progressMessageIdsByLap: new Map([[1, ["a", null, null, null, null]]]),
    });
    clanData.initializeBossStatusData(1);
    const admin = new PlayerData({ userId: "400" });
    clanData.bossStatusByLap.get(1)?.[0]?.attackPlayers.push(
      new AttackStatus({
        playerData: new PlayerData({ userId: "300" }),
        attackType: AttackType.BATTLE,
        carryOver: false,
        damage: 1000,
        attacked: true,
      }),
      new AttackStatus({
        playerData: admin,
        attackType: AttackType.HP_ADJUSTMENT,
        carryOver: false,
        damage: 266,
        attacked: true,
      }),
      new AttackStatus({
        playerData: admin,
        attackType: AttackType.HP_ADJUSTMENT,
        carryOver: false,
        damage: -500,
        attacked: true,
      }),
    );

    const embed = renderProgressEmbed({
      clanData,
      lap: 1,
      bossIndex: 0,
      displayNamesByUserId: new Map([
        ["300", "Bob"],
        ["400", "Alice"],
      ]),
    }).toJSON();

    expect(embed.title).toBe("[1周目] 1ボス 434万/1,200万 合計 0万");
    expect(embed.description).toBe(
      "(⚔️済み) 1,000万 Bob\n(修正済) -266万 Alice\n(修正済) +500万 Alice\n",
    );
  });
  it("falls back to user id when a display name is unavailable", () => {
    const clanData = new ClanData({
      guildId: "100",
      categoryId: "200",
      bossChannelIds: ["11", "12", "13", "14", "15"],
      remainAttackChannelId: "16",
      commandChannelId: "18",
      summaryChannelId: "19",
      progressMessageIdsByLap: new Map([[1, ["a", null, null, null, null]]]),
    });
    clanData.initializeBossStatusData(1);
    clanData.bossStatusByLap.get(1)?.[0]?.attackPlayers.push(
      new AttackStatus({
        playerData: new PlayerData({ userId: "300" }),
        attackType: AttackType.BATTLE,
        carryOver: false,
        damage: 1500,
        attacked: true,
      }),
    );

    const embed = renderProgressEmbed({
      clanData,
      lap: 1,
      bossIndex: 0,
      displayNamesByUserId: new Map(),
    });

    expect(JSON.stringify(embed.toJSON())).toContain("300");
  });
});
