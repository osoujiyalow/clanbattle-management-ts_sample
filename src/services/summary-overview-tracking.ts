import type { BossMessageIds } from "../repositories/sqlite/boss-message-id-repository.js";
import type { ClanData } from "../domain/clan-data.js";

export interface SummaryOverviewTrackedMessage {
  lap: number;
  bossIndex: number;
  messageId: string;
}

export function createSummaryOverviewMessageIds(messageId: string): BossMessageIds {
  return [messageId, null, null, null, null];
}

export function collectTrackedSummaryMessages(
  clanData: ClanData,
): SummaryOverviewTrackedMessage[] {
  const tracked: SummaryOverviewTrackedMessage[] = [];

  for (const [lap, messageIds] of clanData.summaryMessageIdsByLap.entries()) {
    for (let bossIndex = 0; bossIndex < messageIds.length; bossIndex += 1) {
      const messageId = messageIds[bossIndex];
      if (!messageId) {
        continue;
      }

      tracked.push({
        lap,
        bossIndex,
        messageId,
      });
    }
  }

  return tracked;
}

export function findCurrentSummaryOverviewMessage(
  clanData: ClanData,
): SummaryOverviewTrackedMessage | null {
  const tracked = collectTrackedSummaryMessages(clanData);
  return tracked[0] ?? null;
}

export function hasLegacySummaryMirrorTracking(clanData: ClanData): boolean {
  const tracked = collectTrackedSummaryMessages(clanData);
  if (tracked.length === 0) {
    return false;
  }

  return tracked.length !== 1 || tracked[0]!.bossIndex !== 0;
}

export function resolveSummaryOverviewStorageLap(clanData: ClanData): number {
  const progressLaps = [...clanData.progressMessageIdsByLap.keys()];
  if (progressLaps.length > 0) {
    return Math.max(...progressLaps);
  }

  const bossStatusLaps = [...clanData.bossStatusByLap.keys()];
  if (bossStatusLaps.length > 0) {
    return Math.max(...bossStatusLaps);
  }

  return 1;
}
