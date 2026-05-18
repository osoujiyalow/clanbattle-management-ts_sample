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
import { CarryOver, PlayerData } from "../../../../src/domain/player-data.js";
import { OperationType } from "../../../../src/domain/operation-type.js";
import { AttackEntryRepository } from "../../../../src/repositories/sqlite/attack-entry-repository.js";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
  type SqliteDatabase,
} from "../../../../src/repositories/sqlite/db.js";
import { BossStatusRepository } from "../../../../src/repositories/sqlite/boss-status-repository.js";
import {
  ProgressMessageIdRepository,
  SummaryMessageIdRepository,
} from "../../../../src/repositories/sqlite/boss-message-id-repository.js";
import { ClanRepository } from "../../../../src/repositories/sqlite/clan-repository.js";
import { OperationLogRepository } from "../../../../src/repositories/sqlite/operation-log-repository.js";
import { PlayerRepository } from "../../../../src/repositories/sqlite/player-repository.js";
import { AttackStatusRepository } from "../../../../src/repositories/sqlite/attack-status-repository.js";
import { CarryOverRepository } from "../../../../src/repositories/sqlite/carry-over-repository.js";
import {
  AttackService,
  type AttackDeclareResponseChannel,
  type AttackDiscordGateway,
  type AttackEditableMessage,
  type AttackTextChannel,
} from "../../../../src/services/attack-service.js";
import { CORRECT_ATTACK_KIND_NOTHING_MESSAGE } from "../../../../src/services/attack-service-support.js";
import { RuntimeStateService } from "../../../../src/services/runtime-state-service.js";
import { createFixedClock } from "../../../../src/shared/time.js";
import { createCoreRepositorySchema } from "../../../unit/repositories/sqlite/core-repository-schema.js";
import { createTempSqlitePath, type TempSqlitePath } from "../../../unit/repositories/sqlite/test-sqlite-path.js";

class FakeEditableMessage implements AttackEditableMessage {
  readonly edits: Array<{ embeds?: unknown[]; components?: unknown[] }> = [];
  readonly reactions: string[] = [];

  constructor(readonly id: string) {}

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
}

class FakeReactionFailingMessage extends FakeEditableMessage {
  async addReaction(): Promise<void> {
    throw new Error("Failed to add reaction");
  }
}

class FakeTextChannel implements AttackTextChannel, AttackDeclareResponseChannel {
  readonly sentPayloads: Array<{ content?: string }> = [];
  readonly sentMessages: FakeEditableMessage[] = [];
  readonly messages = new Map<string, FakeEditableMessage>();

  constructor(readonly id: string, private readonly nextId: () => string) {}

  async send(payload: { content?: string }): Promise<void> {
    this.sentPayloads.push(payload);
  }

  async sendMessage(payload: {
    embeds?: readonly { toJSON(): unknown }[];
    components?: readonly { toJSON(): unknown }[];
  }): Promise<FakeEditableMessage> {
    const message = this.createSentMessage(this.nextId());
    this.attachMessage(message);
    this.sentMessages.push(message);
    if (payload.embeds || payload.components) {
      await message.edit(payload);
    }
    return message;
  }

  async fetchMessage(messageId: string): Promise<FakeEditableMessage> {
    const message = this.messages.get(messageId);
    if (!message) {
      throw new Error(`Unknown message id: ${messageId}`);
    }
    return message;
  }

  attachMessage(message: FakeEditableMessage): void {
    this.messages.set(message.id, message);
  }

  protected createSentMessage(messageId: string): FakeEditableMessage {
    return new FakeEditableMessage(messageId);
  }
}

class FakeReactionFailingTextChannel extends FakeTextChannel {
  protected createSentMessage(messageId: string): FakeEditableMessage {
    return new FakeReactionFailingMessage(messageId);
  }
}

