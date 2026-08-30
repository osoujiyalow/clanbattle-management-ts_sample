import type { Guild } from "discord.js";
import { describe, expect, it } from "vitest";

import { ClanData } from "../../../src/domain/clan-data.js";
import { PlayerData } from "../../../src/domain/player-data.js";
import {
  cleanupDepartedMembersOnDateRollover,
  resolveManagedMemberPresence,
  type ManagedMemberPresence,
} from "../../../src/discord/day-rollover-departed-member-cleanup.js";

function createClanData(): ClanData {
  const clanData = new ClanData({
    guildId: "100",
    categoryId: "200",
    bossChannelIds: ["11", "12", "13", "14", "15"],
    remainAttackChannelId: "16",
    commandChannelId: "17",
    summaryChannelId: "18",
    date: "2026-03-08",
  });
  clanData.addPlayerData(new PlayerData({ userId: "300" }));
  return clanData;
}

async function runCleanup(
  presence: ManagedMemberPresence,
): Promise<{ removedUserIds: string[]; removedCount: number }> {
  const clanData = createClanData();
  const removedUserIds: string[] = [];
  const removedCount = await cleanupDepartedMembersOnDateRollover({
    runtimeStateService: {
      get: () => clanData,
      async ensureDateUpToDate() {
        return {
          changed: true,
          previousDayKey: "2026-03-08",
          currentDayKey: "2026-03-09",
          shouldCreateRemainAttackMessage: true,
        };
      },
    },
    memberService: {
      async remove(request) {
        removedUserIds.push(request.member?.id ?? "");
        return 1;
      },
    },
    guild: {} as Guild,
    categoryId: clanData.categoryId,
    discordGateway: {} as never,
    resolveMemberPresence: async () => presence,
  });

  return { removedUserIds, removedCount };
}

describe("cleanupDepartedMembersOnDateRollover", () => {
  it("classifies only Discord Unknown Member 10007 as departed", async () => {
    const unknownMemberGuild = {
      members: {
        async fetch() {
          throw { code: 10007 };
        },
      },
    } as Guild;
    const transientFailureGuild = {
      members: {
        async fetch() {
          throw new Error("temporary Discord API failure");
        },
      },
    } as Guild;

    await expect(resolveManagedMemberPresence(unknownMemberGuild, "300")).resolves.toEqual({
      status: "departed",
    });
    await expect(resolveManagedMemberPresence(transientFailureGuild, "300")).resolves.toEqual({
      status: "unknown",
    });
  });

  it("removes a managed member only when Discord confirms departure", async () => {
    await expect(runCleanup({ status: "departed" })).resolves.toEqual({
      removedUserIds: ["300"],
      removedCount: 1,
    });
  });

  it("keeps a managed member when Discord confirms presence", async () => {
    await expect(
      runCleanup({ status: "present", displayName: "Alice" }),
    ).resolves.toEqual({
      removedUserIds: [],
      removedCount: 0,
    });
  });

  it("keeps a managed member when Discord presence is unknown", async () => {
    await expect(runCleanup({ status: "unknown" })).resolves.toEqual({
      removedUserIds: [],
      removedCount: 0,
    });
  });
});
