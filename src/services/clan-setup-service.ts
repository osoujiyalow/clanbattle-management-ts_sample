import type {
  ActionRowBuilder,
  EmbedBuilder,
  MessageActionRowComponentBuilder,
} from "discord.js";

import { EMOJIS } from "../constants/emojis.js";
import { USER_MESSAGES } from "../constants/messages.js";
import { ClanData } from "../domain/clan-data.js";
import { createProgressActionComponents } from "../discord/progress-action-buttons.js";
import { renderProgressEmbed } from "../renderers/progress-renderer.js";
import { renderRemainAttackEmbed } from "../renderers/remain-attack-renderer.js";
import { renderSummaryOverviewEmbed } from "../renderers/summary-overview-renderer.js";
import { BossStatusRepository } from "../repositories/sqlite/boss-status-repository.js";
import {
  ProgressMessageIdRepository,
  SummaryMessageIdRepository,
} from "../repositories/sqlite/boss-message-id-repository.js";
import { ClanRepository } from "../repositories/sqlite/clan-repository.js";
import { runInTransaction, type SqliteDatabase } from "../repositories/sqlite/db.js";
import type { Logger } from "../shared/logger.js";
import { type Clock, systemClock } from "../shared/time.js";
import type { RuntimeStateService } from "./runtime-state-service.js";
import { createSummaryOverviewMessageIds } from "./summary-overview-tracking.js";

const DEFAULT_CATEGORY_NAME = "凸管理";
const SUMMARY_CHANNEL_NAME = "進行把握板";
const COMMAND_CHANNEL_NAME = "コマンド入力板";
const CHAT_CHANNEL_NAME = "クラバト雑談";
const REMAIN_ATTACK_CHANNEL_NAME = "残凸把握板";
const TL_CONVERSION_CHANNEL_NAME = "持越変換";
const TL_CONVERSION_CHANNEL_GUIDE = "/tlコマンドでTL変換できます。";
const BOSS_CHANNEL_NAMES = ["ボス1", "ボス2", "ボス3", "ボス4", "ボス5"] as const;
const SETUP_CREATION_FAILED_PREFIX = "チャンネルの作成に失敗しました";

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function formatSetupFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return `${SETUP_CREATION_FAILED_PREFIX}\n\`\`\`\n${error.message}\n\`\`\``;
  }

  return `${SETUP_CREATION_FAILED_PREFIX}\n\`\`\`\n${String(error)}\n\`\`\``;
}

export class SetupPermissionError extends Error {
  constructor(message = USER_MESSAGES.setup.missingPermission) {
    super(message);
    this.name = "SetupPermissionError";
  }
}

export class SetupHttpError extends Error {
  constructor(public readonly responseText: string) {
    super(responseText);
    this.name = "SetupHttpError";
  }
}

export interface SetupMessage {
  readonly id: string;
  addReaction(emoji: string): Promise<void>;
}

export interface SetupSendPayload {
  content?: string;
  embeds?: readonly EmbedBuilder[];
  components?: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

export interface SetupTextChannel {
  readonly id: string;
  readonly name: string;
  send(payload: SetupSendPayload): Promise<SetupMessage>;
  delete(): Promise<void>;
}

export interface SetupCategory {
  readonly id: string;
  readonly name: string;
  createTextChannel(name: string): Promise<SetupTextChannel>;
  delete(): Promise<void>;
}

export interface SetupGuild {
  readonly id: string;
  readonly name: string;
  createCategory(name: string): Promise<SetupCategory>;
}

export interface ClanSetupRequest {
  guild: SetupGuild;
  responseChannel: SetupTextChannel;
  categoryChannelName?: string;
}

export interface ClanSetupResult {
  clanData: ClanData;
  category: SetupCategory;
  summaryChannel: SetupTextChannel;
  commandChannel: SetupTextChannel;
  chatChannel: SetupTextChannel;
  bossChannels: readonly SetupTextChannel[];
  remainAttackChannel: SetupTextChannel;
  tlConversionChannel: SetupTextChannel;
}

export interface ClanSetupServiceOptions {
  database: SqliteDatabase;
  runtimeStateService: RuntimeStateService;
  clanRepository?: ClanRepository;
  bossStatusRepository?: BossStatusRepository;
  progressMessageIdRepository?: ProgressMessageIdRepository;
  summaryMessageIdRepository?: SummaryMessageIdRepository;
  clock?: Clock;
  logger?: Logger;
}

interface CreatedSetupResources {
  category: SetupCategory | null;
  channels: SetupTextChannel[];
}

function buildProgressEmbed(clanData: ClanData, bossIndex: number): EmbedBuilder {
  return renderProgressEmbed({
    clanData,
    lap: 1,
    bossIndex,
    displayNamesByUserId: new Map(),
  });
}

function buildRemainAttackEmbed(clanData: ClanData, clock: Clock): EmbedBuilder {
  return renderRemainAttackEmbed({
    clanData,
    displayNamesByUserId: new Map(),
    clock,
  });
}

function buildSummaryOverviewEmbed(clanData: ClanData): EmbedBuilder {
  return renderSummaryOverviewEmbed(clanData);
}

export class ClanSetupService {
  private readonly clanRepository: ClanRepository;
  private readonly bossStatusRepository: BossStatusRepository;
  private readonly progressMessageIdRepository: ProgressMessageIdRepository;
  private readonly summaryMessageIdRepository: SummaryMessageIdRepository;
  private readonly clock: Clock;
  private readonly logger: Logger;

