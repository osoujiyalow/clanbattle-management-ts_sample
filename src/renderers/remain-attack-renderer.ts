import { EmbedBuilder } from "discord.js";

import { EMOJIS } from "../constants/emojis.js";
import type { ClanData } from "../domain/clan-data.js";
import type { Clock } from "../shared/time.js";
import { now, systemClock } from "../shared/time.js";

const MAX_FIELD_VALUE_LENGTH = 1014;

export interface RemainAttackRendererInput {
  clanData: ClanData;
  displayNamesByUserId: ReadonlyMap<string, string>;
  clock?: Clock;
}

interface RemainAttackBucket {
  remainingAttackCount: number;
  carryOverCount: number;
  players: string[];
}

function formatClanBattleDisplayDate(date: Date): string {
  const shifted = new Date(date.getTime() + 4 * 60 * 60 * 1000);
  return `${String(shifted.getUTCMonth() + 1).padStart(2, "0")}月${String(shifted.getUTCDate()).padStart(2, "0")}日`;
}

function formatRemainAttackFieldName(baseName: string, playerCount: number): string {
  return `${baseName} ${playerCount}人`;
}

function formatRemainAttackBucketName(remainingAttackCount: number, carryOverCount: number): string {
  if (carryOverCount === 0) {
    return `残${remainingAttackCount}凸`;
  }

  return `残${remainingAttackCount}凸（持越${carryOverCount}凸）`;
}

function formatRemainAttackSummaryDescription(
  remainingAttackCount: number,
  carryOverCount: number,
): string {
  return `残 ${remainingAttackCount}凸 ${carryOverCount}持`;
}

function compareRemainAttackBuckets(left: RemainAttackBucket, right: RemainAttackBucket): number {
  const remainAttackDiff = right.remainingAttackCount - left.remainingAttackCount;
  if (remainAttackDiff !== 0) {
    return remainAttackDiff;
  }

  return right.carryOverCount - left.carryOverCount;
}

function splitFieldLines(lines: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let currentChunk: string[] = [];
  let currentLength = 0;

  for (const line of lines) {
    const nextLength = currentLength === 0 ? line.length : currentLength + 1 + line.length;
    if (currentChunk.length > 0 && nextLength > MAX_FIELD_VALUE_LENGTH) {
      chunks.push(currentChunk);
      currentChunk = [line];
      currentLength = line.length;
      continue;
    }

    currentChunk.push(line);
    currentLength = nextLength;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

export function renderRemainAttackEmbed(input: RemainAttackRendererInput): EmbedBuilder {
  const clock = input.clock ?? systemClock;
  const today = formatClanBattleDisplayDate(now(clock));
  const embed = new EmbedBuilder().setTitle(`${today} の残凸状況`).setColor(0xe67e22);
  const bucketMap = new Map<string, RemainAttackBucket>();

  let sumRemainAttack = 0;
  let sumCarryOver = 0;

  for (const playerData of input.clanData.playerDataMap.values()) {
    const displayName = input.displayNamesByUserId.get(playerData.userId) ?? playerData.userId;
    const text = playerData.taskKill ? `- ${displayName} ${EMOJIS.taskKill}` : `- ${displayName}`;
    const attackCount = playerData.battleAttackCount;
    const remainingAttackCount = playerData.battleAttackLimit - attackCount;
    const carryOverCount = playerData.carryOverList.length;
    const bucketKey = `${remainingAttackCount}:${carryOverCount}`;
    const bucket = bucketMap.get(bucketKey) ?? {
      remainingAttackCount,
      carryOverCount,
      players: [],
    };

    bucket.players.push(text);
    bucketMap.set(bucketKey, bucket);
    sumRemainAttack += remainingAttackCount;
    sumCarryOver += carryOverCount;
  }

  const buckets = [...bucketMap.values()].sort(compareRemainAttackBuckets);
  for (const bucket of buckets) {
    const fieldBaseName = formatRemainAttackBucketName(
      bucket.remainingAttackCount,
      bucket.carryOverCount,
    );
    const chunks = splitFieldLines(bucket.players);

    chunks.forEach((chunk, chunkIndex) => {
      const suffix = chunks.length > 1 ? String.fromCharCode(65 + chunkIndex) : "";
      embed.addFields({
        name: formatRemainAttackFieldName(`${fieldBaseName}${suffix}`, chunk.length),
        value: `\`\`\`md\n${chunk.join("\n").replaceAll("_", "＿")}\n\`\`\``,
        inline: false,
      });
    });
  }

  embed.setDescription(formatRemainAttackSummaryDescription(sumRemainAttack, sumCarryOver));

  return embed;
}
