import { afterEach, describe, expect, it } from "vitest";

import {
  AttackEntry,
  AttackEntryKind,
  AttackEntryStatus,
} from "../../../../src/domain/attack-entry.js";
import { AttackStatus } from "../../../../src/domain/attack-status.js";
import { ATTACK_TYPE_INPUTS, AttackType } from "../../../../src/domain/attack-type.js";
import { ClanData } from "../../../../src/domain/clan-data.js";
import { OperationLog, OperationLogType } from "../../../../src/domain/operation-log.js";
import { OperationType } from "../../../../src/domain/operation-type.js";
import { CarryOver, PlayerData } from "../../../../src/domain/player-data.js";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
  type SqliteDatabase,
} from "../../../../src/repositories/sqlite/db.js";
import { AttackEntryRepository } from "../../../../src/repositories/sqlite/attack-entry-repository.js";
import { AttackStatusRepository } from "../../../../src/repositories/sqlite/attack-status-repository.js";
import {
  ProgressMessageIdRepository,
  SummaryMessageIdRepository,
} from "../../../../src/repositories/sqlite/boss-message-id-repository.js";
import { BossStatusRepository } from "../../../../src/repositories/sqlite/boss-status-repository.js";
import { ClanRepository } from "../../../../src/repositories/sqlite/clan-repository.js";
import { CarryOverRepository } from "../../../../src/repositories/sqlite/carry-over-repository.js";
import { OperationLogRepository } from "../../../../src/repositories/sqlite/operation-log-repository.js";
import { PlayerRepository } from "../../../../src/repositories/sqlite/player-repository.js";
import {
  AttackService,
  type AttackDeclareResponseChannel,
  type AttackDiscordGateway,
  type AttackEditableMessage,
  type AttackTextChannel,
} from "../../../../src/services/attack-service.js";
import {
  ProgressMessageService,
  type ProgressMessageDiscordGateway,
  type ProgressMessageEditableMessage,
  type ProgressMessageResponseChannel,
  type ProgressMessageTextChannel,
} from "../../../../src/services/progress-message-service.js";
import { UNDO_NOTHING_MESSAGE } from "../../../../src/services/attack-service-support.js";
import { RuntimeStateService } from "../../../../src/services/runtime-state-service.js";
import { createFixedClock } from "../../../../src/shared/time.js";
import { createCoreRepositorySchema } from "../../../unit/repositories/sqlite/core-repository-schema.js";
import { createTempSqlitePath, type TempSqlitePath } from "../../../unit/repositories/sqlite/test-sqlite-path.js";

class FakeMessage implements AttackEditableMessage, ProgressMessageEditableMessage {
  readonly edits: Array<{ embeds?: unknown[]; components?: unknown[] }> = [];
  readonly reactions: string[] = [];
  deleted = false;
  private owner: FakeTextChannel | null = null;

  constructor(readonly id: string) {}

  bind(owner: FakeTextChannel): this {
    this.owner = owner;
    return this;
  }

  async edit(payload: {
    embeds?: readonly { toJSON(): unknown }[];
    components?: readonly { toJSON(): unknown }[];
  }): Promise<void> {
    this.edits.push({
      embeds: payload.embeds?.map((embed) => embed.toJSON()),
      components: payload.components?.map((component) => component.toJSON()),
    });
  }

  async addReaction(emoji: string): Promise<void> {
    this.reactions.push(emoji);
  }

  async delete(): Promise<void> {
    this.deleted = true;
    this.owner?.messages.delete(this.id);
  }
}

class FakeTextChannel
  implements
    AttackTextChannel,
    AttackDeclareResponseChannel,
    ProgressMessageTextChannel,
    ProgressMessageResponseChannel
{
  readonly sentPayloads: Array<{ content?: string }> = [];
  readonly sentMessages: FakeMessage[] = [];
  readonly messages = new Map<string, FakeMessage>();

  constructor(readonly id: string, private readonly nextId: () => string = (() => `${id}-1`)) {}

  async send(payload: { content?: string }): Promise<void> {
    this.sentPayloads.push(payload);
  }

  async sendMessage(payload: {
    content?: string;
    embeds?: readonly { toJSON(): unknown }[];
    components?: readonly { toJSON(): unknown }[];
  }): Promise<FakeMessage> {
    const message = new FakeMessage(this.nextId()).bind(this);
    this.messages.set(message.id, message);
    this.sentMessages.push(message);

    if (payload.embeds) {
      await message.edit(payload);
    } else if (payload.components) {
      await message.edit(payload);
    }

    return message;
  }

  async fetchMessage(messageId: string): Promise<FakeMessage> {
    const message = this.messages.get(messageId);
    if (!message) {
      throw new Error(`Unknown message id: ${messageId}`);
    }

    return message;
  }

  attachMessage(message: FakeMessage): void {
    this.messages.set(message.id, message.bind(this));
  }
}

class FakeDiscordGateway implements AttackDiscordGateway, ProgressMessageDiscordGateway {
  private readonly channels = new Map<string, FakeTextChannel>();

  registerChannel(channel: FakeTextChannel): void {
    this.channels.set(channel.id, channel);
  }

  async getTextChannel(channelId: string): Promise<FakeTextChannel> {
    const channel = this.channels.get(channelId);
    if (!channel) {
      throw new Error(`Unknown channel id: ${channelId}`);
    }

    return channel;
  }
}

function createSnowflakeFactory(start = 800000000000000000n): () => string {
  let current = start;
  return () => (current++).toString();
}

function createClanData(): ClanData {
  const clanData = new ClanData({
    guildId: "123456789012345678",
    categoryId: "223456789012345678",
    bossChannelIds: ["323", "423", "523", "623", "723"],
    remainAttackChannelId: "823",
    commandChannelId: "923",
    summaryChannelId: "10323",
    remainAttackMessageId: "311",
    progressMessageIdsByLap: new Map([[1, ["111", "112", "113", "114", "115"]]]),
    summaryMessageIdsByLap: new Map([[1, ["211", null, null, null, null]]]),
    date: "2026-03-08",
  });
  clanData.initializeBossStatusData(1);
  return clanData;
}

