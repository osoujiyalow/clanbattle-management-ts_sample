import { EmbedBuilder } from "discord.js";

import { resolveCurrentBossHp } from "../domain/boss-hp.js";
import { ClanBattleData } from "../domain/clan-battle-data.js";
import type { ClanData } from "../domain/clan-data.js";

const SUMMARY_OVERVIEW_COLOR = 0x2ecc71;

function formatSummaryOverviewDate(dayKey: string): string {
  const [, monthText, dayText] = dayKey.split("-");
  const month = Number.parseInt(monthText ?? "0", 10);
  const day = Number.parseInt(dayText ?? "0", 10);
  return `${month}月${day}日の進行状況`;
}

function resolveBossLatestLap(clanData: ClanData, bossIndex: number): number {
  const progressLaps = [...clanData.progressMessageIdsByLap.keys()].sort((left, right) => right - left);
  for (const lap of progressLaps) {
    if (clanData.progressMessageIdsByLap.get(lap)?.[bossIndex]) {
      return lap;
    }
  }

  const bossStatusLaps = [...clanData.bossStatusByLap.keys()].sort((left, right) => right - left);
  for (const lap of bossStatusLaps) {
    if (clanData.bossStatusByLap.get(lap)?.[bossIndex]) {
      return lap;
    }
  }

  return 1;
}

function buildBossSummaryBlock(clanData: ClanData, bossIndex: number): string {
  const lap = resolveBossLatestLap(clanData, bossIndex);
  const bossStatusData = clanData.bossStatusByLap.get(lap)?.[bossIndex];
  if (!bossStatusData) {
    throw new Error(`boss status not found for summary overview lap=${lap}, bossIndex=${bossIndex}`);
  }

  const currentHp = resolveCurrentBossHp(bossStatusData);
  const phaseProgress = ClanBattleData.getPhaseProgress(lap, clanData.guildId);
  const nextPhaseText =
    phaseProgress.lapsUntilNextPhase === null
      ? ""
      : `次段階まで${phaseProgress.lapsUntilNextPhase}周`;
  return `${bossIndex + 1}ボス（${lap}周）${nextPhaseText}\n${currentHp}万/${bossStatusData.maxHp}万`;
}

function buildRemainSummary(clanData: ClanData): string {
  let remainAttackCount = 0;
  let carryOverCount = 0;

  for (const playerData of clanData.playerDataMap.values()) {
    remainAttackCount += playerData.battleAttackLimit - playerData.battleAttackCount;
    carryOverCount += playerData.carryOverList.length;
  }

  return `残 ${remainAttackCount}凸 ${carryOverCount}持`;
}

export function renderSummaryOverviewEmbed(clanData: ClanData): EmbedBuilder {
  const blocks = Array.from({ length: clanData.bossChannelIds.length }, (_, bossIndex) =>
    buildBossSummaryBlock(clanData, bossIndex),
  );

  return new EmbedBuilder()
    .setTitle(formatSummaryOverviewDate(clanData.date))
    .setDescription([buildRemainSummary(clanData), ...blocks].join("\n\n"))
    .setColor(SUMMARY_OVERVIEW_COLOR);
}
