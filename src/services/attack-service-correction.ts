import {
  AttackEntry,
  AttackEntryKind,
  AttackEntryStatus,
} from "../domain/attack-entry.js";
import type { AttackStatus } from "../domain/attack-status.js";
import { AttackType } from "../domain/attack-type.js";
import type { ClanData } from "../domain/clan-data.js";
import type { ParsedDamage } from "../domain/util/damage-parser.js";
import { parseDamageMessage } from "../domain/util/damage-parser.js";
import type { PlayerData } from "../domain/player-data.js";
import type { ResourceAdjustment } from "../domain/resource-adjustment.js";
import { validateAttackEntryResourceProgression } from "./player-resource-state-projection.js";

export type AttackKindCorrectionPreparation =
  | {
      kind: "target-not-found";
    }
  | {
      kind: "invalid-resource-progression";
      nextKind: AttackEntryKind;
      nextAttackType: AttackType;
      simulatedAttackEntries: AttackEntry[];
    }
  | {
      kind: "ok";
      nextKind: AttackEntryKind;
      nextAttackType: AttackType;
      simulatedAttackEntries: AttackEntry[];
    };

export interface MessageDamageTarget {
  lap: number;
  attackStatus: AttackStatus;
  parsedDamage: ParsedDamage;
}

export function findCorrectableAttackEntries(
  attackEntries: readonly AttackEntry[],
  lap: number,
  bossIndex: number,
): AttackEntry[] {
  return attackEntries
    .filter(
      (attackEntry) =>
        attackEntry.lap === lap &&
        attackEntry.bossIndex === bossIndex &&
        (attackEntry.status === AttackEntryStatus.DECLARED ||
          attackEntry.status === AttackEntryStatus.FINISHED ||
          attackEntry.status === AttackEntryStatus.DEFEATED),
    )
    .sort((left, right) => {
      const declaredDiff = right.declaredAt.getTime() - left.declaredAt.getTime();
      if (declaredDiff !== 0) {
        return declaredDiff;
      }

      return right.attackEntryId.localeCompare(left.attackEntryId);
    });
}

export function prepareAttackKindCorrection(params: {
  sameDayAttackEntries: readonly AttackEntry[];
  sameDayResourceAdjustments: readonly ResourceAdjustment[];
  targetAttackEntryId: string;
}): AttackKindCorrectionPreparation {
  const simulatedAttackEntries = params.sameDayAttackEntries.map((attackEntry) =>
    AttackEntry.fromRecord(attackEntry.toRecord()),
  );
  const simulatedTargetAttackEntry = simulatedAttackEntries.find(
    (attackEntry) => attackEntry.attackEntryId === params.targetAttackEntryId,
  );
  if (!simulatedTargetAttackEntry) {
    return {
      kind: "target-not-found",
    };
  }

  const nextKind =
    simulatedTargetAttackEntry.kind === AttackEntryKind.BATTLE
      ? AttackEntryKind.CARRYOVER
      : AttackEntryKind.BATTLE;
  const nextAttackType =
    nextKind === AttackEntryKind.BATTLE ? AttackType.BATTLE : AttackType.CARRYOVER;

  simulatedTargetAttackEntry.kind = nextKind;

  if (
    !validateAttackEntryResourceProgression(
      simulatedAttackEntries,
      params.sameDayResourceAdjustments,
    )
  ) {
    return {
      kind: "invalid-resource-progression",
      nextKind,
      nextAttackType,
      simulatedAttackEntries,
    };
  }

  return {
    kind: "ok",
    nextKind,
    nextAttackType,
    simulatedAttackEntries,
  };
}

export function findMessageDamageTarget(params: {
  clanData: ClanData;
  bossIndex: number;
  playerData: PlayerData;
  messageContent: string;
}): MessageDamageTarget | null {
  const parsedDamage = parseDamageMessage(params.messageContent);
  if (!parsedDamage) {
    return null;
  }

  const lapList = [...params.clanData.progressMessageIdsByLap.keys()].sort(
    (left, right) => right - left,
  );
  for (const lap of lapList) {
    const bossStatusData = params.clanData.bossStatusByLap.get(lap)?.[params.bossIndex];
    if (!bossStatusData) {
      continue;
    }

    const attackStatusIndex = bossStatusData.getAttackStatusIndex(params.playerData, false);
    if (attackStatusIndex === undefined) {
      continue;
    }

    const attackStatus = bossStatusData.attackPlayers[attackStatusIndex];
    if (!attackStatus) {
      continue;
    }

    return {
      lap,
      attackStatus,
      parsedDamage,
    };
  }

  return null;
}
