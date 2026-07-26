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
import { cleanupDepartedMembersOnDateRollover } from "../day-rollover-departed-member-cleanup.js";
import {
  DiscordGuildTextGateway,
  resolveGuildDisplayNamesForUserIds,
  resolvePreferredUserDisplayName,
} from "../command-handlers/shared.js";

type DiscordReaction = MessageReaction | PartialMessageReaction;
type DiscordReactionUser = User | PartialUser;

export type DiscordReactionRemoveHandler = (
  reaction: DiscordReaction,
  user: DiscordReactionUser,
) => Promise<void>;

export interface ReactionRemoveHandlerOptions {
  runtimeStateService: Pick<RuntimeStateService, "get" | "ensureDateUpToDate">;
  memberService: Pick<MemberService, "ensureCurrentRemainAttackMessage" | "setTaskKill"> &
    Partial<Pick<MemberService, "remove">>;
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

    const discordGateway =
      options.createDiscordGateway?.(guild) ?? new DiscordGuildTextGateway(guild);
    if (options.memberService.remove) {
      await cleanupDepartedMembersOnDateRollover({
        runtimeStateService: options.runtimeStateService,
        memberService: {
          remove: (request) => options.memberService.remove!(request),
        },
        guild,
        categoryId: parentId,
        discordGateway,
        ...(options.resolveDisplayNames ? { resolveDisplayNames: options.resolveDisplayNames } : {}),
      });
    } else {
      await options.runtimeStateService.ensureDateUpToDate(parentId);
    }

    const clanData = options.runtimeStateService.get(parentId);
    if (!clanData || message.id !== clanData.remainAttackMessageId) {
      return;
    }

    const displayNamesByUserId = new Map(
      await (options.resolveDisplayNames?.(guild) ??
        resolveGuildDisplayNamesForUserIds(guild, clanData.playerDataMap.keys())),
    );
    displayNamesByUserId.set(user.id, getUserDisplayName(user, displayNamesByUserId));
    const member = {
      id: user.id,
      displayName: getUserDisplayName(user, displayNamesByUserId),
    };
    await options.memberService.ensureCurrentRemainAttackMessage({
      categoryId: parentId,
      member,
      discordGateway,
      displayNamesByUserId,
    });

    await options.memberService.setTaskKill({
      categoryId: parentId,
      member,
      taskKill: false,
      discordGateway,
      displayNamesByUserId,
    });
  };
}
