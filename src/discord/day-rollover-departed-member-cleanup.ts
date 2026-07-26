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
  resolveGuildDisplayNamesForUserIds,
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
}

async function resolveDepartedManagedMembers(
  guild: Guild,
  userIds: Iterable<string>,
  resolveDisplayNames?: (guild: Guild) => Promise<ReadonlyMap<string, string>>,
): Promise<{
  departedMembers: MemberIdentity[];
  displayNamesByUserId: ReadonlyMap<string, string>;
}> {
  const managedUserIds = new Set(userIds);
  const displayNamesByUserId = new Map(
    await (resolveDisplayNames?.(guild) ?? resolveGuildDisplayNamesForUserIds(guild, managedUserIds)),
  );
  const departedMembers = [...managedUserIds]
    .filter((userId) => !displayNamesByUserId.has(userId))
    .map((userId) => ({
      id: userId,
      displayName: userId,
    }));

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
