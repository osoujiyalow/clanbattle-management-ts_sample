import { EmbedBuilder } from "discord.js";

import { BOSS_COLORS, TREASURE_CHEST_URL } from "../constants/colors.js";
import { ClanBattleData } from "../domain/clan-battle-data.js";
import type { ClanData } from "../domain/clan-data.js";

export interface ProgressRendererInput {
  clanData: ClanData;
  lap: number;
  bossIndex: number;
  displayNamesByUserId: ReadonlyMap<string, string>;
}

function formatDamage(value: number): string {
  return value.toLocaleString("en-US");
}

export function renderProgressEmbed(input: ProgressRendererInput): EmbedBuilder {
  const bossStatusData = input.clanData.bossStatusByLap.get(input.lap)?.[input.bossIndex];

  if (!bossStatusData) {
    throw new Error(`boss status not found for lap=${input.lap}, bossIndex=${input.bossIndex}`);
  }

  const attackedList: string[] = [];
  const attackList: string[] = [];
  const sortedAttackPlayers = [...bossStatusData.attackPlayers].sort(
    (left, right) => right.damage - left.damage,
  );

  let totalDamage = 0;
  let currentHp = bossStatusData.maxHp;

  for (const attackStatus of sortedAttackPlayers) {
    if (!attackStatus.attacked) {
      continue;
    }

    const displayName = input.displayNamesByUserId.get(attackStatus.playerData.userId);
    if (!displayName) {
      continue;
    }

    attackedList.push(
      `(${attackStatus.attackType}済み) ${formatDamage(attackStatus.damage)}万 ${displayName}`,
    );
    currentHp -= attackStatus.damage;
  }

  for (const attackStatus of sortedAttackPlayers) {
    if (attackStatus.attacked) {
      continue;
    }

    const displayName = input.displayNamesByUserId.get(attackStatus.playerData.userId);
    if (!displayName) {
      continue;
    }

    attackList.push(attackStatus.createAttackStatusTxt(displayName, currentHp));
    totalDamage += attackStatus.damage;
  }

  let title = `[${input.lap}周目] ${ClanBattleData.bossNames[input.bossIndex]}`;
  if (bossStatusData.beated) {
    title += " **討伐済み**";
  } else {
    title += ` ${formatDamage(currentHp)}万/${formatDamage(bossStatusData.maxHp)}万 合計 ${formatDamage(totalDamage)}万`;
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(attackedList.join("\n") + "\n" + attackList.join("\n"))
    .setColor(BOSS_COLORS[input.bossIndex] ?? BOSS_COLORS[0]!);

  if (bossStatusData.beated) {
    embed.setThumbnail(TREASURE_CHEST_URL);
  }

  return embed;
}
