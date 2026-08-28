import type { Logger } from "../shared/logger.js";
import { AttackStatus } from "../domain/attack-status.js";
import { AttackType } from "../domain/attack-type.js";
import { resolveCurrentBossHp } from "../domain/boss-hp.js";
import { PlayerData } from "../domain/player-data.js";
import { AttackStatusRepository } from "../repositories/sqlite/attack-status-repository.js";
import {
  ProgressMessageIdRepository,
  SummaryMessageIdRepository,
} from "../repositories/sqlite/boss-message-id-repository.js";
import { ClanRepository } from "../repositories/sqlite/clan-repository.js";
import { runInTransaction, type SqliteDatabase } from "../repositories/sqlite/db.js";
import { now, type Clock, systemClock } from "../shared/time.js";
import { AttackServiceMessageCoordinator } from "./attack-service-message-coordinator.js";
import { DEFAULT_DISCORD_MESSAGE_RETRY_DELAY_MS } from "./discord-message-retry.js";
import type {
  AttackDeclareMember,
  AttackDeclareResponseChannel,
  AttackDiscordGateway,
} from "./attack-service.js";
import type { RuntimeStateService } from "./runtime-state-service.js";

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export interface ChangeBossHpRequest {
  categoryId: string;
  channelId: string;
  lap: number;
  bossIndex: number;
  targetHp: number;
  actor: AttackDeclareMember;
  responseChannel: AttackDeclareResponseChannel;
  discordGateway: AttackDiscordGateway;
  displayNamesByUserId?: ReadonlyMap<string, string>;
  resolveDisplayNamesByUserIds?: (
    userIds: Iterable<string>,
  ) => Promise<ReadonlyMap<string, string>>;
}

export interface ChangeBossHpResult {
  beforeHp: number;
  afterHp: number;
  hpDelta: number;
}

export interface HpChangeServiceOptions {
  database: SqliteDatabase;
  runtimeStateService: RuntimeStateService;
  attackStatusRepository?: AttackStatusRepository;
  clanRepository?: ClanRepository;
  progressMessageIdRepository?: ProgressMessageIdRepository;
  summaryMessageIdRepository?: SummaryMessageIdRepository;
  clock?: Clock;
  logger?: Logger;
  redrawRetryDelayMs?: number;
}

function formatHp(value: number): string {
  return value.toLocaleString("en-US");
}

function formatSignedHp(value: number): string {
  return `${value > 0 ? "+" : ""}${formatHp(value)}`;
}

export class HpChangeService {
  private readonly attackStatusRepository: AttackStatusRepository;
  private readonly clock: Clock;
  private readonly messageCoordinator: AttackServiceMessageCoordinator;

  constructor(private readonly options: HpChangeServiceOptions) {
    const clanRepository = options.clanRepository ?? new ClanRepository(options.database);
    const progressMessageIdRepository =
      options.progressMessageIdRepository ?? new ProgressMessageIdRepository(options.database);
    const summaryMessageIdRepository =
      options.summaryMessageIdRepository ?? new SummaryMessageIdRepository(options.database);
    const logger = options.logger ?? NOOP_LOGGER;

    this.attackStatusRepository =
      options.attackStatusRepository ?? new AttackStatusRepository(options.database);
    this.clock = options.clock ?? systemClock;
    this.messageCoordinator = new AttackServiceMessageCoordinator({
      database: options.database,
      clanRepository,
      progressMessageIdRepository,
      summaryMessageIdRepository,
      clock: this.clock,
      logger,
      redrawRetryDelayMs:
        options.redrawRetryDelayMs ?? DEFAULT_DISCORD_MESSAGE_RETRY_DELAY_MS,
    });
  }