function seedLapState(database: SqliteDatabase, clanData: ClanData, lap: number): void {
  const bossStatusList = clanData.bossStatusByLap.get(lap);
  if (bossStatusList) {
    new BossStatusRepository(database).insertAllForLap(clanData.categoryId, bossStatusList);
  }

  const progressMessageIds = clanData.progressMessageIdsByLap.get(lap);
  if (progressMessageIds) {
    new ProgressMessageIdRepository(database).insert(clanData.categoryId, lap, progressMessageIds);
  }

  const summaryMessageIds = clanData.summaryMessageIdsByLap.get(lap);
  if (summaryMessageIds) {
    new SummaryMessageIdRepository(database).insert(clanData.categoryId, lap, summaryMessageIds);
  }
}

function seedLapOneState(database: SqliteDatabase, clanData: ClanData): void {
  seedLapState(database, clanData, 1);
}

function seedPlayer(database: SqliteDatabase, clanData: ClanData, playerData: PlayerData): void {
  clanData.addPlayerData(playerData);
  const playerRepository = new PlayerRepository(database);
  const carryOverRepository = new CarryOverRepository(database);

  playerRepository.insertMany(clanData.categoryId, [playerData]);
  playerRepository.update(clanData.categoryId, playerData);
  carryOverRepository.replaceAll(clanData.categoryId, playerData.userId, playerData.carryOverList);
}

function seedAttackStatus(
  database: SqliteDatabase,
  clanData: ClanData,
  playerData: PlayerData,
  options: {
    lap?: number;
    bossIndex?: number;
    attacked: boolean;
    attackType: AttackType;
    damage?: number;
    created?: string;
  },
): AttackStatus {
  const attackStatus = new AttackStatus({
    playerData,
    attackType: options.attackType,
    carryOver: false,
    attacked: options.attacked,
    damage: options.damage ?? 0,
    created: new Date(options.created ?? "2026-03-08T00:00:00+09:00"),
  });
  const lap = options.lap ?? 1;
  const bossIndex = options.bossIndex ?? 0;
  clanData.bossStatusByLap.get(lap)![bossIndex]!.attackPlayers.push(attackStatus);
  new AttackStatusRepository(database).insert(clanData.categoryId, lap, bossIndex, attackStatus);
  return attackStatus;
}

