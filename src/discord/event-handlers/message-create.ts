import type { Guild, Message } from "discord.js";

import type { AttackService } from "../../services/attack-service.js";
import {
  DiscordGuildTextGateway,
  resolvePreferredGuildMemberDisplayName,
  resolvePreferredUserDisplayName,
  resolveCachedGuildDisplayNames,
} from "../command-handlers/shared.js";

export type DiscordMessageCreateHandler = (message: Message) => Promise<void>;

export interface MessageCreateHandlerOptions {
  attackService: Pick<AttackService, "applyMessageDamage">;
  createDiscordGateway?: (guild: Guild) => DiscordGuildTextGateway;
  resolveDisplayNames?: (guild: Guild) => Promise<ReadonlyMap<string, string>>;
}

function getMessageAuthorDisplayName(message: Message): string {
  if (message.member) {
    return resolvePreferredGuildMemberDisplayName(message.member);
  }

  return resolvePreferredUserDisplayName(message.author);
}

export function createMessageCreateHandler(
  options: MessageCreateHandlerOptions,
): DiscordMessageCreateHandler {
  return async (message) => {
    if (message.author.bot || !message.guild) {
      return;
    }

    const parentId = "parentId" in message.channel ? message.channel.parentId : null;
    if (!parentId) {
      return;
    }

    const displayNamesByUserId = new Map(
      await (options.resolveDisplayNames?.(message.guild) ??
        Promise.resolve(resolveCachedGuildDisplayNames(message.guild))),
    );
    displayNamesByUserId.set(message.author.id, getMessageAuthorDisplayName(message));

    await options.attackService.applyMessageDamage({
      categoryId: parentId,
      channelId: message.channel.id,
      messageContent: message.content,
      member: {
        id: message.author.id,
        displayName: getMessageAuthorDisplayName(message),
      },
      discordGateway:
        options.createDiscordGateway?.(message.guild) ?? new DiscordGuildTextGateway(message.guild),
      displayNamesByUserId,
    });
  };
}
