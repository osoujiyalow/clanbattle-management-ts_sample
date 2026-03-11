import type {
  Guild,
  MessageReaction,
  PartialMessageReaction,
  PartialUser,
  User,
} from "discord.js";

import { EMOJIS } from "../../constants/emojis.js";
import type { MemberService } from "../../services/member-service.js";
import type { RuntimeStateService } from "../../services/runtime-state-service.js";
import {
  DiscordGuildTextGateway,
  resolvePreferredUserDisplayName,
  resolveCachedGuildDisplayNames,
} from "../command-handlers/shared.js";

type DiscordReaction = MessageReaction | PartialMessageReaction;
type DiscordReactionUser = User | PartialUser;

export type DiscordReactionRemoveHandler = (
  reaction: DiscordReaction,
  user: DiscordReactionUser,
) => Promise<void>;

export interface ReactionRemoveHandlerOptions {
  runtimeStateService: Pick<RuntimeStateService, "get" | "ensureDateUpToDate">;
  memberService: Pick<MemberService, "ensureCurrentRemainAttackMessage" | "setTaskKill">;
  createDiscordGateway?: (guild: Guild) => DiscordGuildTextGateway;
  resolveDisplayNames?: (guild: Guild) => Promise<ReadonlyMap<string, string>>;
}

function getUserDisplayName(
  user: DiscordReactionUser,
  displayNamesByUserId: ReadonlyMap<string, string>,
): string {
  return displayNamesByUserId.get(user.id) ?? resolvePreferredUserDisplayName(user);
}

function getEmojiName(reaction: DiscordReaction): string {
  return reaction.emoji.name ?? reaction.emoji.toString();
}

async function hydrateReaction(reaction: DiscordReaction): Promise<DiscordReaction["message"]> {
  if (reaction.partial) {
    await reaction.fetch();
  }

  if (reaction.message.partial && "fetch" in reaction.message) {
    await reaction.message.fetch();
  }

  return reaction.message;
}

export function createReactionRemoveHandler(
  options: ReactionRemoveHandlerOptions,
): DiscordReactionRemoveHandler {
  return async (reaction, user) => {
    if (user.bot || getEmojiName(reaction) !== EMOJIS.taskKill) {
      return;
    }

    const message = await hydrateReaction(reaction);
    const guild = message.guild;
    if (!guild) {
      return;
    }

    const parentId = "parentId" in message.channel ? message.channel.parentId : null;
    if (!parentId) {
      return;
    }

    if (!options.runtimeStateService.get(parentId)) {
      return;
    }

    const displayNamesByUserId = new Map(
      await (options.resolveDisplayNames?.(guild) ??
        Promise.resolve(resolveCachedGuildDisplayNames(guild))),
    );
    displayNamesByUserId.set(user.id, getUserDisplayName(user, displayNamesByUserId));
    const discordGateway =
      options.createDiscordGateway?.(guild) ?? new DiscordGuildTextGateway(guild);
    await options.runtimeStateService.ensureDateUpToDate(parentId);
    await options.memberService.ensureCurrentRemainAttackMessage({
      categoryId: parentId,
      member: {
        id: user.id,
        displayName: getUserDisplayName(user, displayNamesByUserId),
      },
      discordGateway,
      displayNamesByUserId,
    });

    const clanData = options.runtimeStateService.get(parentId);
    if (!clanData || message.id !== clanData.remainAttackMessageId) {
      return;
    }

    await options.memberService.setTaskKill({
      categoryId: parentId,
      member: {
        id: user.id,
        displayName: getUserDisplayName(user, displayNamesByUserId),
      },
      taskKill: false,
      discordGateway,
      displayNamesByUserId,
    });
  };
}