  async changeBossHp(request: ChangeBossHpRequest): Promise<ChangeBossHpResult | null> {
    return this.options.runtimeStateService.withCategoryLock(request.categoryId, async () => {
      const currentClanData = this.options.runtimeStateService.get(request.categoryId);
      const dayGuardResult = currentClanData
        ? this.options.runtimeStateService.ensureDateUpToDateLocked(request.categoryId, this.clock)
        : null;
      const clanData = this.options.runtimeStateService.get(request.categoryId);

      if (!clanData) {
        await request.responseChannel.send({
          content: "凸管理カテゴリ内のボスチャンネルで実行してください。",
        });
        return null;
      }

      await this.messageCoordinator.ensureCurrentRemainAttackMessage(
        clanData,
        dayGuardResult,
        { ...request, member: request.actor },
      );
      await this.messageCoordinator.ensureCurrentSummaryMessage(
        clanData,
        dayGuardResult,
        { ...request, member: request.actor },
      );

      if (clanData.bossChannelIds[request.bossIndex] !== request.channelId) {
        await request.responseChannel.send({
          content: "このHP修正画面を開いたボスチャンネルで送信してください。",
        });
        return null;
      }

      let latestLap: number;
      try {
        latestLap = clanData.getLatestLap(request.bossIndex);
      } catch {
        await request.responseChannel.send({ content: "対象ボスの現在周回を取得できませんでした。" });
        return null;
      }

      if (latestLap !== request.lap) {
        await request.responseChannel.send({
          content: "対象ボスの周回が変わりました。もう一度 `/hp_change` を実行してください。",
        });
        return null;
      }

      const bossStatusData = clanData.bossStatusByLap.get(request.lap)?.[request.bossIndex];
      if (!bossStatusData) {
        await request.responseChannel.send({ content: "対象ボスのHP情報が見つかりません。" });
        return null;
      }

      if (bossStatusData.beated) {
        await request.responseChannel.send({ content: "討伐済みのボスはHP修正できません。" });
        return null;
      }

      if (!Number.isSafeInteger(request.targetHp) || request.targetHp <= 0) {
        await request.responseChannel.send({ content: "修正後HPは1以上の整数で入力してください。" });
        return null;
      }

      if (request.targetHp > bossStatusData.maxHp) {
        await request.responseChannel.send({
          content: `修正後HPは最大HP（${formatHp(bossStatusData.maxHp)}万）以下で入力してください。`,
        });
        return null;
      }

      const beforeHp = resolveCurrentBossHp(bossStatusData);
      if (request.targetHp === beforeHp) {
        await request.responseChannel.send({
          content: `現在HPと同じ${formatHp(beforeHp)}万のため、修正履歴は追加しませんでした。`,
        });
        return null;
      }

      const hpDelta = request.targetHp - beforeHp;
      let created = now(this.clock);
      while (
        bossStatusData.attackPlayers.some(
          (attackStatus) =>
            attackStatus.playerData.userId === request.actor.id &&
            attackStatus.created.getTime() === created.getTime(),
        )
      ) {
        created = new Date(created.getTime() + 1);
      }
      const adjustment = new AttackStatus({
        playerData: clanData.getPlayerData(request.actor.id) ?? new PlayerData({ userId: request.actor.id }),
        attackType: AttackType.HP_ADJUSTMENT,
        carryOver: false,
        damage: -hpDelta,
        attacked: true,
        created,
      });

      runInTransaction(this.options.database, () => {
        this.attackStatusRepository.insert(
          clanData.categoryId,
          request.lap,
          request.bossIndex,
          adjustment,
        );
      });
      bossStatusData.attackPlayers.push(adjustment);
      this.options.runtimeStateService.notifyCategoryStateChanged(clanData.categoryId);

      const renderRequest = { ...request, member: request.actor };
      await this.messageCoordinator.updateProgressMessages(
        clanData,
        request.lap,
        request.bossIndex,
        renderRequest,
      );
      await this.messageCoordinator.updateSummaryMessage(clanData, renderRequest);

      await request.responseChannel.send({
        content:
          `${request.bossIndex + 1}ボスのHPを修正しました。\n` +
          `${formatHp(beforeHp)}万 → ${formatHp(request.targetHp)}万` +
          `（${formatSignedHp(hpDelta)}万） ${request.actor.displayName}`,
      });

      return {
        beforeHp,
        afterHp: request.targetHp,
        hpDelta,
      };
    });
  }
}