  constructor(private readonly options: ClanSetupServiceOptions) {
    this.clanRepository = options.clanRepository ?? new ClanRepository(options.database);
    this.bossStatusRepository =
      options.bossStatusRepository ?? new BossStatusRepository(options.database);
    this.progressMessageIdRepository =
      options.progressMessageIdRepository ?? new ProgressMessageIdRepository(options.database);
    this.summaryMessageIdRepository =
      options.summaryMessageIdRepository ?? new SummaryMessageIdRepository(options.database);
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  async execute(request: ClanSetupRequest): Promise<ClanSetupResult | null> {
    await request.responseChannel.send({
      content: USER_MESSAGES.setup.started,
    });

    const categoryName = request.categoryChannelName || DEFAULT_CATEGORY_NAME;
    const createdResources: CreatedSetupResources = {
      category: null,
      channels: [],
    };

    let category: SetupCategory;
    let summaryChannel: SetupTextChannel;
    let commandChannel: SetupTextChannel;
    let chatChannel: SetupTextChannel;
    let remainAttackChannel: SetupTextChannel;
    let tlConversionChannel: SetupTextChannel;
    const bossChannels: SetupTextChannel[] = [];

    try {
      category = await request.guild.createCategory(categoryName);
      createdResources.category = category;

      chatChannel = await category.createTextChannel(CHAT_CHANNEL_NAME);
      createdResources.channels.push(chatChannel);

      for (const bossChannelName of BOSS_CHANNEL_NAMES) {
        const bossChannel = await category.createTextChannel(bossChannelName);
        bossChannels.push(bossChannel);
        createdResources.channels.push(bossChannel);
      }

      summaryChannel = await category.createTextChannel(SUMMARY_CHANNEL_NAME);
      createdResources.channels.push(summaryChannel);
      remainAttackChannel = await category.createTextChannel(REMAIN_ATTACK_CHANNEL_NAME);
      createdResources.channels.push(remainAttackChannel);
      commandChannel = await category.createTextChannel(COMMAND_CHANNEL_NAME);
      createdResources.channels.push(commandChannel);
      tlConversionChannel = await category.createTextChannel(TL_CONVERSION_CHANNEL_NAME);
      createdResources.channels.push(tlConversionChannel);

      const clanData = new ClanData({
        guildId: request.guild.id,
        categoryId: category.id,
        bossChannelIds: bossChannels.map((channel) => channel.id),
        remainAttackChannelId: remainAttackChannel.id,
        commandChannelId: commandChannel.id,
        summaryChannelId: summaryChannel.id,
        clock: this.clock,
      });

      clanData.progressMessageIdsByLap.set(1, [null, null, null, null, null]);
      clanData.initializeBossStatusData(1);

      for (let bossIndex = 0; bossIndex < bossChannels.length; bossIndex += 1) {
        const progressMessage = await bossChannels[bossIndex]!.send({
          embeds: [buildProgressEmbed(clanData, bossIndex)],
          components: createProgressActionComponents(),
        });
        clanData.progressMessageIdsByLap.get(1)![bossIndex] = progressMessage.id;
      }

      const summaryMessage = await summaryChannel.send({
        embeds: [buildSummaryOverviewEmbed(clanData)],
      });
      clanData.summaryMessageIdsByLap.set(1, createSummaryOverviewMessageIds(summaryMessage.id));

      const remainAttackMessage = await remainAttackChannel.send({
        embeds: [buildRemainAttackEmbed(clanData, this.clock)],
      });
      clanData.remainAttackMessageId = remainAttackMessage.id;
      await remainAttackMessage.addReaction(EMOJIS.taskKill);

      await tlConversionChannel.send({
        content: TL_CONVERSION_CHANNEL_GUIDE,
      });

      runInTransaction(this.options.database, () => {
        this.clanRepository.insert(clanData);
        this.progressMessageIdRepository.insert(
          clanData.categoryId,
          1,
          clanData.progressMessageIdsByLap.get(1)!,
        );
        this.bossStatusRepository.insertAllForLap(clanData.categoryId, clanData.bossStatusByLap.get(1)!);
        this.summaryMessageIdRepository.insert(
          clanData.categoryId,
          1,
          clanData.summaryMessageIdsByLap.get(1)!,
        );
      });

      this.options.runtimeStateService.set(clanData);

      await request.responseChannel.send({
        content: USER_MESSAGES.setup.completed,
      });

      return {
        clanData,
        category,
        summaryChannel,
        commandChannel,
        chatChannel,
        bossChannels,
        remainAttackChannel,
        tlConversionChannel,
      };
    } catch (error) {
      await this.rollbackCreatedResources(createdResources);

      if (error instanceof SetupPermissionError) {
        await request.responseChannel.send({
          content: USER_MESSAGES.setup.missingPermission,
        });
        return null;
      }

      if (error instanceof SetupHttpError) {
        await request.responseChannel.send({
          content: `${SETUP_CREATION_FAILED_PREFIX}\n\`\`\`\n${error.responseText}\n\`\`\``,
        });
        return null;
      }

      await request.responseChannel.send({
        content: formatSetupFailureMessage(error),
      });
      return null;
    }
  }

  private async rollbackCreatedResources(resources: CreatedSetupResources): Promise<void> {
    for (const channel of [...resources.channels].reverse()) {
      try {
        await channel.delete();
      } catch (error) {
        this.logger.warn("Failed to delete setup channel during rollback", {
          channelId: channel.id,
          channelName: channel.name,
          error,
        });
      }
    }

    if (!resources.category) {
      return;
    }

    try {
      await resources.category.delete();
    } catch (error) {
      this.logger.warn("Failed to delete setup category during rollback", {
        categoryId: resources.category.id,
        categoryName: resources.category.name,
        error,
      });
    }
  }
}
