import { Collection } from "discord.js";
import { describe, expect, it } from "vitest";

import { resyncStartupMessageSurfaces } from "../../../src/discord/startup-message-surface-resync.js";
import { ClanData } from "../../../src/domain/clan-data.js";
import { PlayerData } from "../../../src/domain/player-data.js";
import type { Logger } from "../../../src/shared/logger.js";

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

describe("resyncStartupMessageSurfaces", () => {
  it("resyncs only active categories and passes resolved display names", async () => {
    const activeClanData = new ClanData({
      guildId: "guild-1",
      categoryId: "category-1",
      bossChannelIds: ["boss-1", "boss-2", "boss-3", "boss-4", "boss-5"],
      remainAttackChannelId: "remain-1",
      commandChannelId: "command-1",
      summaryChannelId: "summary-1",
      date: "2026-04-22",
    });
    activeClanData.addPlayerData(new PlayerData({ userId: "member-1" }));

    const requests: Array<{
      categoryId: string;
      displayName: string | undefined;
    }> = [];

    await resyncStartupMessageSurfaces({
      client: {
        user: {
          id: "bot-user",
          username: "TestBot",
        },
        guilds: {
          fetch: async () =>
            ({
              channels: {
                fetch: async () => null,
              },
              members: {
                cache: new Collection([
                  [
                    "member-1",
                    {
                      id: "member-1",
                      nickname: "Alice",
                      user: {
                        id: "member-1",
                        globalName: "Alice Global",
                      },
                    },
                  ],
                ]),
                fetch: async () => new Collection(),
              },
            }) as never,
        },
      } as never,
      logger: NOOP_LOGGER,
      runtimeStateService: {
        get(categoryId) {
          return categoryId === activeClanData.categoryId ? activeClanData : undefined;
        },
      },
      memberService: {
        async resyncCurrentMessageSurfaces(request) {
          requests.push({
            categoryId: request.categoryId,
            displayName: request.displayNamesByUserId?.get("member-1"),
          });
          return true;
        },
      },
      scanReport: {
        scannedAt: "2026-04-22T00:00:00.000Z",
        scannedCount: 2,
        activeCount: 1,
        orphanedCount: 1,
        scanDeferredCount: 0,
        records: [
          {
            guildId: "guild-1",
            categoryId: "category-1",
            status: "active",
            reason: "category-resolved",
            day: "2026-04-22",
            commandChannelId: "command-1",
            remainAttackChannelId: "remain-1",
            bossChannelIds: activeClanData.bossChannelIds,
          },
          {
            guildId: "guild-2",
            categoryId: "category-2",
            status: "orphaned",
            reason: "category-not-found",
            day: "2026-04-22",
            commandChannelId: "command-2",
            remainAttackChannelId: "remain-2",
            bossChannelIds: ["boss-a", "boss-b", "boss-c", "boss-d", "boss-e"],
          },
        ],
      },
    });

    expect(requests).toEqual([
      {
        categoryId: "category-1",
        displayName: "Alice",
      },
    ]);
  });
});