class FakeDiscordGateway implements AttackDiscordGateway {
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

function createSnowflakeFactory(start = 700000000000000000n): () => string {
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

function seedPlayer(database: SqliteDatabase, clanData: ClanData, playerData: PlayerData): void {
  const playerRepository = new PlayerRepository(database);
  const carryOverRepository = new CarryOverRepository(database);
  clanData.addPlayerData(playerData);
  playerRepository.insertMany(clanData.categoryId, [playerData]);
  playerRepository.update(clanData.categoryId, playerData);
  carryOverRepository.replaceAll(clanData.categoryId, playerData.userId, playerData.carryOverList);
}

function seedLapOneState(database: SqliteDatabase, clanData: ClanData): void {
  new BossStatusRepository(database).insertAllForLap(clanData.categoryId, clanData.bossStatusByLap.get(1)!);
  new ProgressMessageIdRepository(database).insert(
    clanData.categoryId,
    1,
    clanData.progressMessageIdsByLap.get(1)!,
  );
  new SummaryMessageIdRepository(database).insert(
    clanData.categoryId,
    1,
    clanData.summaryMessageIdsByLap.get(1)!,
  );
}

function seedDeclaredAttack(
  database: SqliteDatabase,
  clanData: ClanData,
  playerData: PlayerData,
  attackType: AttackType,
  options?: { carryOver?: boolean; damage?: number; created?: string },
): AttackStatus {
  const attackStatus = new AttackStatus({
    playerData,
    attackType,
    carryOver: options?.carryOver ?? false,
    damage: options?.damage ?? 0,
    attacked: false,
    created: new Date(options?.created ?? "2026-03-08T00:00:00+09:00"),
  });
  clanData.bossStatusByLap.get(1)![0]!.attackPlayers.push(attackStatus);
  playerData.log.push({ operationType: OperationType.ATTACK_DECLAR, lap: 1, bossIndex: 0 });
  new AttackStatusRepository(database).insert(clanData.categoryId, 1, 0, attackStatus);
  return attackStatus;
}

describe("AttackService resolution", () => {
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

  it("finishes a declared attack and updates player and embeds", async () => {
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
    seedDeclaredAttack(database, clanData, playerData, AttackType.BATTLE, { damage: 123_456 });
    runtimeStateService.set(clanData);

    const nextId = createSnowflakeFactory();
    const responseChannel = new FakeTextChannel("response", nextId);
    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!, nextId);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId, nextId);
    const remainChannel = new FakeTextChannel(clanData.remainAttackChannelId, nextId);
    const lapOneProgressMessage = new FakeEditableMessage("111");
    bossChannel.attachMessage(lapOneProgressMessage);
    summaryChannel.attachMessage(new FakeEditableMessage("211"));
    remainChannel.attachMessage(new FakeEditableMessage(clanData.remainAttackMessageId!));
    const gateway = new FakeDiscordGateway();
    [bossChannel, summaryChannel, remainChannel].forEach((channel) => gateway.registerChannel(channel));

    const result = await service.finish({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      member: { id: playerData.userId, displayName: "Alice" },
      damage: 234_567,
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    const playerRow = database
      .prepare<[], { physics_attack: bigint; magic_attack: bigint }>(
        "select max(physics_attack) as physics_attack, max(magic_attack) as magic_attack from PlayerData",
      )
      .get();
    const attackRow = database
      .prepare<[], { attacked: bigint; damage: bigint }>(
        "select max(attacked) as attacked, max(damage) as damage from AttackStatus",
      )
      .get();
    const attackEntryRow = database
      .prepare<[], { status: string; damage: bigint | null }>(
        "select status, damage from AttackEntry",
      )
      .get();
    const operationLogRows = database
      .prepare<[], { operation_type: string }>(
        "select operation_type from OperationLog order by occurred_at asc, operation_id asc",
      )
      .all();

    expect(result?.attacked).toBe(true);
    expect(playerRow?.physics_attack).toBe(2n);
    expect(playerRow?.magic_attack).toBe(0n);
    expect(attackRow?.attacked).toBe(1n);
    expect(attackRow?.damage).toBe(234567n);
    expect(attackEntryRow).toEqual({
      status: "finished",
      damage: 234567n,
    });
    expect(operationLogRows.map((row) => row.operation_type)).toEqual(["finish"]);
    expect(responseChannel.sentPayloads).toHaveLength(1);
    expect(responseChannel.sentPayloads[0]?.content).toContain("Alice");
    expect(playerData.log.map((log) => log.operationType)).toEqual([
      OperationType.ATTACK_DECLAR,
      OperationType.ATTACK,
    ]);
    expect(bossChannel.messages.get("111")?.edits).toHaveLength(1);
    expect(summaryChannel.messages.get("211")?.edits).toHaveLength(1);
    expect(remainChannel.messages.get(clanData.remainAttackMessageId!)?.edits).toHaveLength(1);
    expect(
      runtimeStateService
        .getPlayerResourceState(clanData.categoryId, playerData.userId, clanData.date)
        ?.toRecord(),
    ).toEqual({
      categoryId: clanData.categoryId,
      userId: playerData.userId,
      dayKey: clanData.date,
      battleReservedCount: 0,
      battleConsumedCount: 1,
      carryAvailableCount: 0,
      carryReservedCount: 0,
    });
  });

  it("recreates a missing current remain-attack message instead of failing finish", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new AttackService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
      redrawRetryDelayMs: 0,
    });

    const clanData = createClanData();
    new ClanRepository(database).insert(clanData);
    seedLapOneState(database, clanData);
    const playerData = new PlayerData({ userId: "333", physicsAttack: 1 });
    seedPlayer(database, clanData, playerData);
    seedDeclaredAttack(database, clanData, playerData, AttackType.BATTLE, { damage: 123_456 });
    runtimeStateService.set(clanData);

    const nextId = createSnowflakeFactory();
    const responseChannel = new FakeTextChannel("response", nextId);
    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!, nextId);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId, nextId);
    const remainChannel = new FakeTextChannel(clanData.remainAttackChannelId, nextId);
    bossChannel.attachMessage(new FakeEditableMessage("111"));
    summaryChannel.attachMessage(new FakeEditableMessage("211"));
    const gateway = new FakeDiscordGateway();
    [bossChannel, summaryChannel, remainChannel].forEach((channel) => gateway.registerChannel(channel));

