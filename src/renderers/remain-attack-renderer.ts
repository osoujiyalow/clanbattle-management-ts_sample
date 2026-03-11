import { EmbedBuilder } from "discord.js";

import type { Clock } from "../shared/time.js";
import { now, systemClock } from "../shared/time.js";
import type { ClanData } from "../domain/clan-data.js";

export interface RemainAttackRendererInput {
  clanData: ClanData;
  displayNamesByUserId: ReadonlyMap<string, string>;
  clock?: Clock;
}

function formatClanBattleDisplayDate(date: Date): string {
  const shifted = new Date(date.getTime() + 4 * 60 * 60 * 1000);
  return `${String(shifted.getUTCMonth() + 1).padStart(2, "0")}月${String(shifted.getUTCDate()).padStart(2, "0")}日`;
}

export function renderRemainAttackEmbed(input: RemainAttackRendererInput): EmbedBuilder {
  const clock = input.clock ?? systemClock;
  const remainAttackMessageList = [[], [], [], []] as string[][];
  const remainAttackCarryOverList = [[], [], [], []] as string[][];
  const today = formatClanBattleDisplayDate(now(clock));

  const embed = new EmbedBuilder().setTitle(`${today} の残凸状況`).setColor(0xe67e22);

  let sumRemainAttack = 0;

  for (const playerData of input.clanData.playerDataMap.values()) {
    const displayName = input.displayNamesByUserId.get(playerData.userId) ?? playerData.userId;
    const text = "- " + playerData.createTxt(displayName, clock);
    const sumAttack = playerData.magicAttack + playerData.physicsAttack;
    sumRemainAttack += 3 - sumAttack;

    if (playerData.carryOverList.length > 0) {
      remainAttackCarryOverList[sumAttack]?.push(text);
    } else {
      remainAttackMessageList[sumAttack]?.push(text);
    }
  }

  for (let attackCount = 0; attackCount < 4; attackCount += 1) {
    const content = remainAttackMessageList[attackCount]!.join("\n");
    if (content) {
      embed.addFields({
        name: `残${3 - attackCount}凸`,
        value: `\`\`\`md\n${content.replaceAll("_", "＿")}\n\`\`\``,
        inline: false,
      });
    }

    const contentWithCarryOver = remainAttackCarryOverList[attackCount]!.join("\n");
    if (!contentWithCarryOver) {
      continue;
    }

    if (contentWithCarryOver.length < 1014) {
      embed.addFields({
        name: `残${3 - attackCount}凸（持ち越し）`,
        value: `\`\`\`md\n${contentWithCarryOver.replaceAll("_", "＿")}\n\`\`\``,
        inline: false,
      });
      continue;
    }

    const center =
      Math.floor(remainAttackCarryOverList[attackCount]!.length / 2) +
      (remainAttackCarryOverList[attackCount]!.length % 2);
    const contentCarryOverList = [
      remainAttackCarryOverList[attackCount]!.slice(0, center).join("\n"),
      remainAttackCarryOverList[attackCount]!.slice(center).join("\n"),
    ];
    const suffixes = ["A", "B"] as const;

    for (let suffixIndex = 0; suffixIndex < 2; suffixIndex += 1) {
      embed.addFields({
        name: `残${3 - attackCount}凸（持ち越し${suffixes[suffixIndex]}）`,
        value: `\`\`\`md\n${contentCarryOverList[suffixIndex]}\n\`\`\``,
        inline: false,
      });
    }
  }

  embed.setFooter({
    text: `${input.clanData.getLatestLap()}周目 ${sumRemainAttack}/${input.clanData.playerDataMap.size * 3}`,
  });

  return embed;
}
