import type { Client as DiscordJsClient } from "discord.js";

import type { MemberService } from "../services/member-service.js";
import type {
  OrphanedCategoryScanReport,
  RuntimeStateService,
} from "../services/runtime-state-service.js";
import type { Logger } from "../shared/logger.js";
import { DiscordGuildTextGateway, resolveGuildDisplayNamesForUserIds } from "./command-handlers/shared.js";

export interface StartupMessageSurfaceResyncOptions {
  client: DiscordJsClient<true>;
  logger: Logger;
  runtimeStateService: Pick<RuntimeStateService, "get">;
  memberService: Pick<MemberService, "resyncCurrentMessageSurfaces">;
  scanReport: OrphanedCategoryScanReport;
}

export async function resyncStartupMessageSurfaces(
  options: StartupMessageSurfaceResyncOptions,
): Promise<void> {
  const activeRecords = options.scanReport.records
    .filter((record) => record.status === "active")
    .sort((left, right) => left.categoryId.localeCompare(right.categoryId));

  let successCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const record of activeRecords) {
    const clanData = options.runtimeStateService.get(record.categoryId);
    if (!clanData) {
      skippedCount += 1;
      continue;
    }

    try {
      const guild = await options.client.guilds.fetch(clanData.guildId);
      const displayNamesByUserId = await resolveGuildDisplayNamesForUserIds(
        guild,
        clanData.playerDataMap.keys(),
      );
      const resynced = await options.memberService.resyncCurrentMessageSurfaces({
        categoryId: clanData.categoryId,
        member: {
          id: options.client.user.id,
          displayName: options.client.user.username,
        },
        discordGateway: new DiscordGuildTextGateway(guild),
        displayNamesByUserId,
      });

      if (resynced) {
        successCount += 1;
      } else {
        skippedCount += 1;
      }
    } catch (error) {
      failedCount += 1;
      options.logger.warn("Failed to resync startup message surfaces", {
        categoryId: record.categoryId,
        guildId: record.guildId,
        error,
      });
    }
  }

  options.logger.info("Startup message-surface resync completed", {
    targetCount: activeRecords.length,
    successCount,
    skippedCount,
    failedCount,
  });
}
