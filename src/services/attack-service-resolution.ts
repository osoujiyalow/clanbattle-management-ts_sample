import { USER_MESSAGES } from "../constants/messages.js";
import { AttackEntry, AttackEntryStatus } from "../domain/attack-entry.js";
import type { AttackStatus } from "../domain/attack-status.js";
import type { BossStatusData } from "../domain/boss-status-data.js";
import type { AttackEntryRepository } from "../repositories/sqlite/attack-entry-repository.js";
import {
  ATTACK_NOT_DECLARED_MESSAGE,
  createAttackEntryId,
  toAttackEntryKind,
} from "./attack-service-support.js";
import type { ValidatedAttackRequest } from "./attack-service-validation.js";

interface AttackResolutionResponseChannel {
  send(payload: { content?: string }): Promise<void>;
}

export interface AttackResolutionRequest {
  responseChannel: AttackResolutionResponseChannel;
}

export interface ValidatedResolutionRequest extends ValidatedAttackRequest {
  bossStatusData: BossStatusData;
  attackStatus: AttackStatus;
}

interface FindExistingAttackEntryParams {
  attackEntryRepository: AttackEntryRepository;
  categoryId: string;
  userId: string;
  lap: number;
  bossIndex: number;
  attackStatus: AttackStatus;
}

interface CreateAttackEntryFromAttackStatusParams {
  categoryId: string;
  dayKey: string;
  lap: number;
  bossIndex: number;
  attackStatus: AttackStatus;
}

interface UpsertAttackEntrySnapshotParams extends CreateAttackEntryFromAttackStatusParams {
  attackEntryRepository: AttackEntryRepository;
}

export async function resolveDeclaredAttack(
  validation: ValidatedAttackRequest,
  request: AttackResolutionRequest,
): Promise<ValidatedResolutionRequest | null> {
  const bossStatusData =
    validation.clanData.bossStatusByLap.get(validation.lap)?.[validation.bossIndex];
  if (!bossStatusData) {
    await request.responseChannel.send({
      content: USER_MESSAGES.errors.invalidLap,
    });
    return null;
  }

  const attackStatusIndex = bossStatusData.getAttackStatusIndex(validation.playerData, false);
  if (attackStatusIndex === undefined) {
    await request.responseChannel.send({
      content: ATTACK_NOT_DECLARED_MESSAGE,
    });
    return null;
  }

  const attackStatus = bossStatusData.attackPlayers[attackStatusIndex];
  if (!attackStatus) {
    await request.responseChannel.send({
      content: ATTACK_NOT_DECLARED_MESSAGE,
    });
    return null;
  }

  return {
    ...validation,
    bossStatusData,
    attackStatus,
  };
}

export function normalizeAttackEntryDamage(damage: number): number | null {
  return damage > 0 ? damage : null;
}

export function normalizeAttackEntryMemo(memo: string): string | null {
  return memo.length > 0 ? memo : null;
}

export function findExistingAttackEntry(params: FindExistingAttackEntryParams): AttackEntry | null {
  return params.attackEntryRepository.findById(
    createAttackEntryId(
      params.categoryId,
      params.userId,
      params.lap,
      params.bossIndex,
      params.attackStatus.created,
    ),
  );
}

export function createAttackEntryFromAttackStatus(
  params: CreateAttackEntryFromAttackStatusParams,
): AttackEntry {
  return new AttackEntry({
    attackEntryId: createAttackEntryId(
      params.categoryId,
      params.attackStatus.playerData.userId,
      params.lap,
      params.bossIndex,
      params.attackStatus.created,
    ),
    categoryId: params.categoryId,
    userId: params.attackStatus.playerData.userId,
    dayKey: params.dayKey,
    lap: params.lap,
    bossIndex: params.bossIndex,
    kind: toAttackEntryKind(params.attackStatus.attackType),
    status: params.attackStatus.attacked ? AttackEntryStatus.FINISHED : AttackEntryStatus.DECLARED,
    declaredAt: params.attackStatus.created,
    resolvedAt: params.attackStatus.attacked ? params.attackStatus.created : null,
    damage: normalizeAttackEntryDamage(params.attackStatus.damage),
    memo: normalizeAttackEntryMemo(params.attackStatus.memo),
  });
}

export function upsertAttackEntrySnapshot(params: UpsertAttackEntrySnapshotParams): AttackEntry {
  const existing = findExistingAttackEntry({
    attackEntryRepository: params.attackEntryRepository,
    categoryId: params.categoryId,
    userId: params.attackStatus.playerData.userId,
    lap: params.lap,
    bossIndex: params.bossIndex,
    attackStatus: params.attackStatus,
  });
  const attackEntry =
    existing ??
    createAttackEntryFromAttackStatus({
      categoryId: params.categoryId,
      dayKey: params.dayKey,
      lap: params.lap,
      bossIndex: params.bossIndex,
      attackStatus: params.attackStatus,
    });

  attackEntry.dayKey = params.dayKey;
  attackEntry.kind = toAttackEntryKind(params.attackStatus.attackType);
  attackEntry.damage = normalizeAttackEntryDamage(params.attackStatus.damage);
  attackEntry.memo = normalizeAttackEntryMemo(params.attackStatus.memo);

  if (existing) {
    params.attackEntryRepository.update(attackEntry);
  } else {
    params.attackEntryRepository.insert(attackEntry);
  }

  return attackEntry;
}