    const result = await service.finish({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      member: { id: playerData.userId, displayName: "Alice" },
      damage: 234_567,
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    const clanRow = database
      .prepare<[], { remain_attack_message_id: bigint | null }>(
        "select remain_attack_message_id from ClanData where category_id=223456789012345678",
      )
      .get();

    expect(result?.attacked).toBe(true);
    expect(remainChannel.sentMessages).toHaveLength(1);
    expect(clanData.remainAttackMessageId).toBe(remainChannel.sentMessages[0]?.id);
    expect(clanRow?.remain_attack_message_id?.toString()).toBe(clanData.remainAttackMessageId);
  });

  it("recreates a missing progress message and consumes the oldest carryover on finish", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new AttackService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
      redrawRetryDelayMs: 0,
    });

    const clanData = createClanData();
    seedLapOneState(database, clanData);
    const newerCarryOver = new CarryOver({
      attackType: AttackType.BATTLE,
      bossIndex: 1,
      created: new Date("2026-03-07T13:00:00+09:00"),
    });
    const olderCarryOver = new CarryOver({
      attackType: AttackType.BATTLE,
      bossIndex: 0,
      created: new Date("2026-03-07T12:00:00+09:00"),
    });
    const playerData = new PlayerData({
      userId: "333",
      carryOverList: [newerCarryOver, olderCarryOver],
    });
    seedPlayer(database, clanData, playerData);
    seedDeclaredAttack(database, clanData, playerData, AttackType.CARRYOVER, {
      carryOver: true,
      damage: 100_000,
    });
    runtimeStateService.set(clanData);

    const nextId = createSnowflakeFactory();
    const responseChannel = new FakeTextChannel("response", nextId);
    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!, nextId);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId, nextId);
    const remainChannel = new FakeTextChannel(clanData.remainAttackChannelId, nextId);
    summaryChannel.attachMessage(new FakeEditableMessage("211"));
    remainChannel.attachMessage(new FakeEditableMessage(clanData.remainAttackMessageId!));
    const gateway = new FakeDiscordGateway();
    [bossChannel, summaryChannel, remainChannel].forEach((channel) => gateway.registerChannel(channel));

    await service.finish({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      member: { id: playerData.userId, displayName: "Alice" },
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    const progressRow = database
      .prepare<[], { boss1: bigint }>("select boss1 from ProgressMessageIdData where lap=1")
      .get();
    const carryOverRow = database
      .prepare<[], { count: bigint; created: string | null }>(
        "select count(*) as count, min(created) as created from CarryOver",
      )
      .get();

    expect(bossChannel.sentMessages).toHaveLength(1);
    expect(bossChannel.sentMessages[0]?.edits[0]?.components).toHaveLength(2);
    expect(clanData.progressMessageIdsByLap.get(1)?.[0]).toBe(bossChannel.sentMessages[0]?.id);
    expect(progressRow?.boss1.toString()).toBe(bossChannel.sentMessages[0]?.id);
    expect(carryOverRow?.count).toBe(1n);
    expect(carryOverRow?.created).toBe("2026-03-07 13:00:00.000000+09:00");
    expect(playerData.carryOverList).toEqual([newerCarryOver]);
  });

  it("recreates only the missing summary message on finish", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new AttackService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
      redrawRetryDelayMs: 0,
    });

    const clanData = createClanData();
    seedLapOneState(database, clanData);
    const playerData = new PlayerData({ userId: "333", physicsAttack: 1 });
    seedPlayer(database, clanData, playerData);
    seedDeclaredAttack(database, clanData, playerData, AttackType.BATTLE, { damage: 123_456 });
    runtimeStateService.set(clanData);

    const nextId = createSnowflakeFactory();
    const responseChannel = new FakeTextChannel("response", nextId);
    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!, nextId);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId, nextId);
    const remainChannel = new FakeTextChannel(clanData.remainAttackChannelId, nextId);
    bossChannel.attachMessage(new FakeEditableMessage("111"));
    remainChannel.attachMessage(new FakeEditableMessage(clanData.remainAttackMessageId!));
    const gateway = new FakeDiscordGateway();
    [bossChannel, summaryChannel, remainChannel].forEach((channel) => gateway.registerChannel(channel));

    const result = await service.finish({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      member: { id: playerData.userId, displayName: "Alice" },
      damage: 234_567,
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    const summaryRow = database
      .prepare<[], { boss1: bigint | null }>("select boss1 from SummaryMessageIdData where lap=1")
      .get();

    expect(result?.attacked).toBe(true);
    expect(summaryChannel.sentMessages).toHaveLength(1);
    expect(clanData.summaryMessageIdsByLap.get(1)?.[0]).toBe(summaryChannel.sentMessages[0]?.id);
    expect(summaryRow?.boss1?.toString()).toBe(summaryChannel.sentMessages[0]?.id);
  });

  it("corrects a declared attack from battle to carryover when a carryover is available", async () => {
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
    bossOneChannel.attachMessage(new FakeEditableMessage("111"));
    bossTwoChannel.attachMessage(new FakeEditableMessage("112"));
    summaryChannel.attachMessage(new FakeEditableMessage("211"));
    summaryChannel.attachMessage(new FakeEditableMessage("212"));
    remainChannel.attachMessage(new FakeEditableMessage(clanData.remainAttackMessageId!));
    const gateway = new FakeDiscordGateway();
    [bossOneChannel, bossTwoChannel, summaryChannel, remainChannel].forEach((channel) =>
      gateway.registerChannel(channel),
    );

    await service.declare({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      member: { id: playerData.userId, displayName: "Alice" },
      attackType: ATTACK_TYPE_INPUTS.BATTLE,
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });
    await service.defeatBoss({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      member: { id: playerData.userId, displayName: "Alice" },
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });
    await service.declare({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[1]!,
      member: { id: playerData.userId, displayName: "Alice" },
      attackType: ATTACK_TYPE_INPUTS.BATTLE,
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    responseChannel.sentPayloads.length = 0;

    const result = await service.correctAttackKind({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[1]!,
      lap: 1,
      bossNumber: 2,
      member: { id: playerData.userId, displayName: "Alice" },
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    const correctedAttackEntryRow = database
      .prepare<[], { kind: string; status: string }>(
        "select kind, status from AttackEntry where lap=1 and boss_index=1",
      )
      .get();
    const correctedOperationLogRows = database
      .prepare<[], { operation_type: string; before_kind: string | null; after_kind: string | null }>(
        "select operation_type, before_kind, after_kind from OperationLog where lap=1 and boss_index=1 order by occurred_at asc, operation_id asc",
      )
      .all();
    const correctedAttackStatus = clanData.bossStatusByLap.get(1)?.[1]?.attackPlayers[0];

    expect(result).toBe(true);
    expect(correctedAttackEntryRow).toEqual({
      kind: "carryover",
      status: "declared",
    });
    expect(correctedOperationLogRows).toEqual([
      {
        operation_type: "declare",
        before_kind: null,
        after_kind: "battle",
      },
      {
        operation_type: "correct_kind",
        before_kind: "battle",
        after_kind: "carryover",
      },
    ]);
    expect(correctedAttackStatus?.attackType).toBe(AttackType.CARRYOVER);
    expect(correctedAttackStatus?.carryOver).toBe(true);
    expect(
      runtimeStateService
        .getPlayerResourceState(clanData.categoryId, playerData.userId, clanData.date)
        ?.toRecord(),
    ).toEqual({
      categoryId: clanData.categoryId,
      userId: playerData.userId,
      dayKey: clanData.date,
      battleReservedCount: 0,
      battleConsumedCount: 1,
      carryAvailableCount: 0,
      carryReservedCount: 1,
    });
    expect(responseChannel.sentPayloads).toHaveLength(1);
    expect(responseChannel.sentPayloads[0]?.content).toContain("Alice");
  });

  it("rejects correcting a declared attack to carryover when no carryover is available", async () => {
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
    runtimeStateService.set(clanData);

    const nextId = createSnowflakeFactory();
    const responseChannel = new FakeTextChannel("response", nextId);
    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!, nextId);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId, nextId);
    const remainChannel = new FakeTextChannel(clanData.remainAttackChannelId, nextId);
    const lapOneProgressMessage = new FakeEditableMessage("111");
    bossChannel.attachMessage(lapOneProgressMessage);
    summaryChannel.attachMessage(new FakeEditableMessage("211"));
    remainChannel.attachMessage(new FakeEditableMessage(clanData.remainAttackMessageId!));
    const gateway = new FakeDiscordGateway();
    [bossChannel, summaryChannel, remainChannel].forEach((channel) => gateway.registerChannel(channel));

    await service.declare({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      member: { id: playerData.userId, displayName: "Alice" },
      attackType: ATTACK_TYPE_INPUTS.BATTLE,
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    responseChannel.sentPayloads.length = 0;

    const result = await service.correctAttackKind({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      lap: 1,
      bossNumber: 1,
      member: { id: playerData.userId, displayName: "Alice" },
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    const correctedAttackEntryRow = database
      .prepare<[], { kind: string; status: string }>(
        "select kind, status from AttackEntry where lap=1 and boss_index=0",
      )
      .get();
    const operationLogRows = database
      .prepare<[], { count: bigint }>("select count(*) as count from OperationLog")
      .get();
    const correctedAttackStatus = clanData.bossStatusByLap.get(1)?.[0]?.attackPlayers[0];

    expect(result).toBe(false);
    expect(correctedAttackEntryRow).toEqual({
      kind: "battle",
      status: "declared",
    });
    expect(operationLogRows?.count).toBe(1n);
    expect(correctedAttackStatus?.attackType).toBe(AttackType.BATTLE);
    expect(correctedAttackStatus?.carryOver).toBe(false);
    expect(
      runtimeStateService
        .getPlayerResourceState(clanData.categoryId, playerData.userId, clanData.date)
        ?.toRecord(),
    ).toEqual({
      categoryId: clanData.categoryId,
      userId: playerData.userId,
      dayKey: clanData.date,
      battleReservedCount: 1,
      battleConsumedCount: 0,
      carryAvailableCount: 0,
      carryReservedCount: 0,
    });
    expect(responseChannel.sentPayloads).toEqual([
      {
        content: "その入替えでは本戦数または持越数の整合が取れません",
      },
    ]);
  });

  it("treats old-day correction targets as nothing after JST 5:00 rollover", async () => {
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
    seedDeclaredAttack(database, clanData, playerData, AttackType.BATTLE, {
      created: "2026-03-08T00:00:00+09:00",
    });
    attackEntryRepository.insert(
      new AttackEntry({
        attackEntryId: "attack-old-day-correct",
        categoryId: clanData.categoryId,
        userId: playerData.userId,
        dayKey: "2026-03-08",
        lap: 1,
        bossIndex: 0,
        kind: AttackEntryKind.BATTLE,
        status: AttackEntryStatus.DECLARED,
        declaredAt: new Date("2026-03-08T00:00:00+09:00"),
      }),
    );
    operationLogRepository.insert(
      new OperationLog({
        operationId: "operation-old-day-correct",
        categoryId: clanData.categoryId,
        userId: playerData.userId,
        dayKey: "2026-03-08",
        lap: 1,
        bossIndex: 0,
        targetAttackEntryId: "attack-old-day-correct",
        operationType: OperationLogType.DECLARE,
        afterKind: AttackEntryKind.BATTLE,
        afterStatus: AttackEntryStatus.DECLARED,
        occurredAt: new Date("2026-03-08T00:00:00+09:00"),
      }),
    );
    runtimeStateService.set(clanData);

    const nextId = createSnowflakeFactory();
    const responseChannel = new FakeTextChannel("response", nextId);
    const remainChannel = new FakeTextChannel(clanData.remainAttackChannelId, nextId);
    remainChannel.attachMessage(new FakeEditableMessage(clanData.remainAttackMessageId!));
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(remainChannel);

    const result = await service.correctAttackKind({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      lap: 1,
      bossNumber: 1,
      member: { id: playerData.userId, displayName: "Alice" },
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    expect(result).toBe(false);
    expect(responseChannel.sentPayloads).toEqual([{ content: CORRECT_ATTACK_KIND_NOTHING_MESSAGE }]);
    expect(runtimeStateService.getAttackEntries(clanData.categoryId)).toHaveLength(0);
    expect(
      database
        .prepare<[], { count: bigint }>("select count(*) as count from AttackEntry")
        .get()?.count,
    ).toBe(0n);
  });

  it("defeats a boss, creates next lap progress state, and grants carryover", async () => {
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
    const playerData = new PlayerData({ userId: "333", physicsAttack: 2 });
    seedPlayer(database, clanData, playerData);
    seedDeclaredAttack(database, clanData, playerData, AttackType.BATTLE, { damage: 600_000 });
    runtimeStateService.set(clanData);

    const nextId = createSnowflakeFactory();
    const responseChannel = new FakeTextChannel("response", nextId);
    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!, nextId);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId, nextId);
    const remainChannel = new FakeTextChannel(clanData.remainAttackChannelId, nextId);
    const lapOneProgressMessage = new FakeEditableMessage("111");
    bossChannel.attachMessage(lapOneProgressMessage);
    summaryChannel.attachMessage(new FakeEditableMessage("211"));
    remainChannel.attachMessage(new FakeEditableMessage(clanData.remainAttackMessageId!));
    const gateway = new FakeDiscordGateway();
    [bossChannel, summaryChannel, remainChannel].forEach((channel) => gateway.registerChannel(channel));

    const result = await service.defeatBoss({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      member: { id: playerData.userId, displayName: "Alice" },
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    const bossStatusRow = database
      .prepare<[], { count: bigint; beated: bigint }>(
        "select count(*) as count, max(beated) as beated from BossStatusData",
      )
      .get();
    const progressRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from ProgressMessageIdData")
      .get();
    const summaryRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from SummaryMessageIdData")
      .get();
    const carryOverRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from CarryOver")
      .get();
    const attackEntryRows = database
      .prepare<[], { user_id: bigint; status: string }>(
        "select user_id, status from AttackEntry order by user_id asc",
      )
      .all();
    const operationLogRows = database
      .prepare<[], { operation_type: string }>(
        "select operation_type from OperationLog order by occurred_at asc, operation_id asc",
      )
      .all();

    expect(result?.attacked).toBe(true);
    expect(clanData.bossStatusByLap.get(1)?.[0]?.beated).toBe(true);
    expect(clanData.bossStatusByLap.has(2)).toBe(true);
    expect(playerData.physicsAttack).toBe(3);
    expect(playerData.carryOverList).toHaveLength(1);
    expect(bossStatusRow?.count).toBe(10n);
    expect(bossStatusRow?.beated).toBe(1n);
    expect(progressRow?.count).toBe(2n);
    expect(summaryRow?.count).toBe(1n);
    expect(carryOverRow?.count).toBe(1n);
    expect(attackEntryRows).toEqual([
      { user_id: 333n, status: "defeated" },
    ]);
    expect(operationLogRows.map((row) => row.operation_type)).toEqual(["defeat"]);
    expect(bossChannel.sentMessages).toHaveLength(1);
    expect(lapOneProgressMessage.edits.at(-1)?.components).toEqual([]);
    expect(bossChannel.sentMessages[0]?.edits[0]?.components).toHaveLength(2);
    expect(summaryChannel.sentMessages).toHaveLength(0);
    expect(summaryChannel.messages.get("211")?.edits).toHaveLength(1);
    expect(clanData.progressMessageIdsByLap.get(2)?.[0]).toBe(bossChannel.sentMessages[0]?.id);
    expect(responseChannel.sentPayloads).toHaveLength(1);
    expect(responseChannel.sentPayloads[0]?.content).toContain("Alice");
    expect(
      runtimeStateService
        .getPlayerResourceState(clanData.categoryId, playerData.userId, clanData.date)
        ?.toRecord(),
    ).toEqual({
      categoryId: clanData.categoryId,
      userId: playerData.userId,
      dayKey: clanData.date,
      battleReservedCount: 0,
      battleConsumedCount: 1,
      carryAvailableCount: 1,
      carryReservedCount: 0,
    });
  });

  it("expires other declared attacks in the new projected state when a boss is defeated", async () => {
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
    const alice = new PlayerData({ userId: "333", physicsAttack: 2 });
    const bob = new PlayerData({ userId: "444" });
    seedPlayer(database, clanData, alice);
    seedPlayer(database, clanData, bob);
    seedDeclaredAttack(database, clanData, alice, AttackType.BATTLE, { damage: 600_000 });
    seedDeclaredAttack(database, clanData, bob, AttackType.BATTLE, {
      damage: 123_456,
      created: "2026-03-08T00:01:00+09:00",
    });
    runtimeStateService.set(clanData);

    const nextId = createSnowflakeFactory();
    const responseChannel = new FakeTextChannel("response", nextId);
    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!, nextId);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId, nextId);
    const remainChannel = new FakeTextChannel(clanData.remainAttackChannelId, nextId);
    const lapOneProgressMessage = new FakeEditableMessage("111");
    bossChannel.attachMessage(lapOneProgressMessage);
    summaryChannel.attachMessage(new FakeEditableMessage("211"));
    remainChannel.attachMessage(new FakeEditableMessage(clanData.remainAttackMessageId!));
    const gateway = new FakeDiscordGateway();
    [bossChannel, summaryChannel, remainChannel].forEach((channel) => gateway.registerChannel(channel));

    await service.defeatBoss({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      member: { id: alice.userId, displayName: "Alice" },
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([
        [alice.userId, "Alice"],
        [bob.userId, "Bob"],
      ]),
    });

    const attackEntryRows = database
      .prepare<[], { user_id: bigint; status: string }>(
        "select user_id, status from AttackEntry order by user_id asc",
      )
      .all();
    const operationLogRows = database
      .prepare<[], { user_id: bigint; operation_type: string }>(
        "select user_id, operation_type from OperationLog order by user_id asc, operation_type asc",
      )
      .all();

    expect(attackEntryRows).toEqual([
      { user_id: 333n, status: "defeated" },
      { user_id: 444n, status: "expired" },
    ]);
    expect(operationLogRows).toEqual([
      { user_id: 333n, operation_type: "defeat" },
      { user_id: 444n, operation_type: "expire" },
    ]);
    expect(
      runtimeStateService
        .getPlayerResourceState(clanData.categoryId, bob.userId, clanData.date)
        ?.toRecord(),
    ).toEqual({
      categoryId: clanData.categoryId,
      userId: bob.userId,
      dayKey: clanData.date,
      battleReservedCount: 0,
      battleConsumedCount: 0,
      carryAvailableCount: 0,
      carryReservedCount: 0,
    });
  });

  it("creates a new remain-attack message on day rollover before declare", async () => {
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
    new ClanRepository(database).insert(clanData);
    seedLapOneState(database, clanData);
    const playerData = new PlayerData({ userId: "333" });
    seedPlayer(database, clanData, playerData);
    clanData.date = "2026-03-07";
    runtimeStateService.set(clanData);

    const nextId = createSnowflakeFactory();
    const responseChannel = new FakeTextChannel("response", nextId);
    const remainChannel = new FakeTextChannel(clanData.remainAttackChannelId, nextId);
    const oldRemainMessage = new FakeEditableMessage(clanData.remainAttackMessageId!);
    remainChannel.attachMessage(oldRemainMessage);
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(remainChannel);

    const result = await service.declare({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      member: { id: playerData.userId, displayName: "Alice" },
      attackType: ATTACK_TYPE_INPUTS.BATTLE,
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    const clanRow = database
      .prepare<[], { remain_attack_message_id: bigint | null; day: string }>(
        "select remain_attack_message_id, day from ClanData where category_id=223456789012345678",
      )
      .get();

    expect(result).not.toBeNull();
    expect(clanData.date).toBe("2026-03-08");
    expect(oldRemainMessage.edits).toHaveLength(0);
    expect(remainChannel.sentMessages).toHaveLength(1);
    expect(remainChannel.sentMessages[0]?.reactions).toEqual(["💀"]);
    expect(remainChannel.sentMessages[0]?.edits).toHaveLength(1);
    expect(clanData.remainAttackMessageId).toBe(remainChannel.sentMessages[0]?.id);
    expect(clanRow?.remain_attack_message_id?.toString()).toBe(clanData.remainAttackMessageId);
    expect(clanRow?.day).toBe("2026-03-08");
  });

  it("does not create a duplicate remain-attack message when reaction add fails during rollover", async () => {
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
    new ClanRepository(database).insert(clanData);
    seedLapOneState(database, clanData);
    const playerData = new PlayerData({ userId: "333" });
    seedPlayer(database, clanData, playerData);
    clanData.date = "2026-03-07";
    runtimeStateService.set(clanData);

    const nextId = createSnowflakeFactory();
    const responseChannel = new FakeTextChannel("response", nextId);
    const remainChannel = new FakeReactionFailingTextChannel(clanData.remainAttackChannelId, nextId);
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(remainChannel);

    await service.declare({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      member: { id: playerData.userId, displayName: "Alice" },
      attackType: ATTACK_TYPE_INPUTS.BATTLE,
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    await service.finish({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      member: { id: playerData.userId, displayName: "Alice" },
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
      selectCarryOver: async () => null,
    });

    const clanRow = database
      .prepare<[], { remain_attack_message_id: bigint | null }>(
        "select remain_attack_message_id from ClanData where category_id=223456789012345678",
      )
      .get();

    expect(remainChannel.sentMessages).toHaveLength(1);
    expect(remainChannel.sentMessages[0]?.reactions).toEqual([]);
    expect(clanData.remainAttackMessageId).toBe(remainChannel.sentMessages[0]?.id);
    expect(clanRow?.remain_attack_message_id?.toString()).toBe(clanData.remainAttackMessageId);
  });
});
