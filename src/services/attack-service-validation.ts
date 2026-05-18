import { USER_MESSAGES } from "../constants/messages.js";
import { type ClanData } from "../domain/clan-data.js";
import type { PlayerData } from "../domain/player-data.js";
import { formatNotManagedMessage } from "./attack-service-support.js";

interface AttackValidationMember {
  id: string;
  displayName: string;
}

interface AttackValidationResponseChannel {
  send(payload: { content?: string }): Promise<void>;
}

export interface AttackValidationRequest {
  categoryId: string;
  channelId: string;
  lap?: number;
  bossNumber?: number;
  member: AttackValidationMember;
  responseChannel: AttackValidationResponseChannel;
}

interface AttackValidationDependencies {
  getClanData(categoryId: string): ClanData | undefined;
  ensureBossStatusRowsForExistingLap(clanData: ClanData, lap: number): void;
}

export interface ValidatedAttackRequest {
  clanData: ClanData;
  playerData: PlayerData;
  lap: number;
  bossIndex: number;
}

export async function resolveAttackBossIndex(
  clanData: ClanData,
  request: Pick<AttackValidationRequest, "bossNumber" | "channelId" | "responseChannel">,
): Promise<number | null> {
  if (request.bossNumber === undefined) {
    const bossIndex = clanData.getBossIndexFromChannelId(request.channelId);
    if (bossIndex === undefined) {
      await request.responseChannel.send({
        content: USER_MESSAGES.errors.bossNumberRequired,
      });
      return null;
    }

    return bossIndex;
  }

  if (!(0 < request.bossNumber && request.bossNumber < 6)) {
    await request.responseChannel.send({
      content: USER_MESSAGES.errors.invalidBossNumber,
    });
    return null;
  }

  return request.bossNumber - 1;
}

export async function validateAttackRequest(
  request: AttackValidationRequest,
  dependencies: AttackValidationDependencies,
): Promise<ValidatedAttackRequest | null> {
  const clanData = dependencies.getClanData(request.categoryId);
  if (!clanData) {
    await request.responseChannel.send({
      content: USER_MESSAGES.errors.categoryRequired,
    });
    return null;
  }

  const bossIndex = await resolveAttackBossIndex(clanData, request);
  if (bossIndex === null) {
    return null;
  }

  let lap: number;
  try {
    lap = clanData.getLatestLap(bossIndex);
  } catch {
    await request.responseChannel.send({
      content: USER_MESSAGES.errors.invalidLap,
    });
    return null;
  }

  if (request.lap !== undefined) {
    if (lap < request.lap || !clanData.progressMessageIdsByLap.has(request.lap)) {
      await request.responseChannel.send({
        content: USER_MESSAGES.errors.invalidLap,
      });
      return null;
    }

    lap = request.lap;
  }

  dependencies.ensureBossStatusRowsForExistingLap(clanData, lap);

  const playerData = clanData.getPlayerData(request.member.id);
  if (!playerData) {
    await request.responseChannel.send({
      content: formatNotManagedMessage(request.member.displayName),
    });
    return null;
  }

  return {
    clanData,
    playerData,
    lap,
    bossIndex,
  };
}
