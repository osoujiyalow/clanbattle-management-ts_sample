import { ATTACK_TYPE_INPUTS } from "../../src/domain/attack-type.js";
import { ClanBattleData } from "../../src/domain/clan-battle-data.js";
import { ClanData } from "../../src/domain/clan-data.js";
import { PlayerData } from "../../src/domain/player-data.js";
import { GuildBossInfoRepository } from "../../src/repositories/sqlite/guild-bossinfo-repository.js";
import { BossStatusRepository } from "../../src/repositories/sqlite/boss-status-repository.js";
import {
  ProgressMessageIdRepository,
  SummaryMessageIdRepository,
} from "../../src/repositories/sqlite/boss-message-id-repository.js";
import { CarryOverRepository } from "../../src/repositories/sqlite/carry-over-repository.js";
import { PlayerRepository } from "../../src/repositories/sqlite/player-repository.js";
import { ClanSetupService, type SetupCategory, type SetupGuild } from "../../src/services/clan-setup-service.js";
import { MemberService } from "../../src/services/member-service.js";
import { AttackService } from "../../src/services/attack-service.js";
import { BossInfoService } from "../../src/services/bossinfo-service.js";
import { RuntimeStateService } from "../../src/services/runtime-state-service.js";
import { createFixedClock } from "../../src/shared/time.js";
import {
  FakeDiscordGateway,
  FakeResponseChannel,
  FakeServiceMessage,
  FakeServiceTextChannel,
  createSnowflakeFactory,
} from "../helpers/fake-discord/service-gateway.js";
import { withIntegrationSqliteHarness, type IntegrationSqliteHarness } from "../helpers/temp-db/integration-sqlite.js";

// Keep parity scenarios after the JST 05:00 reset boundary.
const FIXED_CLOCK = createFixedClock("2026-03-08T06:00:00+09:00");
const ACTOR = {
  id: "333333333333333333",
  displayName: "Alice",
} as const;

type EmbedLikeJson = {
  title?: string;
  description?: string;
  footer?: {
    text?: string;
  };
  fields?: Array<{
    name?: string;
    value?: string;
  }>;
};

type JsonRecord = Record<string, unknown>;

export interface ParityScenarioResult {
  id: string;
  visibility: "public" | "ephemeral" | "none";
  touchedTables: readonly string[];
  actual: {
    ui: JsonRecord;
    db: JsonRecord;
  };
}

interface BattleScenarioContext {
  readonly database: IntegrationSqliteHarness["database"];
  readonly runtimeStateService: RuntimeStateService;
  readonly clanData: ClanData;
  readonly gateway: FakeDiscordGateway;
  readonly bossChannels: readonly FakeServiceTextChannel[];
  readonly summaryChannel: FakeServiceTextChannel;
  readonly remainAttackChannel: FakeServiceTextChannel;
  readonly memberService: MemberService;
  readonly attackService: AttackService;
}

class ParityTextChannel extends FakeServiceTextChannel {}

class ParityCategory implements SetupCategory {
  readonly channels: ParityTextChannel[] = [];

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly idFactory: () => string,
    private readonly gateway: FakeDiscordGateway,
  ) {}

  async createTextChannel(name: string): Promise<ParityTextChannel> {
    const channel = new ParityTextChannel(this.idFactory(), this.idFactory);
    Object.defineProperty(channel, "name", {
      value: name,
      enumerable: true,
      configurable: true,
    });
    this.channels.push(channel);
    this.gateway.registerChannel(channel);
    return channel;
  }
}

class ParityGuild implements SetupGuild {
  readonly createdCategories: ParityCategory[] = [];

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly idFactory: () => string,
    private readonly gateway: FakeDiscordGateway,
  ) {}

  async createCategory(name: string): Promise<ParityCategory> {
    const category = new ParityCategory(this.idFactory(), name, this.idFactory, this.gateway);
    this.createdCategories.push(category);
    return category;
  }
}

