import { describe, expect, it } from "vitest";

import { ClanData } from "../../../src/domain/clan-data.js";

describe("ClanData", () => {
  it("initializes boss status data for five bosses", () => {
    const clanData = new ClanData({
      guildId: "guild-1",
      categoryId: "category-1",
      bossChannelIds: ["boss-1", "boss-2", "boss-3", "boss-4", "boss-5"],
      remainAttackChannelId: "remain",
      commandChannelId: "command",
      summaryChannelId: "summary",
    });

    clanData.initializeBossStatusData(7);

    expect(clanData.bossStatusByLap.get(7)).toHaveLength(5);
    expect(clanData.bossStatusByLap.get(7)?.[0]?.maxHp).toBe(5000);
  });

  it("resolves boss channel and progress message ids through helper methods", () => {
    const clanData = new ClanData({
      guildId: "guild-1",
      categoryId: "category-1",
      bossChannelIds: ["boss-1", "boss-2", "boss-3", "boss-4", "boss-5"],
      remainAttackChannelId: "remain",
      commandChannelId: "command",
      summaryChannelId: "summary",
      progressMessageIdsByLap: new Map([
        [1, ["lap1-1", "lap1-2", null, null, null]],
        [2, ["lap2-1", null, null, null, null]],
      ]),
      summaryMessageIdsByLap: new Map(),
      date: "2026-03-07",
    });

    expect(clanData.getBossIndexFromChannelId("boss-4")).toBe(3);
    expect(clanData.getLapFromMessageId("lap1-2", 1)).toBe(1);
    expect(clanData.getLatestLap()).toBe(2);
    expect(clanData.getLatestLap(1)).toBe(1);
  });

  it("clears progress-related state together", () => {
    const clanData = new ClanData({
      guildId: "guild-1",
      categoryId: "category-1",
      bossChannelIds: ["boss-1", "boss-2", "boss-3", "boss-4", "boss-5"],
      remainAttackChannelId: "remain",
      commandChannelId: "command",
      summaryChannelId: "summary",
      progressMessageIdsByLap: new Map([[1, ["lap1-1", null, null, null, null]]]),
      summaryMessageIdsByLap: new Map([[1, ["summary1-1", null, null, null, null]]]),
    });

    clanData.initializeProgressData();

    expect(clanData.progressMessageIdsByLap.size).toBe(0);
    expect(clanData.summaryMessageIdsByLap.size).toBe(0);
    expect(clanData.bossStatusByLap.size).toBe(0);
  });
});
