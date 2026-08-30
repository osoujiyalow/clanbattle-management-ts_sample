import type { Guild } from "discord.js";

import type {
  MemberDiscordGateway,
  MemberIdentity,
  MemberResponseChannel,
  MemberService,
} from "../services/member-service.js";
import type { RuntimeStateService } from "../services/runtime-state-service.js";
import {
  DiscordGuildTextGateway,
  resolvePreferredGuildMemberDisplayName,
} from "./command-handlers/shared.js";

const NOOP_RESPONSE_CHANNEL: MemberResponseChannel = {
  async send() {},
};

export interface DateRolloverDepartedMemberCleanupOptions {
  runtimeStateService: Pick<RuntimeStateService, "get" | "ensureDateUpToDate">;
  memberService: Pick<MemberService, "remove">;
  guild: Guild;
  categoryId: string;
  discordGateway?: MemberDiscordGateway;
  resolveDisplayNames?: (guild: Guild) => Promise<ReadonlyMap<string, string>>;
  resolveMemberPresence?: (
    guild: Guild,
    userId: string,
  ) => Promise<ManagedMemberPresence>;
}

export type ManagedMemberPresence =
  | { status: "present"; displayName: string }
  | { status: "departed" }
  | { status: "unknown" };

function isUnknownMemberError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === 10007 || error.code === "10007")
  );
}

export async function resolveManagedMemberPresence(
  guild: Guild,
  userId: string,
): Promise<ManagedMemberPresence> {
  try {
    const member = await guild.members.fetch(userId);
    return {
      status: "present",
      displayName: resolvePreferredGuildMemberDisplayName(member),
    };
  } catch (error) {
    return isUnknownMemberError(error) ? { status: "departed" } : { status: "unknown" };
  }
}

async function resolveDepartedManagedMembers(
  guild: Guild,
  userIds: Iterable<string>,
  resolveDisplayNames?: (guild: Guild) => Promise<ReadonlyMap<string, string>>,
  resolveMemberPresence?: (
    guild: Guild,
    userId: string,
  ) => Promise<ManagedMemberPresence>,
): Promise<{
  departedMembers: MemberIdentity[];
  displayNamesByUserId: ReadonlyMap<string, string>;
}> {
  const displayNamesByUserId = new Map(await resolveDisplayNames?.(guild));
  const departedMembers: MemberIdentity[] = [];

  for (const userId of new Set(userIds)) {
    if (displayNamesByUserId.has(userId)) {
      continue;
    }

    const presence = await (resolveMemberPresence?.(guild, userId) ??
      resolveManagedMemberPresence(guild, userId));
    if (presence.status === "present") {
      displayNamesByUserId.set(userId, presence.displayName);
      continue;
    }

    if (presence.status === "departed") {
      departedMembers.push({
        id: userId,
        displayName: userId,
      });
    }
  }

  return {
    departedMembers,
    displayNamesByUserId,
  };
}

export async function cleanupDepartedMembersOnDateRollover(
  options: DateRolloverDepartedMemberCleanupOptions,
): Promise<number> {
  if (!options.runtimeStateService.get(options.categoryId)) {
    return 0;
  }

  const dayGuardResult = await options.runtimeStateService.ensureDateUpToDate(options.categoryId);
  if (!dayGuardResult.changed) {
    return 0;
  }

  const clanData = options.runtimeStateService.get(options.categoryId);
  if (!clanData) {
    return 0;
  }

  const { departedMembers, displayNamesByUserId } = await resolveDepartedManagedMembers(
    options.guild,
    clanData.playerDataMap.keys(),
    options.resolveDisplayNames,
    options.resolveMemberPresence,
  );
  const discordGateway = options.discordGateway ?? new DiscordGuildTextGateway(options.guild);
  let removedCount = 0;

  for (const member of departedMembers) {
    if (!options.runtimeStateService.get(options.categoryId)?.playerDataMap.has(member.id)) {
      continue;
    }

    const scopedDisplayNamesByUserId = new Map(displayNamesByUserId);
    scopedDisplayNamesByUserId.set(member.id, member.displayName);
    const result = await options.memberService.remove({
      categoryId: options.categoryId,
      actor: member,
      member,
      responseChannel: NOOP_RESPONSE_CHANNEL,
      discordGateway,
      displayNamesByUserId: scopedDisplayNamesByUserId,
    });

    removedCount += result ?? 0;
  }

  return removedCount;
}
