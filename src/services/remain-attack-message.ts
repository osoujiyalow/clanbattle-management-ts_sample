import type { EmbedBuilder } from "discord.js";

import { EMOJIS } from "../constants/emojis.js";
import type { ClanData } from "../domain/clan-data.js";
import { renderRemainAttackEmbed } from "../renderers/remain-attack-renderer.js";
import { type Clock } from "../shared/time.js";

export interface RemainAttackSendPayload {
  content?: string;
  embeds?: readonly EmbedBuilder[];
}

export interface RemainAttackCreatedMessage {
  readonly id: string;
  addReaction(emoji: string): Promise<void>;
}

export interface RemainAttackTextChannel<
  TCreatedMessage extends RemainAttackCreatedMessage = RemainAttackCreatedMessage,
> {
  readonly id: string;
  sendMessage(payload: RemainAttackSendPayload): Promise<TCreatedMessage>;
}

export function buildRemainAttackEmbed(
  clanData: ClanData,
  displayNamesByUserId: ReadonlyMap<string, string>,
  clock: Clock,
): EmbedBuilder {
  return renderRemainAttackEmbed({
    clanData,
    displayNamesByUserId,
    clock,
  });
}

export interface SendRemainAttackMessageResult {
  readonly messageId: string;
  readonly taskKillReactionAdded: boolean;
  readonly taskKillReactionError?: unknown;
}

export async function sendRemainAttackMessage<
  TCreatedMessage extends RemainAttackCreatedMessage,
>(
  channel: RemainAttackTextChannel<TCreatedMessage>,
  clanData: ClanData,
  displayNamesByUserId: ReadonlyMap<string, string>,
  clock: Clock,
): Promise<SendRemainAttackMessageResult> {
  const message = await channel.sendMessage({
    embeds: [buildRemainAttackEmbed(clanData, displayNamesByUserId, clock)],
  });

  try {
    await message.addReaction(EMOJIS.taskKill);
    return {
      messageId: message.id,
      taskKillReactionAdded: true,
    };
  } catch (error) {
    return {
      messageId: message.id,
      taskKillReactionAdded: false,
      taskKillReactionError: error,
    };
  }
}
