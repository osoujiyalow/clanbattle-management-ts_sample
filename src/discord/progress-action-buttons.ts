import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type MessageActionRowComponentBuilder,
} from "discord.js";

import { EMOJIS } from "../constants/emojis.js";

const PROGRESS_ACTION_BUTTON_PREFIX = "progress-action";

export const ProgressAction = {
  BATTLE: "battle",
  CARRYOVER: "carryover",
  FINISH: "finish",
  DEFEAT: "defeat",
  UNDO: "undo",
} as const;

export type ProgressAction = (typeof ProgressAction)[keyof typeof ProgressAction];

function createProgressActionButton(input: {
  action: ProgressAction;
  emoji: string;
  label: string;
  style: ButtonStyle;
}): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(createProgressActionButtonCustomId(input.action))
    .setEmoji(input.emoji)
    .setLabel(input.label)
    .setStyle(input.style);
}

export function createProgressActionButtonCustomId(action: ProgressAction): string {
  return `${PROGRESS_ACTION_BUTTON_PREFIX}:${action}`;
}

export function parseProgressActionButtonCustomId(customId: string): ProgressAction | null {
  const parts = customId.split(":");
  if (parts.length !== 2 || parts[0] !== PROGRESS_ACTION_BUTTON_PREFIX) {
    return null;
  }

  const [, action] = parts;
  if (
    action !== ProgressAction.BATTLE &&
    action !== ProgressAction.CARRYOVER &&
    action !== ProgressAction.FINISH &&
    action !== ProgressAction.DEFEAT &&
    action !== ProgressAction.UNDO
  ) {
    return null;
  }

  return action;
}

export function createProgressActionComponents(input?: {
  interactive?: boolean;
}): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  if (input?.interactive === false) {
    return [];
  }

  return [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      createProgressActionButton({
        action: ProgressAction.BATTLE,
        emoji: EMOJIS.physics,
        label: "本戦凸",
        style: ButtonStyle.Primary,
      }),
      createProgressActionButton({
        action: ProgressAction.CARRYOVER,
        emoji: EMOJIS.carryover,
        label: "持越凸",
        style: ButtonStyle.Primary,
      }),
    ),
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      createProgressActionButton({
        action: ProgressAction.FINISH,
        emoji: EMOJIS.attack,
        label: "削り",
        style: ButtonStyle.Success,
      }),
      createProgressActionButton({
        action: ProgressAction.DEFEAT,
        emoji: EMOJIS.lastAttack,
        label: "討伐",
        style: ButtonStyle.Danger,
      }),
      createProgressActionButton({
        action: ProgressAction.UNDO,
        emoji: EMOJIS.reverse,
        label: "戻る",
        style: ButtonStyle.Secondary,
      }),
    ),
  ];
}
