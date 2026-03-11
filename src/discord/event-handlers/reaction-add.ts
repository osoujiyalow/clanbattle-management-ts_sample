import type {
  Guild,
  MessageReaction,
  PartialMessageReaction,
  PartialUser,
  User,
} from "discord.js";

import { EMOJIS } from "../../constants/emojis.js";
import { parseAttackType } from "../../domain/attack-type.js";
import type {
  AttackDeclareResponseChannel,
  AttackService,
} from "../../services/attack-service.js";
import type { MemberService } from "../../services/member-service.js";
import type { RuntimeStateService } from "../../services/runtime-state-service.js";
import { createChannelCarryOverSelector } from "../carryover-selector.js";
import {
  DiscordGuildTextGateway,
  resolvePreferredUserDisplayName,
  resolveCachedGuildDisplayNames,
} from "../command-handlers/shared.js";

type DiscordReaction = MessageReaction | PartialMessageReaction;
type DiscordReactionUser = User | PartialUser;

const NOOP_RESPONSE_CHANNEL: AttackDeclareResponseChannel = {
  async send() {},
};

export type DiscordReactionAddHandler = (
  reaction: DiscordReaction,
  user: DiscordReactionUser,
) => Promise<void>;

export interface ReactionAddHandlerOptions {
  runtimeStateService: Pick<RuntimeStateService, "get" | "ensureDateUpToDate">;
  attackService: Pick<
    AttackService,
    "declare" | "finish" | "defeatBoss" | "undo"
  >;
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

async function safelyRemoveReaction(reaction: DiscordReaction, userId: string): Promise<void> {
  try {
    await reaction.users.remove(userId);
  } catch {
    // Ignore failed cleanup; the mutation already ran or the message is gone.
  }
}

async function sendUndoMismatchWarning(
  message: DiscordReaction["message"],
  userId: string,
  lap: number,
  bossIndex: number,
  targetChannelId: string,
): Promise<void> {
  const channel = message.channel;
  if (!("send" in channel) || typeof channel.send !== "function") {
    return;
  }

  const sentMessage = await channel.send({
    content:
      `<@${userId}> \u3059\u3067\u306b${lap}\u5468\u76ee${bossIndex + 1}\u30dc\u30b9\u306b\u51f8\u3057\u3066\u3044\u307e\u3059\u3002\n` +
      `\u5148\u306b<#${targetChannelId}>\u3067${EMOJIS.reverse}\u3092\u62bc\u3057\u3066\u304f\u3060\u3055\u3044`,
  });

  if ("delete" in sentMessage && typeof sentMessage.delete === "function") {
    setTimeout(() => {
      void sentMessage.delete().catch(() => {});
    }, 30_000);
  }
}

function hasPendingAttack(
  message: DiscordReaction["message"],
  categoryId: string,
  userId: string,
  options: ReactionAddHandlerOptions,
): {
  bossIndex: number;
  lap: number;
} | null {
  const clanData = options.runtimeStateService.get(categoryId);
  if (!clanData) {
    return null;
  }

  const bossIndex = clanData.getBossIndexFromChannelId(message.channelId);
  if (bossIndex === undefined) {
    return null;
  }

  const lap = clanData.getLapFromMessageId(message.id, bossIndex);
  if (lap === undefined) {
    return null;
  }

  const playerData = clanData.getPlayerData(userId);
  const attackPlayers = clanData.bossStatusByLap.get(lap)?.[bossIndex]?.attackPlayers ?? [];
  const pendingAttack = attackPlayers.some(
    (attackStatus) => attackStatus.playerData.userId === playerData?.userId && !attackStatus.attacked,
  );

  if (!pendingAttack) {
    return null;
  }

  return {
    bossIndex,
    lap,
  };
}

export function createReactionAddHandler(options: ReactionAddHandlerOptions): DiscordReactionAddHandler {
  return async (reaction, user) => {
    if (user.bot) {
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

    const emoji = getEmojiName(reaction);
    const displayNamesByUserId = new Map(
      await (options.resolveDisplayNames?.(guild) ??
        Promise.resolve(resolveCachedGuildDisplayNames(guild))),
    );
    displayNamesByUserId.set(user.id, getUserDisplayName(user, displayNamesByUserId));
    const member = {
      id: user.id,
      displayName: getUserDisplayName(user, displayNamesByUserId),
    };
    const discordGateway =
      options.createDiscordGateway?.(guild) ?? new DiscordGuildTextGateway(guild);
    await options.runtimeStateService.ensureDateUpToDate(parentId);
    await options.memberService.ensureCurrentRemainAttackMessage({
      categoryId: parentId,
      member,
      discordGateway,
      displayNamesByUserId,
    });

    const clanData = options.runtimeStateService.get(parentId);
    if (!clanData) {
      return;
    }

    if (emoji === EMOJIS.taskKill && message.id === clanData.remainAttackMessageId) {
      await options.memberService.setTaskKill({
        categoryId: parentId,
        member,
        taskKill: true,
        discordGateway,
        displayNamesByUserId,
      });
      return;
    }

    const playerData = clanData.getPlayerData(user.id);
    if (!playerData) {
      return;
    }

    const bossIndex = clanData.getBossIndexFromChannelId(message.channelId);
    if (bossIndex === undefined) {
      return;
    }

    const lap = clanData.getLapFromMessageId(message.id, bossIndex);
    if (lap === undefined) {
      return;
    }

    if (parseAttackType(emoji)) {
      const attackPlayers = clanData.bossStatusByLap.get(lap)?.[bossIndex]?.attackPlayers ?? [];
      const alreadyDeclared = attackPlayers.some(
        (attackStatus) => attackStatus.playerData.userId === playerData.userId && !attackStatus.attacked,
      );
      const canDeclareCarryOver = emoji !== EMOJIS.carryover || playerData.carryOverList.length > 0;

      if (!alreadyDeclared && canDeclareCarryOver) {
        await options.attackService.declare({
          categoryId: parentId,
          channelId: message.channelId,
          lap,
          bossNumber: bossIndex + 1,
          attackType: emoji,
          member,
          responseChannel: NOOP_RESPONSE_CHANNEL,
          discordGateway,
          displayNamesByUserId,
        });
      }

      await safelyRemoveReaction(reaction, user.id);
      return;
    }

    if (emoji === EMOJIS.attack) {
      if (hasPendingAttack(message, parentId, user.id, options)) {
        await options.attackService.finish({
          categoryId: parentId,
          channelId: message.channelId,
          lap,
          bossNumber: bossIndex + 1,
          member,
          responseChannel: NOOP_RESPONSE_CHANNEL,
          discordGateway,
          displayNamesByUserId,
          selectCarryOver: createChannelCarryOverSelector(
            message.channel,
            user.id,
            `reaction-finish:${message.id}`,
          ),
        });
      }

      await safelyRemoveReaction(reaction, user.id);
      return;
    }

    if (emoji === EMOJIS.lastAttack) {
      if (hasPendingAttack(message, parentId, user.id, options)) {
        await options.attackService.defeatBoss({
          categoryId: parentId,
          channelId: message.channelId,
          lap,
          bossNumber: bossIndex + 1,
          member,
          responseChannel: NOOP_RESPONSE_CHANNEL,
          discordGateway,
          displayNamesByUserId,
          selectCarryOver: createChannelCarryOverSelector(
            message.channel,
            user.id,
            `reaction-defeat:${message.id}`,
          ),
        });
      }

      await safelyRemoveReaction(reaction, user.id);
      return;
    }

    if (emoji === EMOJIS.reverse) {
      const logData = playerData.log.at(-1);
      if (logData) {
        if (logData.bossIndex === bossIndex && logData.lap === lap) {
          await options.attackService.undo({
            categoryId: parentId,
            member,
            responseChannel: NOOP_RESPONSE_CHANNEL,
            discordGateway,
            displayNamesByUserId,
          });
        } else {
          await sendUndoMismatchWarning(
            message,
            user.id,
            logData.lap,
            logData.bossIndex,
            clanData.bossChannelIds[logData.bossIndex] ?? message.channelId,
          );
        }
      }

      await safelyRemoveReaction(reaction, user.id);
    }
  };
}