describe("Undo and resend services", () => {
  let tempPath: TempSqlitePath | undefined;
  let database: SqliteDatabase | undefined;

  afterEach(() => {
    if (database) {
      closeSqliteDatabase(database);
    }
    database = undefined;
    tempPath?.cleanup();
    tempPath = undefined;
  });

  it("undoes the latest attack declaration and redraws progress plus summary", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new AttackService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    seedLapOneState(database, clanData);
    const playerData = new PlayerData({ userId: "333" });
    seedPlayer(database, clanData, playerData);
    seedAttackStatus(database, clanData, playerData, { attacked: false, attackType: AttackType.BATTLE });
    playerData.log.push({ operationType: OperationType.ATTACK_DECLAR, lap: 1, bossIndex: 0 });
    runtimeStateService.set(clanData);

    const nextId = createSnowflakeFactory();
    const responseChannel = new FakeTextChannel("response", nextId);
    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!, nextId);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId, nextId);
    bossChannel.attachMessage(new FakeMessage("111"));
    summaryChannel.attachMessage(new FakeMessage("211"));

    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(bossChannel);
    gateway.registerChannel(summaryChannel);

    const result = await service.undo({
      categoryId: clanData.categoryId,
      bossNumber: 1,
      member: { id: playerData.userId, displayName: "Alice" },
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    const attackRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from AttackStatus")
      .get();

    expect(result).toBe(true);
    expect(attackRow?.count).toBe(0n);
    expect(playerData.log).toHaveLength(0);
    expect(clanData.bossStatusByLap.get(1)?.[0]?.attackPlayers).toHaveLength(0);
    expect(responseChannel.sentPayloads).toEqual([
      { content: "Alice\u306e1\u30dc\u30b9\u306b\u5bfe\u3059\u308b`\u51f8\u5ba3\u8a00`\u3092\u5143\u306b\u623b\u3057\u307e\u3059\u3002" },
    ]);
    expect(bossChannel.messages.get("111")?.edits).toHaveLength(1);
    expect(summaryChannel.messages.get("211")?.edits).toHaveLength(1);
  });

  it("undoes the latest declaration for the specified boss even when another boss has a newer declaration", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new AttackService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    seedLapOneState(database, clanData);
    const playerData = new PlayerData({ userId: "333" });
    seedPlayer(database, clanData, playerData);
    seedAttackStatus(database, clanData, playerData, {
      attacked: false,
      attackType: AttackType.BATTLE,
      created: "2026-03-08T00:00:00+09:00",
    });
    seedAttackStatus(database, clanData, playerData, {
      bossIndex: 1,
      attacked: false,
      attackType: AttackType.BATTLE,
      created: "2026-03-08T00:01:00+09:00",
    });
    playerData.log.push({ operationType: OperationType.ATTACK_DECLAR, lap: 1, bossIndex: 0 });
    playerData.log.push({ operationType: OperationType.ATTACK_DECLAR, lap: 1, bossIndex: 1 });
    runtimeStateService.set(clanData);

    const nextId = createSnowflakeFactory();
    const responseChannel = new FakeTextChannel("response", nextId);
    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!, nextId);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId, nextId);
    bossChannel.attachMessage(new FakeMessage("111"));
    summaryChannel.attachMessage(new FakeMessage("211"));

    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(bossChannel);
    gateway.registerChannel(summaryChannel);

    const result = await service.undo({
      categoryId: clanData.categoryId,
      bossNumber: 1,
      member: { id: playerData.userId, displayName: "Alice" },
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    expect(result).toBe(true);
    expect(playerData.log).toEqual([{ operationType: OperationType.ATTACK_DECLAR, lap: 1, bossIndex: 1 }]);
    expect(clanData.bossStatusByLap.get(1)?.[0]?.attackPlayers).toHaveLength(0);
    expect(clanData.bossStatusByLap.get(1)?.[1]?.attackPlayers).toHaveLength(1);
    expect(responseChannel.sentPayloads).toEqual([
      { content: "Alice\u306e1\u30dc\u30b9\u306b\u5bfe\u3059\u308b`\u51f8\u5ba3\u8a00`\u3092\u5143\u306b\u623b\u3057\u307e\u3059\u3002" },
    ]);
  });

  it("undoes a resolved attack back to a declaration when declare and finish share the same timestamp", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new AttackService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    seedLapOneState(database, clanData);
    const playerData = new PlayerData({ userId: "333333333333333333", physicsAttack: 1 });
    seedPlayer(database, clanData, playerData);
    runtimeStateService.set(clanData);

    const nextId = createSnowflakeFactory();
    const responseChannel = new FakeTextChannel("response", nextId);
    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!, nextId);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId, nextId);
    const remainChannel = new FakeTextChannel(clanData.remainAttackChannelId, nextId);
    bossChannel.attachMessage(new FakeMessage("111"));
    summaryChannel.attachMessage(new FakeMessage("211"));
    remainChannel.attachMessage(new FakeMessage(clanData.remainAttackMessageId!));

    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(bossChannel);
    gateway.registerChannel(summaryChannel);
    gateway.registerChannel(remainChannel);

    await service.declare({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      member: { id: playerData.userId, displayName: "Alice" },
      attackType: ATTACK_TYPE_INPUTS.BATTLE,
      responseChannel: new FakeTextChannel("declare-response", nextId),
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });
    await service.finish({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      member: { id: playerData.userId, displayName: "Alice" },
      damage: 234567,
      responseChannel: new FakeTextChannel("finish-response", nextId),
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    const result = await service.undo({
      categoryId: clanData.categoryId,
      bossNumber: 1,
      member: { id: playerData.userId, displayName: "Alice" },
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    const attackRow = database
      .prepare<[], { attacked: bigint; damage: bigint }>(
        "select attacked, damage from AttackStatus where category_id=223456789012345678 and lap=1 and boss_index=0",
      )
      .get();
    const playerRow = database
      .prepare<[], { battle_attack_count: bigint; physics_attack: bigint; magic_attack: bigint }>(
        "select battle_attack_count, physics_attack, magic_attack from PlayerData where user_id=333333333333333333",
      )
      .get();

    expect(result).toBe(true);
    expect(attackRow).toEqual({ attacked: 0n, damage: 234567n });
    expect(playerData.battleAttackCount).toBe(1);
    expect(playerData.physicsAttack).toBe(1);
    expect(playerRow).toEqual({
      battle_attack_count: 1n,
      physics_attack: 1n,
      magic_attack: 0n,
    });
    expect(responseChannel.sentPayloads).toEqual([
      { content: "Alice\u306e1\u30dc\u30b9\u306b\u5bfe\u3059\u308b`\u30dc\u30b9\u3078\u306e\u51f8`\u3092\u5143\u306b\u623b\u3057\u307e\u3059\u3002" },
    ]);
  });

  it("does not consume a carryover twice when a finished attack is undone and finished again", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const progressionStart = new Date("2026-03-08T06:00:00+09:00").getTime();
    let progressionOffsetMs = 0;
    const progressionClock = {
      now: () => new Date(progressionStart + progressionOffsetMs++ * 1_000),
    };

    const runtimeStateService = new RuntimeStateService({ database, clock: progressionClock });
    const service = new AttackService({
      database,
      runtimeStateService,
      clock: progressionClock,
    });

    const clanData = createClanData();
    seedLapOneState(database, clanData);
    const carryOverList = Array.from({ length: 3 }, (_, bossIndex) => {
      return new CarryOver({
        attackType: AttackType.BATTLE,
        bossIndex,
        created: new Date(`2026-03-08T05:0${bossIndex}:30+09:00`),
      });
    });
    const playerData = new PlayerData({
      userId: "333",
      physicsAttack: 3,
      carryOverList,
    });
    seedPlayer(database, clanData, playerData);

    const attackEntryRepository = new AttackEntryRepository(database);
    carryOverList.forEach((carryOver, bossIndex) => {
      attackEntryRepository.insert(
        new AttackEntry({
          attackEntryId: `produced-carry-${bossIndex}`,
          categoryId: clanData.categoryId,
          userId: playerData.userId,
          dayKey: clanData.date,
          lap: 1,
          bossIndex,
          kind: AttackEntryKind.BATTLE,
          status: AttackEntryStatus.DEFEATED,
          declaredAt: new Date(`2026-03-08T05:0${bossIndex}:00+09:00`),
          resolvedAt: carryOver.created,
        }),
      );
    });

    runtimeStateService.set(clanData);
    runtimeStateService.syncProjectedStateForCategory(
      clanData.categoryId,
      clanData.date,
      progressionClock.now(),
    );

    const nextId = createSnowflakeFactory();
    const bossOneChannel = new FakeTextChannel(clanData.bossChannelIds[0]!, nextId);
    const bossTwoChannel = new FakeTextChannel(clanData.bossChannelIds[1]!, nextId);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId, nextId);
    const remainChannel = new FakeTextChannel(clanData.remainAttackChannelId, nextId);
    bossOneChannel.attachMessage(new FakeMessage("111"));
    bossTwoChannel.attachMessage(new FakeMessage("112"));
    summaryChannel.attachMessage(new FakeMessage("211"));
    remainChannel.attachMessage(new FakeMessage(clanData.remainAttackMessageId!));

    const gateway = new FakeDiscordGateway();
    [bossOneChannel, bossTwoChannel, summaryChannel, remainChannel].forEach((channel) =>
      gateway.registerChannel(channel),
    );
    const commonRequest = {
      categoryId: clanData.categoryId,
      member: { id: playerData.userId, displayName: "Alice" },
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    };

    await service.declare({
      ...commonRequest,
      channelId: clanData.bossChannelIds[0]!,
      attackType: ATTACK_TYPE_INPUTS.CARRYOVER,
      responseChannel: new FakeTextChannel("declare-boss1", nextId),
    });
    await service.finish({
      ...commonRequest,
      channelId: clanData.bossChannelIds[0]!,
      responseChannel: new FakeTextChannel("finish-boss1", nextId),
    });

    const undoResult = await service.undo({
      ...commonRequest,
      bossNumber: 1,
      responseChannel: new FakeTextChannel("undo-boss1", nextId),
    });

    expect(undoResult).toBe(true);
    expect(playerData.carryOverList).toHaveLength(3);
    expect(
      runtimeStateService.getPlayerResourceState(
        clanData.categoryId,
        playerData.userId,
        clanData.date,
      )?.toRecord(),
    ).toMatchObject({
      carryAvailableCount: 2,
      carryReservedCount: 1,
    });

    await service.finish({
      ...commonRequest,
      channelId: clanData.bossChannelIds[0]!,
      responseChannel: new FakeTextChannel("refinish-boss1", nextId),
    });
    await service.declare({
      ...commonRequest,
      channelId: clanData.bossChannelIds[1]!,
      attackType: ATTACK_TYPE_INPUTS.CARRYOVER,
      responseChannel: new FakeTextChannel("declare-boss2", nextId),
    });
    await service.finish({
      ...commonRequest,
      channelId: clanData.bossChannelIds[1]!,
      responseChannel: new FakeTextChannel("finish-boss2", nextId),
    });

    const carryOverRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from CarryOver")
      .get();
    const resourceState = runtimeStateService.getPlayerResourceState(
      clanData.categoryId,
      playerData.userId,
      clanData.date,
    );

    expect(playerData.carryOverList).toHaveLength(1);
    expect(carryOverRow?.count).toBe(1n);
    expect(resourceState?.carryAvailableCount).toBe(1);
    expect(resourceState?.carryReservedCount).toBe(0);
  });

  it("undoes a resolved attack for the specified boss even when another boss has newer battle operations", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const progressionStart = new Date("2026-03-08T06:00:00+09:00").getTime();
    let progressionOffsetMs = 0;
    const progressionClock = {
      now: () => new Date(progressionStart + progressionOffsetMs++ * 1_000),
    };

    const runtimeStateService = new RuntimeStateService({ database, clock: progressionClock });
    const service = new AttackService({
      database,
      runtimeStateService,
      clock: progressionClock,
    });

    const clanData = createClanData();
    seedLapOneState(database, clanData);
    const playerData = new PlayerData({ userId: "333" });
    seedPlayer(database, clanData, playerData);
    runtimeStateService.set(clanData);

    const nextId = createSnowflakeFactory();
    const responseChannel = new FakeTextChannel("response", nextId);
    const bossOneChannel = new FakeTextChannel(clanData.bossChannelIds[0]!, nextId);
    const bossTwoChannel = new FakeTextChannel(clanData.bossChannelIds[1]!, nextId);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId, nextId);
    const remainChannel = new FakeTextChannel(clanData.remainAttackChannelId, nextId);
    bossOneChannel.attachMessage(new FakeMessage("111"));
    bossTwoChannel.attachMessage(new FakeMessage("112"));
    summaryChannel.attachMessage(new FakeMessage("211"));
    summaryChannel.attachMessage(new FakeMessage("212"));
    remainChannel.attachMessage(new FakeMessage(clanData.remainAttackMessageId!));

    const gateway = new FakeDiscordGateway();
    [bossOneChannel, bossTwoChannel, summaryChannel, remainChannel].forEach((channel) =>
      gateway.registerChannel(channel),
    );

    await service.declare({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      member: { id: playerData.userId, displayName: "Alice" },
      attackType: ATTACK_TYPE_INPUTS.BATTLE,
      responseChannel: new FakeTextChannel("declare-boss1", nextId),
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });
    await service.finish({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      member: { id: playerData.userId, displayName: "Alice" },
      damage: 200000,
      responseChannel: new FakeTextChannel("finish-boss1", nextId),
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });
    await service.declare({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[1]!,
      member: { id: playerData.userId, displayName: "Alice" },
      attackType: ATTACK_TYPE_INPUTS.BATTLE,
      responseChannel: new FakeTextChannel("declare-boss2", nextId),
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });
    await service.finish({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[1]!,
      member: { id: playerData.userId, displayName: "Alice" },
      damage: 300000,
      responseChannel: new FakeTextChannel("finish-boss2", nextId),
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    const result = await service.undo({
      categoryId: clanData.categoryId,
      bossNumber: 1,
      member: { id: playerData.userId, displayName: "Alice" },
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    const attackRows = database
      .prepare<[], { boss_index: bigint; attacked: bigint }>(
        "select boss_index, attacked from AttackStatus order by boss_index asc",
      )
      .all();

    expect(result).toBe(true);
    expect(attackRows).toEqual([
      { boss_index: 0n, attacked: 0n },
      { boss_index: 1n, attacked: 1n },
    ]);
    expect(responseChannel.sentPayloads).toEqual([
      { content: "Alice\u306e1\u30dc\u30b9\u306b\u5bfe\u3059\u308b`\u30dc\u30b9\u3078\u306e\u51f8`\u3092\u5143\u306b\u623b\u3057\u307e\u3059\u3002" },
    ]);
  });

  it("undoes the latest boss defeat, clears generated next-lap messages, and restores player state", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new AttackService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    seedLapOneState(database, clanData);
    const carryOver = new CarryOver({
      attackType: AttackType.BATTLE,
      bossIndex: 0,
      created: new Date("2026-03-08T00:05:00+09:00"),
    });
    const playerData = new PlayerData({
      userId: "333",
      physicsAttack: 3,
      carryOverList: [carryOver],
    });
    playerData.log.push({
      operationType: OperationType.LAST_ATTACK,
      lap: 1,
      bossIndex: 0,
      playerData: {
        physicsAttack: 2,
        magicAttack: 0,
        carryOverList: [],
      },
      beated: false,
    });
    seedPlayer(database, clanData, playerData);
    const attackStatus = seedAttackStatus(database, clanData, playerData, {
      attacked: true,
      attackType: AttackType.BATTLE,
      damage: 600000,
    });
    clanData.bossStatusByLap.get(1)![0]!.beated = true;
    new BossStatusRepository(database).update(clanData.categoryId, clanData.bossStatusByLap.get(1)![0]!);
    clanData.progressMessageIdsByLap.set(2, ["411", null, null, null, null]);
    clanData.summaryMessageIdsByLap.set(2, ["511", "512", "513", "514", "515"]);
    clanData.initializeBossStatusData(2);
    seedLapState(database, clanData, 2);
    runtimeStateService.set(clanData);

    const nextId = createSnowflakeFactory();
    const responseChannel = new FakeTextChannel("response", nextId);
    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!, nextId);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId, nextId);
    const remainChannel = new FakeTextChannel(clanData.remainAttackChannelId, nextId);
    bossChannel.attachMessage(new FakeMessage("111"));
    bossChannel.attachMessage(new FakeMessage("411"));
    summaryChannel.attachMessage(new FakeMessage("211"));
    summaryChannel.attachMessage(new FakeMessage("511"));
    summaryChannel.attachMessage(new FakeMessage("512"));
    summaryChannel.attachMessage(new FakeMessage("513"));
    summaryChannel.attachMessage(new FakeMessage("514"));
    summaryChannel.attachMessage(new FakeMessage("515"));
    remainChannel.attachMessage(new FakeMessage(clanData.remainAttackMessageId!));

    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(bossChannel);
    gateway.registerChannel(summaryChannel);
    gateway.registerChannel(remainChannel);

    const result = await service.undo({
      categoryId: clanData.categoryId,
      bossNumber: 1,
      member: { id: playerData.userId, displayName: "Alice" },
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    const attackRow = database
      .prepare<[], { attacked: bigint }>("select attacked from AttackStatus")
      .get();
    const playerRow = database
      .prepare<[], { physics_attack: bigint; magic_attack: bigint }>(
        "select physics_attack, magic_attack from PlayerData where user_id=333",
      )
      .get();
    const carryOverRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from CarryOver")
      .get();
    const bossStatusRow = database
      .prepare<[], { beated: bigint }>("select beated from BossStatusData where category_id=223456789012345678 and lap=1 and boss_index=0")
      .get();
    const nextLapProgressRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from ProgressMessageIdData where category_id=223456789012345678 and lap=2")
      .get();
    const nextLapSummaryRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from SummaryMessageIdData where category_id=223456789012345678 and lap=2")
      .get();

    expect(result).toBe(true);
    expect(attackStatus.attacked).toBe(false);
    expect(attackRow?.attacked).toBe(0n);
    expect(playerData.physicsAttack).toBe(2);
    expect(playerData.magicAttack).toBe(0);
    expect(playerData.carryOverList).toHaveLength(0);
    expect(playerData.log).toHaveLength(0);
    expect(playerRow?.physics_attack).toBe(2n);
    expect(playerRow?.magic_attack).toBe(0n);
    expect(carryOverRow?.count).toBe(0n);
    expect(clanData.bossStatusByLap.get(1)?.[0]?.beated).toBe(false);
    expect(bossStatusRow?.beated).toBe(0n);
    expect(clanData.progressMessageIdsByLap.has(2)).toBe(false);
    expect(clanData.summaryMessageIdsByLap.has(2)).toBe(true);
    expect(nextLapProgressRow?.count).toBe(0n);
    expect(nextLapSummaryRow?.count).toBe(1n);
    expect(responseChannel.sentPayloads).toEqual([
      { content: "Alice\u306e1\u30dc\u30b9\u306b\u5bfe\u3059\u308b`\u30dc\u30b9\u306e\u8a0e\u4f10`\u3092\u5143\u306b\u623b\u3057\u307e\u3059\u3002" },
    ]);
    expect(bossChannel.messages.get("111")?.edits).toHaveLength(1);
    expect(bossChannel.messages.has("411")).toBe(false);
    expect(summaryChannel.messages.has("211")).toBe(false);
    expect(summaryChannel.sentMessages).toHaveLength(1);
    expect(summaryChannel.messages.has("511")).toBe(false);
    expect(summaryChannel.messages.has("512")).toBe(false);
    expect(summaryChannel.messages.has("513")).toBe(false);
    expect(summaryChannel.messages.has("514")).toBe(false);
    expect(summaryChannel.messages.has("515")).toBe(false);
    expect(remainChannel.messages.get(clanData.remainAttackMessageId!)?.edits).toHaveLength(1);
  });

  it("rejects undoing a boss defeat when a later boss operation depends on the generated carryover", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const progressionStart = new Date("2026-03-08T06:00:00+09:00").getTime();
    let progressionOffsetMs = 0;
    const progressionClock = {
      now: () => new Date(progressionStart + progressionOffsetMs++ * 1_000),
    };

    const runtimeStateService = new RuntimeStateService({ database, clock: progressionClock });
    const service = new AttackService({
      database,
      runtimeStateService,
      clock: progressionClock,
    });

    const clanData = createClanData();
    seedLapOneState(database, clanData);
    const playerData = new PlayerData({ userId: "333", physicsAttack: 2 });
    seedPlayer(database, clanData, playerData);
    runtimeStateService.set(clanData);

    const nextId = createSnowflakeFactory();
    const responseChannel = new FakeTextChannel("response", nextId);
    const bossOneChannel = new FakeTextChannel(clanData.bossChannelIds[0]!, nextId);
    const bossTwoChannel = new FakeTextChannel(clanData.bossChannelIds[1]!, nextId);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId, nextId);
    const remainChannel = new FakeTextChannel(clanData.remainAttackChannelId, nextId);
    bossOneChannel.attachMessage(new FakeMessage("111"));
    bossTwoChannel.attachMessage(new FakeMessage("112"));
    summaryChannel.attachMessage(new FakeMessage("211"));
    summaryChannel.attachMessage(new FakeMessage("212"));
    remainChannel.attachMessage(new FakeMessage(clanData.remainAttackMessageId!));

    const gateway = new FakeDiscordGateway();
    [bossOneChannel, bossTwoChannel, summaryChannel, remainChannel].forEach((channel) =>
      gateway.registerChannel(channel),
    );

    await service.declare({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      member: { id: playerData.userId, displayName: "Alice" },
      attackType: ATTACK_TYPE_INPUTS.BATTLE,
      responseChannel: new FakeTextChannel("declare-boss1", nextId),
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });
    await service.defeatBoss({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      member: { id: playerData.userId, displayName: "Alice" },
      responseChannel: new FakeTextChannel("defeat-boss1", nextId),
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });
    await service.declare({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[1]!,
      member: { id: playerData.userId, displayName: "Alice" },
      attackType: ATTACK_TYPE_INPUTS.CARRYOVER,
      responseChannel: new FakeTextChannel("declare-boss2", nextId),
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });
    await service.finish({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[1]!,
      member: { id: playerData.userId, displayName: "Alice" },
      damage: 120000,
      responseChannel: new FakeTextChannel("finish-boss2", nextId),
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    const result = await service.undo({
      categoryId: clanData.categoryId,
      bossNumber: 1,
      member: { id: playerData.userId, displayName: "Alice" },
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    expect(result).toBe(false);
    expect(responseChannel.sentPayloads).toEqual([
      { content: "このボスの後に別の操作があるため自動巻き戻しできません" },
    ]);
  });

  it("allows undoing the original battle defeat after a later carryover attack is corrected back to battle", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const progressionStart = new Date("2026-03-08T06:00:00+09:00").getTime();
    let progressionOffsetMs = 0;
    const progressionClock = {
      now: () => new Date(progressionStart + progressionOffsetMs++ * 1_000),
    };

    const runtimeStateService = new RuntimeStateService({ database, clock: progressionClock });
    const service = new AttackService({
      database,
      runtimeStateService,
      clock: progressionClock,
    });

    const clanData = createClanData();
    seedLapOneState(database, clanData);
    const playerData = new PlayerData({ userId: "333" });
    seedPlayer(database, clanData, playerData);
    runtimeStateService.set(clanData);

    const nextId = createSnowflakeFactory();
    const responseChannel = new FakeTextChannel("response", nextId);
    const bossOneChannel = new FakeTextChannel(clanData.bossChannelIds[0]!, nextId);
    const bossTwoChannel = new FakeTextChannel(clanData.bossChannelIds[1]!, nextId);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId, nextId);
    const remainChannel = new FakeTextChannel(clanData.remainAttackChannelId, nextId);
    bossOneChannel.attachMessage(new FakeMessage("111"));
    bossTwoChannel.attachMessage(new FakeMessage("112"));
    summaryChannel.attachMessage(new FakeMessage("211"));
    summaryChannel.attachMessage(new FakeMessage("212"));
    remainChannel.attachMessage(new FakeMessage(clanData.remainAttackMessageId!));

    const gateway = new FakeDiscordGateway();
    [bossOneChannel, bossTwoChannel, summaryChannel, remainChannel].forEach((channel) =>
      gateway.registerChannel(channel),
    );

    await service.declare({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      member: { id: playerData.userId, displayName: "Alice" },
      attackType: ATTACK_TYPE_INPUTS.BATTLE,
      responseChannel: new FakeTextChannel("declare-boss1", nextId),
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });
    await service.defeatBoss({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      member: { id: playerData.userId, displayName: "Alice" },
      responseChannel: new FakeTextChannel("defeat-boss1", nextId),
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });
    await service.declare({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[1]!,
      member: { id: playerData.userId, displayName: "Alice" },
      attackType: ATTACK_TYPE_INPUTS.CARRYOVER,
      responseChannel: new FakeTextChannel("declare-boss2", nextId),
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });
    await service.finish({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[1]!,
      member: { id: playerData.userId, displayName: "Alice" },
      damage: 120000,
      responseChannel: new FakeTextChannel("finish-boss2", nextId),
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    const corrected = await service.correctAttackKind({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[1]!,
      lap: 1,
      bossNumber: 2,
      member: { id: playerData.userId, displayName: "Alice" },
      responseChannel: new FakeTextChannel("correct-boss2", nextId),
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    expect(corrected).toBe(true);

    responseChannel.sentPayloads.length = 0;

    const result = await service.undo({
      categoryId: clanData.categoryId,
      bossNumber: 1,
      member: { id: playerData.userId, displayName: "Alice" },
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    const bossOneAttackRow = database
      .prepare<[], { attacked: bigint }>(
        "select attacked from AttackStatus where category_id=223456789012345678 and lap=1 and boss_index=0",
      )
      .get();
    const playerRow = database
      .prepare<[], { battle_attack_count: bigint; carry_over_count: bigint }>(
        "select battle_attack_count, (select count(*) from CarryOver where user_id=333 and category_id=223456789012345678) as carry_over_count from PlayerData where user_id=333",
      )
      .get();

    expect(result).toBe(true);
    expect(bossOneAttackRow?.attacked).toBe(0n);
    expect(playerData.battleAttackCount).toBe(1);
    expect(playerData.carryOverList).toHaveLength(0);
    expect(playerRow).toEqual({
      battle_attack_count: 1n,
      carry_over_count: 0n,
    });
    expect(responseChannel.sentPayloads).toEqual([
      { content: "Alice\u306e1\u30dc\u30b9\u306b\u5bfe\u3059\u308b`\u30dc\u30b9\u306e\u8a0e\u4f10`\u3092\u5143\u306b\u623b\u3057\u307e\u3059\u3002" },
    ]);
  });

  it("blocks undoing a boss defeat when the next lap boss already has activity", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new AttackService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    seedLapOneState(database, clanData);
    clanData.progressMessageIdsByLap.set(2, ["411", null, null, null, null]);
    clanData.summaryMessageIdsByLap.set(2, ["511", "512", "513", "514", "515"]);
    clanData.initializeBossStatusData(2);
    seedLapState(database, clanData, 2);

    const playerData = new PlayerData({
      userId: "333",
      physicsAttack: 3,
      carryOverList: [
        new CarryOver({
          attackType: AttackType.BATTLE,
          bossIndex: 0,
          created: new Date("2026-03-08T00:05:00+09:00"),
        }),
      ],
    });
    playerData.log.push({
      operationType: OperationType.LAST_ATTACK,
      lap: 1,
      bossIndex: 0,
      playerData: {
        physicsAttack: 2,
        magicAttack: 0,
        carryOverList: [],
      },
      beated: false,
    });
    seedPlayer(database, clanData, playerData);
    const attackStatus = seedAttackStatus(database, clanData, playerData, {
      attacked: true,
      attackType: AttackType.BATTLE,
      damage: 600000,
    });
    clanData.bossStatusByLap.get(1)![0]!.beated = true;
    new BossStatusRepository(database).update(clanData.categoryId, clanData.bossStatusByLap.get(1)![0]!);

    const blockingPlayer = new PlayerData({ userId: "444" });
    seedPlayer(database, clanData, blockingPlayer);
    seedAttackStatus(database, clanData, blockingPlayer, {
      lap: 2,
      bossIndex: 0,
      attacked: false,
      attackType: AttackType.BATTLE,
      damage: 100000,
      created: "2026-03-08T00:10:00+09:00",
    });
    runtimeStateService.set(clanData);

    const nextId = createSnowflakeFactory();
    const responseChannel = new FakeTextChannel("response", nextId);

    const result = await service.undo({
      categoryId: clanData.categoryId,
      bossNumber: 1,
      member: { id: playerData.userId, displayName: "Alice" },
      responseChannel,
      discordGateway: new FakeDiscordGateway(),
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    const bossStatusRow = database
      .prepare<[], { beated: bigint }>("select beated from BossStatusData where category_id=223456789012345678 and lap=1 and boss_index=0")
      .get();

    expect(result).toBe(false);
    expect(attackStatus.attacked).toBe(true);
    expect(clanData.bossStatusByLap.get(1)?.[0]?.beated).toBe(true);
    expect(bossStatusRow?.beated).toBe(1n);
    expect(responseChannel.sentPayloads).toEqual([
      { content: "次周に既に操作があるため自動巻き戻しできません" },
    ]);
    expect(clanData.progressMessageIdsByLap.get(2)?.[0]).toBe("411");
  });

  it("rejects undoing a resolved attack for the specified boss when the member has later operations", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new AttackService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    seedLapOneState(database, clanData);
    const playerData = new PlayerData({ userId: "333", physicsAttack: 1 });
    seedPlayer(database, clanData, playerData);
    const resolvedAttackStatus = seedAttackStatus(database, clanData, playerData, {
      attacked: true,
      attackType: AttackType.BATTLE,
      damage: 300000,
      created: "2026-03-08T00:00:00+09:00",
    });
    seedAttackStatus(database, clanData, playerData, {
      bossIndex: 1,
      attacked: false,
      attackType: AttackType.BATTLE,
      created: "2026-03-08T00:02:00+09:00",
    });
    playerData.log.push({
      operationType: OperationType.ATTACK,
      lap: 1,
      bossIndex: 0,
      playerData: {
        battleAttackCount: 0,
        carryOverList: [],
      },
    });
    playerData.log.push({
      operationType: OperationType.ATTACK_DECLAR,
      lap: 1,
      bossIndex: 1,
    });
    runtimeStateService.set(clanData);

    const responseChannel = new FakeTextChannel("response");

    const result = await service.undo({
      categoryId: clanData.categoryId,
      bossNumber: 1,
      member: { id: playerData.userId, displayName: "Alice" },
      responseChannel,
      discordGateway: new FakeDiscordGateway(),
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    expect(result).toBe(false);
    expect(resolvedAttackStatus.attacked).toBe(true);
    expect(playerData.log).toHaveLength(2);
    expect(responseChannel.sentPayloads).toEqual([
      { content: "このボスの後に別の操作があるため自動巻き戻しできません" },
    ]);
  });

  it("treats old-day undo targets as nothing after JST 5:00 rollover", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new AttackService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-09T06:00:00+09:00"),
    });
    const clanRepository = new ClanRepository(database);
    const attackEntryRepository = new AttackEntryRepository(database);
    const operationLogRepository = new OperationLogRepository(database);

    const clanData = createClanData();
    clanData.date = "2026-03-08";
    clanRepository.insert(clanData);
    seedLapOneState(database, clanData);
    const playerData = new PlayerData({ userId: "333", physicsAttack: 1 });
    seedPlayer(database, clanData, playerData);
    const resolvedAttackStatus = seedAttackStatus(database, clanData, playerData, {
      attacked: true,
      attackType: AttackType.BATTLE,
      damage: 300000,
      created: "2026-03-08T00:00:00+09:00",
    });
    playerData.log.push({
      operationType: OperationType.ATTACK,
      lap: 1,
      bossIndex: 0,
      playerData: {
        battleAttackCount: 0,
        carryOverList: [],
      },
    });
    attackEntryRepository.insert(
      new AttackEntry({
        attackEntryId: "attack-old-day",
        categoryId: clanData.categoryId,
        userId: playerData.userId,
        dayKey: "2026-03-08",
        lap: 1,
        bossIndex: 0,
        kind: AttackEntryKind.BATTLE,
        status: AttackEntryStatus.FINISHED,
        declaredAt: new Date("2026-03-08T00:00:00+09:00"),
        resolvedAt: new Date("2026-03-08T00:01:00+09:00"),
        damage: 300000,
      }),
    );
    operationLogRepository.insert(
      new OperationLog({
        operationId: "operation-old-day",
        categoryId: clanData.categoryId,
        userId: playerData.userId,
        dayKey: "2026-03-08",
        lap: 1,
        bossIndex: 0,
        targetAttackEntryId: "attack-old-day",
        operationType: OperationLogType.FINISH,
        beforeKind: AttackEntryKind.BATTLE,
        afterKind: AttackEntryKind.BATTLE,
        beforeStatus: AttackEntryStatus.DECLARED,
        afterStatus: AttackEntryStatus.FINISHED,
        occurredAt: new Date("2026-03-08T00:01:00+09:00"),
      }),
    );
    runtimeStateService.set(clanData);

    const responseChannel = new FakeTextChannel("response");
    const nextId = createSnowflakeFactory();
    const remainChannel = new FakeTextChannel(clanData.remainAttackChannelId, nextId);
    remainChannel.attachMessage(new FakeMessage(clanData.remainAttackMessageId!));
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(remainChannel);

    const result = await service.undo({
      categoryId: clanData.categoryId,
      bossNumber: 1,
      member: { id: playerData.userId, displayName: "Alice" },
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    expect(result).toBe(false);
    expect(responseChannel.sentPayloads).toEqual([{ content: UNDO_NOTHING_MESSAGE }]);
    expect(runtimeStateService.getAttackEntries(clanData.categoryId)).toHaveLength(0);
    expect(runtimeStateService.getOperationLogs(clanData.categoryId)).toHaveLength(0);
    expect(
      database
        .prepare<[], { count: bigint }>("select count(*) as count from AttackEntry")
        .get()?.count,
    ).toBe(0n);
    expect(
      database
        .prepare<[], { count: bigint }>("select count(*) as count from OperationLog")
        .get()?.count,
    ).toBe(0n);
    expect(resolvedAttackStatus.attacked).toBe(true);
  });

  it("resends a progress message, updates message ids, and keeps summary mirror untouched", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({
      database,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });
    const service = new ProgressMessageService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    seedLapOneState(database, clanData);
    runtimeStateService.set(clanData);

    const nextId = createSnowflakeFactory();
    const responseChannel = new FakeTextChannel("response", nextId);
    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!, nextId);
    const oldProgressMessage = new FakeMessage("111");
    bossChannel.attachMessage(oldProgressMessage);

    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(bossChannel);

    const messageId = await service.resend({
      categoryId: clanData.categoryId,
      channelId: clanData.commandChannelId,
      bossNumber: 1,
      responseChannel,
      discordGateway: gateway,
    });

    const progressRow = database
      .prepare<[], { boss1: bigint }>("select boss1 from ProgressMessageIdData where lap=1")
      .get();
    const summaryRow = database
      .prepare<[], { boss1: bigint }>("select boss1 from SummaryMessageIdData where lap=1")
      .get();

    expect(oldProgressMessage.deleted).toBe(true);
    expect(bossChannel.sentMessages).toHaveLength(1);
    expect(bossChannel.sentMessages[0]?.edits[0]?.components).toHaveLength(2);
    expect(messageId).toBe(bossChannel.sentMessages[0]?.id);
    expect(clanData.progressMessageIdsByLap.get(1)?.[0]).toBe(bossChannel.sentMessages[0]?.id);
    expect(progressRow?.boss1.toString()).toBe(bossChannel.sentMessages[0]?.id);
    expect(summaryRow?.boss1.toString()).toBe("211");
    expect(responseChannel.sentPayloads).toEqual([
      { content: "1\u9031\u76ee1\u306e\u9032\u884c\u7528\u30e1\u30c3\u30bb\u30fc\u30b8\u3092\u518d\u9001\u3057\u307e\u3059" },
    ]);
  });

  it("recreates a missing progress message on resend", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({
      database,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });
    const service = new ProgressMessageService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    seedLapOneState(database, clanData);
    runtimeStateService.set(clanData);

    const nextId = createSnowflakeFactory();
    const responseChannel = new FakeTextChannel("response", nextId);
    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!, nextId);

    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(bossChannel);

    const messageId = await service.resend({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      responseChannel,
      discordGateway: gateway,
    });

    expect(bossChannel.sentMessages).toHaveLength(1);
    expect(messageId).toBe(bossChannel.sentMessages[0]?.id);
    expect(clanData.progressMessageIdsByLap.get(1)?.[0]).toBe(bossChannel.sentMessages[0]?.id);
  });

  it("creates a new remain-attack message on day rollover before resend", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new ProgressMessageService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    clanData.date = "2026-03-07";
    new ClanRepository(database).insert(clanData);
    seedLapOneState(database, clanData);
    runtimeStateService.set(clanData);

    const nextId = createSnowflakeFactory();
    const responseChannel = new FakeTextChannel("response", nextId);
    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!, nextId);
    bossChannel.attachMessage(new FakeMessage("111"));
    const remainChannel = new FakeTextChannel(clanData.remainAttackChannelId, nextId);
    const oldRemainMessage = new FakeMessage(clanData.remainAttackMessageId!);
    remainChannel.attachMessage(oldRemainMessage);

    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(bossChannel);
    gateway.registerChannel(remainChannel);

    const messageId = await service.resend({
      categoryId: clanData.categoryId,
      channelId: clanData.commandChannelId,
      bossNumber: 1,
      responseChannel,
      discordGateway: gateway,
    });

    const clanRow = database
      .prepare<[], { remain_attack_message_id: bigint | null; day: string }>(
        "select remain_attack_message_id, day from ClanData where category_id=223456789012345678",
      )
      .get();

    expect(messageId).toBe(bossChannel.sentMessages[0]?.id);
    expect(clanData.date).toBe("2026-03-08");
    expect(oldRemainMessage.edits).toHaveLength(0);
    expect(remainChannel.sentMessages).toHaveLength(1);
    expect(remainChannel.sentMessages[0]?.reactions).toEqual(["💀"]);
    expect(clanData.remainAttackMessageId).toBe(remainChannel.sentMessages[0]?.id);
    expect(clanRow?.remain_attack_message_id?.toString()).toBe(clanData.remainAttackMessageId);
    expect(clanRow?.day).toBe("2026-03-08");
  });
});
