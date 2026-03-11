import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type ButtonInteraction,
  type Message,
} from "discord.js";

import type { AttackCarryOverSelector } from "../services/attack-service.js";

const CARRYOVER_SELECTION_TIMEOUT_MS = 60_000;
const CARRYOVER_SELECTION_PREFIX = "carryover-select";

type CarryOverSelectionChannel = {
  send(payload: {
    content?: string;
    components?: readonly ActionRowBuilder<ButtonBuilder>[];
  }): Promise<Pick<Message, "awaitMessageComponent" | "delete">>;
};

function canSendToChannel(channel: unknown): channel is CarryOverSelectionChannel {
  return Boolean(channel && typeof channel === "object" && "send" in channel && typeof channel.send === "function");
}

function buildCarryOverSelectionContent(
  carryOverList: Parameters<AttackCarryOverSelector>[0]["carryOverList"],
): string {
  return carryOverList
    .map((carryOver, index) => `${index + 1}: ${carryOver.toString()}`)
    .join("\n");
}

function createCarryOverSelectionRow(customIdPrefix: string, carryOverCount: number) {
  const row = new ActionRowBuilder<ButtonBuilder>();
  for (let index = 0; index < carryOverCount; index += 1) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${customIdPrefix}:${index}`)
        .setLabel(String(index + 1))
        .setStyle(ButtonStyle.Primary),
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:cancel`)
      .setLabel("キャンセル")
      .setStyle(ButtonStyle.Secondary),
  );

  return row;
}

async function deleteMessageQuietly(message: Pick<Message, "delete">): Promise<void> {
  try {
    await message.delete();
  } catch {
    // Ignore cleanup failures for selector messages.
  }
}

function parseCarryOverSelection(customId: string, customIdPrefix: string): number | null {
  if (!customId.startsWith(`${customIdPrefix}:`)) {
    return null;
  }

  const suffix = customId.slice(customIdPrefix.length + 1);
  if (suffix === "cancel") {
    return null;
  }

  const selected = Number.parseInt(suffix, 10);
  return Number.isNaN(selected) ? null : selected;
}

export function createChannelCarryOverSelector(
  channel: unknown,
  ownerUserId: string,
  scopeId: string,
): AttackCarryOverSelector {
  return async ({ carryOverList }) => {
    if (!canSendToChannel(channel)) {
      return null;
    }

    const customIdPrefix = `${CARRYOVER_SELECTION_PREFIX}:${scopeId}:${Date.now()}`;
    const selectionMessage = await channel.send({
      content: buildCarryOverSelectionContent(carryOverList),
      components: [createCarryOverSelectionRow(customIdPrefix, carryOverList.length)],
    });

    try {
      const selection = await selectionMessage.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: CARRYOVER_SELECTION_TIMEOUT_MS,
        filter: (buttonInteraction: ButtonInteraction) =>
          buttonInteraction.user.id === ownerUserId &&
          buttonInteraction.customId.startsWith(`${customIdPrefix}:`),
      });

      await selection.deferUpdate();
      return parseCarryOverSelection(selection.customId, customIdPrefix);
    } catch {
      return null;
    } finally {
      await deleteMessageQuietly(selectionMessage);
    }
  };
}