function assertPresent<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Missing required value: ${label}`);
  }

  return value;
}

function createBattleScenarioContext(harness: IntegrationSqliteHarness): BattleScenarioContext {
  const runtimeStateService = new RuntimeStateService({ database: harness.database });
  const clanData = new ClanData({
    guildId: "123456789012345678",
    categoryId: "223456789012345678",
    bossChannelIds: [
      "323456789012345678",
      "423456789012345678",
      "523456789012345678",
      "623456789012345678",
      "723456789012345678",
    ],
    remainAttackChannelId: "823456789012345678",
    commandChannelId: "923456789012345678",
    summaryChannelId: "103456789012345678",
    remainAttackMessageId: "113456789012345678",
    progressMessageIdsByLap: new Map([[1, ["111", "112", "113", "114", "115"]]]),
    summaryMessageIdsByLap: new Map([[1, ["211", null, null, null, null]]]),
    date: "2026-03-08",
  });
  clanData.initializeBossStatusData(1);

  new BossStatusRepository(harness.database).insertAllForLap(
    clanData.categoryId,
    assertPresent(clanData.bossStatusByLap.get(1), "lap 1 boss status"),
  );
  new ProgressMessageIdRepository(harness.database).insert(
    clanData.categoryId,
    1,
    assertPresent(clanData.progressMessageIdsByLap.get(1), "lap 1 progress ids"),
  );
  new SummaryMessageIdRepository(harness.database).insert(
    clanData.categoryId,
    1,
    assertPresent(clanData.summaryMessageIdsByLap.get(1), "lap 1 summary ids"),
  );

  runtimeStateService.set(clanData);

  const idFactory = createSnowflakeFactory(700000000000000000n);
  const gateway = new FakeDiscordGateway();
  const bossChannels = clanData.bossChannelIds.map((channelId, bossIndex) => {
    const channel = new FakeServiceTextChannel(channelId, idFactory);
    channel.attachMessage(
      new FakeServiceMessage(
        assertPresent(clanData.progressMessageIdsByLap.get(1)?.[bossIndex], `progress ${bossIndex}`),
      ),
    );
    gateway.registerChannel(channel);
    return channel;
  });

  const summaryChannel = new FakeServiceTextChannel(clanData.summaryChannelId, idFactory);
  for (const messageId of assertPresent(clanData.summaryMessageIdsByLap.get(1), "summary ids")) {
    if (!messageId) {
      continue;
    }

    summaryChannel.attachMessage(new FakeServiceMessage(messageId));
  }
  gateway.registerChannel(summaryChannel);

  const remainAttackChannel = new FakeServiceTextChannel(clanData.remainAttackChannelId, idFactory);
  remainAttackChannel.attachMessage(
    new FakeServiceMessage(assertPresent(clanData.remainAttackMessageId, "remain attack message id")),
  );
  gateway.registerChannel(remainAttackChannel);

  return {
    database: harness.database,
    runtimeStateService,
    clanData,
    gateway,
    bossChannels,
    summaryChannel,
    remainAttackChannel,
    memberService: new MemberService({
      database: harness.database,
      runtimeStateService,
      clock: FIXED_CLOCK,
    }),
    attackService: new AttackService({
      database: harness.database,
      runtimeStateService,
      clock: FIXED_CLOCK,
      redrawRetryDelayMs: 0,
    }),
  };
}

function seedPlayer(
  database: IntegrationSqliteHarness["database"],
  clanData: ClanData,
  playerData: PlayerData,
): void {
  clanData.addPlayerData(playerData);
  new PlayerRepository(database).insertMany(clanData.categoryId, [playerData]);
  new PlayerRepository(database).update(clanData.categoryId, playerData);
  new CarryOverRepository(database).replaceAll(
    clanData.categoryId,
    playerData.userId,
    playerData.carryOverList,
  );
}

function extractEmbed(message: FakeServiceMessage, mode: "payload" | "last-edit" = "last-edit"): EmbedLikeJson {
  const candidate =
    mode === "payload"
      ? message.payload.embeds?.[0]
      : message.edits.at(-1)?.embeds?.[0] ?? message.payload.embeds?.[0];

  return assertPresent(candidate as EmbedLikeJson | undefined, `${mode} embed`);
}

function extractRemainSummary(embed: EmbedLikeJson): string {
  return embed.description ?? "";
}

function responseContents(channel: FakeResponseChannel): string[] {
  return channel.sentPayloads
    .map((payload) => payload.content)
    .filter((content): content is string => typeof content === "string");
}

function setupResponseContents(channel: FakeServiceTextChannel): string[] {
  return channel.sentPayloads
    .map((payload) => payload.content)
    .filter((content): content is string => typeof content === "string");
}

function extractButtonTexts(message: FakeServiceMessage, mode: "payload" | "last-edit" = "payload"): string[] {
  const candidate =
    mode === "payload"
      ? message.payload.components
      : message.edits.at(-1)?.components ?? message.payload.components;

  const rows = (candidate ?? []) as Array<{
    components?: Array<{
      label?: string;
      emoji?: {
        name?: string;
      };
    }>;
  }>;

  return rows.flatMap((row) =>
    (row.components ?? []).map((component) => {
      const emoji = typeof component.emoji?.name === "string" ? `${component.emoji.name} ` : "";
      return `${emoji}${component.label ?? ""}`.trim();
    }),
  );
}

function countRows(
  database: IntegrationSqliteHarness["database"],
  tableName: string,
): number {
  const row = database.prepare<[], { count: bigint }>(`select count(*) as count from ${tableName}`).get();
  return Number(assertPresent(row, `${tableName} count`).count);
}

async function runSetupScenario(): Promise<ParityScenarioResult> {
  return withIntegrationSqliteHarness(async (harness) => {
    const runtimeStateService = new RuntimeStateService({ database: harness.database });
    const gateway = new FakeDiscordGateway();
    const idFactory = createSnowflakeFactory(1000000000000000000n);
    const guild = new ParityGuild("123456789012345678", "Test Guild", idFactory, gateway);
    const responseChannel = new ParityTextChannel(idFactory(), idFactory);
    const service = new ClanSetupService({
      database: harness.database,
      runtimeStateService,
      clock: FIXED_CLOCK,
    });

    const result = await service.execute({
      guild,
      responseChannel,
    });

    const category = assertPresent(result?.category, "setup category");
    const boss1Channel = assertPresent(category.channels[1], "boss1 channel");
    const remainAttackChannel = assertPresent(category.channels[7], "remain attack channel");
    const boss1Message = assertPresent(boss1Channel.sentMessages[0], "boss1 progress message");
    const remainAttackMessage = assertPresent(
      remainAttackChannel.sentMessages[0],
      "remain attack message",
    );
    const boss1Embed = extractEmbed(boss1Message, "payload");
    const remainEmbed = extractEmbed(remainAttackMessage, "payload");

    return {
      id: "setup/basic",
      visibility: "public",
      touchedTables: [
        "ClanData",
        "BossStatusData",
        "ProgressMessageIdData",
        "SummaryMessageIdData",
      ],
      actual: {
        ui: {
          messageSequence: setupResponseContents(responseChannel),
          createdCategoryName: category.name,
          createdTextChannelsInOrder: category.channels.map((channel) => channel.name),
          progressMessageReactions: boss1Message.reactions,
          progressMessageButtons: extractButtonTexts(boss1Message),
          remainAttackMessageReactions: remainAttackMessage.reactions,
          boss1EmbedTitle: boss1Embed.title ?? "",
          remainSummary: extractRemainSummary(remainEmbed),
        },
        db: {
          clanCount: countRows(harness.database, "ClanData"),
          bossStatusCount: countRows(harness.database, "BossStatusData"),
          progressCount: countRows(harness.database, "ProgressMessageIdData"),
          summaryCount: countRows(harness.database, "SummaryMessageIdData"),
        },
      },
    };
  });
}

async function runAddMemberSelfScenario(): Promise<ParityScenarioResult> {
  return withIntegrationSqliteHarness(async (harness) => {
    const context = createBattleScenarioContext(harness);
    const responseChannel = new FakeResponseChannel();

    await context.memberService.add({
      categoryId: context.clanData.categoryId,
      actor: ACTOR,
      responseChannel,
      discordGateway: context.gateway,
    });

    const remainAttackMessage = assertPresent(
      context.remainAttackChannel.messages.get(assertPresent(context.clanData.remainAttackMessageId, "remain id")),
      "remain attack message",
    );
    const remainEmbed = extractEmbed(remainAttackMessage);
    const playerRows = context.database
      .prepare<[], { user_id: bigint }>("select user_id from PlayerData order by user_id")
      .all();

    return {
      id: "add/member-self",
      visibility: "public",
      touchedTables: ["PlayerData"],
      actual: {
        ui: {
          messageSequence: responseContents(responseChannel),
          remainSummary: extractRemainSummary(remainEmbed),
        },
        db: {
          playerCount: playerRows.length,
          userIds: playerRows.map((row) => row.user_id.toString()),
        },
      },
    };
  });
}

async function runAttackDeclareScenario(): Promise<ParityScenarioResult> {
  return withIntegrationSqliteHarness(async (harness) => {
    const context = createBattleScenarioContext(harness);
    seedPlayer(context.database, context.clanData, new PlayerData({ userId: ACTOR.id }));
    const responseChannel = new FakeResponseChannel();

    await context.attackService.declare({
      categoryId: context.clanData.categoryId,
      channelId: context.clanData.bossChannelIds[0]!,
      member: ACTOR,
      attackType: ATTACK_TYPE_INPUTS.BATTLE,
      responseChannel,
      discordGateway: context.gateway,
      displayNamesByUserId: new Map([[ACTOR.id, ACTOR.displayName]]),
    });

    const progressMessage = assertPresent(context.bossChannels[0]?.messages.get("111"), "progress message");
    const progressEmbed = extractEmbed(progressMessage);
    const attackRows = context.database
      .prepare<
        [],
        {
          lap: bigint;
          boss_index: bigint;
          attacked: bigint;
          attack_type: string;
          carry_over: bigint;
        }
      >(
        "select lap, boss_index, attacked, attack_type, carry_over from AttackStatus order by created",
      )
      .all()
      .map((row) => ({
        lap: Number(row.lap),
        boss_index: Number(row.boss_index),
        attacked: Number(row.attacked),
        attack_type: row.attack_type,
        carry_over: Number(row.carry_over),
      }));

    return {
      id: "attack_declare/basic",
      visibility: "public",
      touchedTables: ["AttackStatus", "AttackEntry", "OperationLog", "PlayerResourceState"],
      actual: {
        ui: {
          messageSequence: responseContents(responseChannel),
          progressTitle: progressEmbed.title ?? "",
          progressDescription: progressEmbed.description ?? "",
        },
        db: {
          attackRows,
        },
      },
    };
  });
}

async function runMessageDamageScenario(): Promise<ParityScenarioResult> {
  return withIntegrationSqliteHarness(async (harness) => {
    const context = createBattleScenarioContext(harness);
    seedPlayer(context.database, context.clanData, new PlayerData({ userId: ACTOR.id }));
    await context.attackService.declare({
      categoryId: context.clanData.categoryId,
      channelId: context.clanData.bossChannelIds[0]!,
      member: ACTOR,
      attackType: ATTACK_TYPE_INPUTS.BATTLE,
      responseChannel: new FakeResponseChannel(),
      discordGateway: context.gateway,
      displayNamesByUserId: new Map([[ACTOR.id, ACTOR.displayName]]),
    });

    await context.attackService.applyMessageDamage({
      categoryId: context.clanData.categoryId,
      channelId: context.clanData.bossChannelIds[0]!,
      member: ACTOR,
      messageContent: "600 60s",
      discordGateway: context.gateway,
      displayNamesByUserId: new Map([[ACTOR.id, ACTOR.displayName]]),
    });

    const progressMessage = assertPresent(context.bossChannels[0]?.messages.get("111"), "progress message");
    const progressEmbed = extractEmbed(progressMessage);
    const attackRow = assertPresent(
      context.database
        .prepare<[], { damage: bigint; memo: string; attacked: bigint }>(
          "select damage, memo, attacked from AttackStatus limit 1",
        )
        .get(),
      "message damage row",
    );

    return {
      id: "message_damage/basic",
      visibility: "none",
      touchedTables: ["AttackStatus", "AttackEntry", "PlayerResourceState"],
      actual: {
        ui: {
          progressDescription: progressEmbed.description ?? "",
        },
        db: {
          damage: Number(attackRow.damage),
          memo: attackRow.memo,
          attacked: Number(attackRow.attacked),
        },
      },
    };
  });
}

async function runAttackFinishScenario(): Promise<ParityScenarioResult> {
  return withIntegrationSqliteHarness(async (harness) => {
    const context = createBattleScenarioContext(harness);
    const playerData = new PlayerData({
      userId: ACTOR.id,
      physicsAttack: 1,
    });
    seedPlayer(context.database, context.clanData, playerData);

    await context.attackService.declare({
      categoryId: context.clanData.categoryId,
      channelId: context.clanData.bossChannelIds[0]!,
      member: ACTOR,
      attackType: ATTACK_TYPE_INPUTS.BATTLE,
      responseChannel: new FakeResponseChannel(),
      discordGateway: context.gateway,
      displayNamesByUserId: new Map([[ACTOR.id, ACTOR.displayName]]),
    });

    const responseChannel = new FakeResponseChannel();
    await context.attackService.finish({
      categoryId: context.clanData.categoryId,
      channelId: context.clanData.bossChannelIds[0]!,
      member: ACTOR,
      damage: 234567,
      responseChannel,
      discordGateway: context.gateway,
      displayNamesByUserId: new Map([[ACTOR.id, ACTOR.displayName]]),
    });

    const progressEmbed = extractEmbed(
      assertPresent(context.bossChannels[0]?.messages.get("111"), "progress message"),
    );
    const remainEmbed = extractEmbed(
      assertPresent(
        context.remainAttackChannel.messages.get(assertPresent(context.clanData.remainAttackMessageId, "remain id")),
        "remain attack message",
      ),
    );
    const attackRow = assertPresent(
      context.database
        .prepare<[], { attacked: bigint; damage: bigint }>(
          "select attacked, damage from AttackStatus limit 1",
        )
        .get(),
      "finish attack row",
    );
    const playerRow = assertPresent(
      context.database
        .prepare<[], { physics_attack: bigint; magic_attack: bigint }>(
          "select physics_attack, magic_attack from PlayerData where user_id=?",
        )
        .get(BigInt(ACTOR.id)),
      "finish player row",
    );

    return {
      id: "attack_fin/basic",
      visibility: "public",
      touchedTables: [
        "AttackStatus",
        "PlayerData",
        "AttackEntry",
        "OperationLog",
        "PlayerResourceState",
      ],
      actual: {
        ui: {
          messageSequence: responseContents(responseChannel),
          progressDescription: progressEmbed.description ?? "",
          remainSummary: extractRemainSummary(remainEmbed),
        },
        db: {
          attackRow: {
            attacked: Number(attackRow.attacked),
            damage: Number(attackRow.damage),
          },
          playerRow: {
            physics_attack: Number(playerRow.physics_attack),
            magic_attack: Number(playerRow.magic_attack),
          },
        },
      },
    };
  });
}

async function runDefeatBossScenario(): Promise<ParityScenarioResult> {
  return withIntegrationSqliteHarness(async (harness) => {
    const context = createBattleScenarioContext(harness);
    const playerData = new PlayerData({
      userId: ACTOR.id,
      physicsAttack: 2,
    });
    seedPlayer(context.database, context.clanData, playerData);

    await context.attackService.declare({
      categoryId: context.clanData.categoryId,
      channelId: context.clanData.bossChannelIds[0]!,
      member: ACTOR,
      attackType: ATTACK_TYPE_INPUTS.BATTLE,
      responseChannel: new FakeResponseChannel(),
      discordGateway: context.gateway,
      displayNamesByUserId: new Map([[ACTOR.id, ACTOR.displayName]]),
    });

    const responseChannel = new FakeResponseChannel();
    await context.attackService.defeatBoss({
      categoryId: context.clanData.categoryId,
      channelId: context.clanData.bossChannelIds[0]!,
      member: ACTOR,
      responseChannel,
      discordGateway: context.gateway,
      displayNamesByUserId: new Map([[ACTOR.id, ACTOR.displayName]]),
    });

    return {
      id: "defeat_boss/basic",
      visibility: "public",
      touchedTables: [
        "AttackStatus",
        "BossStatusData",
        "CarryOver",
        "PlayerData",
        "AttackEntry",
        "OperationLog",
        "PlayerResourceState",
        "ProgressMessageIdData",
        "SummaryMessageIdData",
      ],
      actual: {
        ui: {
          messageSequence: responseContents(responseChannel),
          nextLapProgressCreated: context.bossChannels[0]?.sentMessages.length ?? 0,
          nextLapSummaryCreated: context.summaryChannel.sentMessages.length,
        },
        db: {
          bossStatusCount: countRows(context.database, "BossStatusData"),
          progressCount: countRows(context.database, "ProgressMessageIdData"),
          summaryCount: countRows(context.database, "SummaryMessageIdData"),
          carryOverCount: countRows(context.database, "CarryOver"),
          beated: context.clanData.bossStatusByLap.get(1)?.[0]?.beated ? 1 : 0,
        },
      },
    };
  });
}

async function runUndoScenario(): Promise<ParityScenarioResult> {
  return withIntegrationSqliteHarness(async (harness) => {
    const context = createBattleScenarioContext(harness);
    const playerData = new PlayerData({
      userId: ACTOR.id,
      physicsAttack: 1,
    });
    seedPlayer(context.database, context.clanData, playerData);

    await context.attackService.declare({
      categoryId: context.clanData.categoryId,
      channelId: context.clanData.bossChannelIds[0]!,
      member: ACTOR,
      attackType: ATTACK_TYPE_INPUTS.BATTLE,
      responseChannel: new FakeResponseChannel(),
      discordGateway: context.gateway,
      displayNamesByUserId: new Map([[ACTOR.id, ACTOR.displayName]]),
    });
    await context.attackService.finish({
      categoryId: context.clanData.categoryId,
      channelId: context.clanData.bossChannelIds[0]!,
      member: ACTOR,
      damage: 234567,
      responseChannel: new FakeResponseChannel(),
      discordGateway: context.gateway,
      displayNamesByUserId: new Map([[ACTOR.id, ACTOR.displayName]]),
    });

    const responseChannel = new FakeResponseChannel();
    await context.attackService.undo({
      categoryId: context.clanData.categoryId,
      channelId: context.clanData.bossChannelIds[0]!,
      bossNumber: 1,
      member: ACTOR,
      responseChannel,
      discordGateway: context.gateway,
      displayNamesByUserId: new Map([[ACTOR.id, ACTOR.displayName]]),
    });

    const progressEmbed = extractEmbed(
      assertPresent(context.bossChannels[0]?.messages.get("111"), "undo progress message"),
    );
    const remainEmbed = extractEmbed(
      assertPresent(
        context.remainAttackChannel.messages.get(assertPresent(context.clanData.remainAttackMessageId, "remain id")),
        "undo remain message",
      ),
    );
    const attackRow = assertPresent(
      context.database
        .prepare<[], { attacked: bigint; damage: bigint }>(
          "select attacked, damage from AttackStatus limit 1",
        )
        .get(),
      "undo attack row",
    );
    const playerRow = assertPresent(
      context.database
        .prepare<[], { physics_attack: bigint; magic_attack: bigint }>(
          "select physics_attack, magic_attack from PlayerData where user_id=?",
        )
        .get(BigInt(ACTOR.id)),
      "undo player row",
    );

    return {
      id: "undo/basic",
      visibility: "public",
      touchedTables: [
        "AttackStatus",
        "PlayerData",
        "AttackEntry",
        "OperationLog",
        "PlayerResourceState",
      ],
      actual: {
        ui: {
          messageSequence: responseContents(responseChannel),
          progressDescription: progressEmbed.description ?? "",
          remainSummary: extractRemainSummary(remainEmbed),
        },
        db: {
          attackRow: {
            attacked: Number(attackRow.attacked),
            damage: Number(attackRow.damage),
          },
          playerRow: {
            physics_attack: Number(playerRow.physics_attack),
            magic_attack: Number(playerRow.magic_attack),
          },
        },
      },
    };
  });
}

async function runBossInfoEditScenario(): Promise<ParityScenarioResult> {
  return withIntegrationSqliteHarness(async (harness) => {
    ClanBattleData.loadGuildConfigMap(new Map());

    const runtimeStateService = new RuntimeStateService({ database: harness.database });
    runtimeStateService.set(
      new ClanData({
        guildId: "123456789012345678",
        categoryId: "223456789012345678",
        bossChannelIds: ["323", "423", "523", "623", "723"],
        remainAttackChannelId: "823",
        commandChannelId: "923",
        summaryChannelId: "10323",
        date: "2026-03-08",
      }),
    );

    const repository = new GuildBossInfoRepository(harness.database);
    const service = new BossInfoService({
      runtimeStateService,
      guildBossInfoRepository: repository,
      clock: FIXED_CLOCK,
    });

    const requestBase = {
      guildId: "123456789012345678",
      userId: "111111111111111111",
      hasManageGuildPermission: true,
    } as const;

    const start = service.startEdit(requestBase);
    const phaseModal = service.openPhaseCountModal(requestBase);
    const afterPhaseCount = service.submitPhaseCount({
      ...requestBase,
      rawValue: "1",
    });
    const boundaryModal = service.openBoundaryModal(requestBase);
    const boundaryRange = service.getCurrentBoundaryRange(requestBase);
    if ("kind" in boundaryRange) {
      throw new Error("Unexpected boundary range error");
    }

    const afterBoundaries = service.submitBoundaries({
      ...requestBase,
      values: ["1 -1"],
      startIndex: boundaryRange.startIndex,
      endIndex: boundaryRange.endIndex,
    });

    const hpModal = service.openHpModal(requestBase);
    const hpContext = service.getCurrentHpContext(requestBase);
    if ("kind" in hpContext) {
      throw new Error("Unexpected hp context error");
    }

    let wizardStep = service.submitHp({
      ...requestBase,
      values: ["5600"],
      bossIndex: hpContext.bossIndex,
      startIndex: hpContext.startIndex,
      endIndex: hpContext.endIndex,
    });

    for (let remainingBosses = 0; remainingBosses < 4; remainingBosses += 1) {
      const nextContext = service.getCurrentHpContext(requestBase);
      if ("kind" in nextContext) {
        throw new Error("Unexpected follow-up hp context error");
      }

      wizardStep = service.submitHp({
        ...requestBase,
        values: [""],
        bossIndex: nextContext.bossIndex,
        startIndex: nextContext.startIndex,
        endIndex: nextContext.endIndex,
      });
    }

    const saved = service.save(requestBase);
    const configMap = repository.loadAll();
    const savedConfig = assertPresent(
      configMap.get(requestBase.guildId),
      "saved bossinfo config",
    );

    ClanBattleData.loadGuildConfigMap(new Map());

    return {
      id: "bossinfo_edit/basic",
      visibility: "ephemeral",
      touchedTables: ["GuildBossInfoConfig"],
      actual: {
        ui: {
          messageSequence: [
            start.content,
            afterPhaseCount.content,
            afterBoundaries.content,
            wizardStep.content,
            saved.content,
          ],
          components: [
            phaseModal.kind,
            boundaryModal.kind,
            hpModal.kind,
            wizardStep.kind === "message" && wizardStep.view?.kind === "confirm" ? "confirm" : wizardStep.kind,
          ],
          modalTitles: [
            phaseModal.kind === "modal" ? phaseModal.title : "",
            boundaryModal.kind === "modal" ? boundaryModal.title : "",
            hpModal.kind === "modal" ? hpModal.title : "",
          ],
        },
        db: {
          guildBossInfoCount: configMap.size,
          boundaries: savedConfig.boundaries,
          hp: savedConfig.hp,
        },
      },
    };
  });
}

export async function runParityScenarios(): Promise<ParityScenarioResult[]> {
  return [
    await runSetupScenario(),
    await runAddMemberSelfScenario(),
    await runAttackDeclareScenario(),
    await runMessageDamageScenario(),
    await runAttackFinishScenario(),
    await runDefeatBossScenario(),
    await runUndoScenario(),
    await runBossInfoEditScenario(),
  ];
}
