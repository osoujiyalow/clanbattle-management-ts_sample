import { afterEach, describe, expect, it } from "vitest";

import {
  AttackEntry,
  AttackEntryKind,
  AttackEntryStatus,
} from "../../../../src/domain/attack-entry.js";
import { AttackStatus } from "../../../../src/domain/attack-status.js";
import { AttackType } from "../../../../src/domain/attack-type.js";
import { USER_MESSAGES } from "../../../../src/constants/messages.js";
import { ClanData } from "../../../../src/domain/clan-data.js";
import { OperationLog, OperationLogType } from "../../../../src/domain/operation-log.js";
import { PlayerData } from "../../../../src/domain/player-data.js";
import { PlayerResourceState } from "../../../../src/domain/player-resource-state.js";
import { ResourceAdjustmentType } from "../../../../src/domain/resource-adjustment.js";
import { AttackEntryRepository } from "../../../../src/repositories/sqlite/attack-entry-repository.js";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
  type SqliteDatabase,
} from "../../../../src/repositories/sqlite/db.js";
import { AttackStatusRepository } from "../../../../src/repositories/sqlite/attack-status-repository.js";
import {
  ProgressMessageIdRepository,
  SummaryMessageIdRepository,
} from "../../../../src/repositories/sqlite/boss-message-id-repository.js";
import { BossStatusRepository } from "../../../../src/repositories/sqlite/boss-status-repository.js";
import { ClanRepository } from "../../../../src/repositories/sqlite/clan-repository.js";
import { OperationLogRepository } from "../../../../src/repositories/sqlite/operation-log-repository.js";
import { PlayerRepository } from "../../../../src/repositories/sqlite/player-repository.js";
import { PlayerResourceStateRepository } from "../../../../src/repositories/sqlite/player-resource-state-repository.js";
import {
  ClanQueryService,
  type ClanQueryDiscordGateway,
  type ClanQueryEditableMessage,
  type ClanQueryResponseChannel,
  type ClanQueryTextChannel,
} from "../../../../src/services/clan-query-service.js";
import { RuntimeStateService } from "../../../../src/services/runtime-state-service.js";
import { createFixedClock } from "../../../../src/shared/time.js";
import { createCoreRepositorySchema } from "../../../unit/repositories/sqlite/core-repository-schema.js";
import { createTempSqlitePath, type TempSqlitePath } from "../../../unit/repositories/sqlite/test-sqlite-path.js";

class FakeMessage implements ClanQueryEditableMessage {
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

  async delete(): Promise<void> {
    this.deleted = true;
    this.owner?.messages.delete(this.id);
  }

  async addReaction(emoji: string): Promise<void> {
    this.reactions.push(emoji);
  }
}

class FakeTextChannel implements ClanQueryTextChannel, ClanQueryResponseChannel {
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

    if (payload.embeds || payload.components) {
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

class FakeDiscordGateway implements ClanQueryDiscordGateway {
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

function createSnowflakeFactory(start = 900000000000000000n): () => string {
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

function seedLap(database: SqliteDatabase, clanData: ClanData, lap: number): void {
  new BossStatusRepository(database).insertAllForLap(clanData.categoryId, clanData.bossStatusByLap.get(lap)!);
  new ProgressMessageIdRepository(database).insert(
    clanData.categoryId,
    lap,
    clanData.progressMessageIdsByLap.get(lap)!,
  );
  if (clanData.summaryMessageIdsByLap.has(lap)) {
    new SummaryMessageIdRepository(database).insert(
      clanData.categoryId,
      lap,
      clanData.summaryMessageIdsByLap.get(lap)!,
    );
  }
}

function seedPlayer(database: SqliteDatabase, clanData: ClanData, playerData: PlayerData): void {
  clanData.addPlayerData(playerData);
  const repository = new PlayerRepository(database);
  repository.insertMany(clanData.categoryId, [playerData]);
  repository.update(clanData.categoryId, playerData);
}

describe("ClanQueryService", () => {
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

  it("resets all progress to the requested lap and reuses the current summary message", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new ClanQueryService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    seedLap(database, clanData, 1);
    const playerData = new PlayerData({ userId: "333", physicsAttack: 1 });
    seedPlayer(database, clanData, playerData);
    const attackStatus = new AttackStatus({
      playerData,
      attackType: AttackType.BATTLE,
      carryOver: false,
      attacked: true,
      damage: 123456,
      created: new Date("2026-03-08T00:00:00+09:00"),
    });
    clanData.bossStatusByLap.get(1)![0]!.attackPlayers.push(attackStatus);
    new AttackStatusRepository(database).insert(clanData.categoryId, 1, 0, attackStatus);
    new AttackEntryRepository(database).insert(
      new AttackEntry({
        attackEntryId: "attack-1",
        categoryId: clanData.categoryId,
        userId: playerData.userId,
        dayKey: clanData.date,
        lap: 1,
        bossIndex: 0,
        kind: AttackEntryKind.BATTLE,
        status: AttackEntryStatus.FINISHED,
        declaredAt: new Date("2026-03-08T00:00:00+09:00"),
        resolvedAt: new Date("2026-03-08T00:01:00+09:00"),
        damage: 123456,
      }),
    );
    new OperationLogRepository(database).insert(
      new OperationLog({
        operationId: "operation-1",
        categoryId: clanData.categoryId,
        userId: playerData.userId,
        dayKey: clanData.date,
        lap: 1,
        bossIndex: 0,
        targetAttackEntryId: "attack-1",
        operationType: OperationLogType.FINISH,
        beforeKind: AttackEntryKind.BATTLE,
        afterKind: AttackEntryKind.BATTLE,
        beforeStatus: AttackEntryStatus.DECLARED,
        afterStatus: AttackEntryStatus.FINISHED,
        occurredAt: new Date("2026-03-08T00:01:00+09:00"),
      }),
    );
    new PlayerResourceStateRepository(database).insert(
      new PlayerResourceState({
        categoryId: clanData.categoryId,
        userId: playerData.userId,
        dayKey: clanData.date,
        battleReservedCount: 0,
        battleConsumedCount: 1,
        carryAvailableCount: 0,
        carryReservedCount: 0,
      }),
    );
    runtimeStateService.set(clanData);

    const nextId = createSnowflakeFactory();
    const responseChannel = new FakeTextChannel("response", nextId);
    const remainChannel = new FakeTextChannel(clanData.remainAttackChannelId, nextId);
    remainChannel.attachMessage(new FakeMessage(clanData.remainAttackMessageId!));
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId, nextId);
    const summaryMessage = new FakeMessage("211");
    summaryChannel.attachMessage(summaryMessage);
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(remainChannel);
    gateway.registerChannel(summaryChannel);

    for (const channelId of clanData.bossChannelIds) {
      gateway.registerChannel(new FakeTextChannel(channelId, nextId));
    }

    const result = await service.setLap({
      categoryId: clanData.categoryId,
      channelId: clanData.commandChannelId,
      lap: 3,
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    const attackRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from AttackStatus")
      .get();
    const bossStatusRow = database
      .prepare<[], { count: bigint; min_lap: bigint; max_lap: bigint }>(
        "select count(*) as count, min(lap) as min_lap, max(lap) as max_lap from BossStatusData",
      )
      .get();
    const progressRow = database
      .prepare<[], { count: bigint; min_lap: bigint; max_lap: bigint }>(
        "select count(*) as count, min(lap) as min_lap, max(lap) as max_lap from ProgressMessageIdData",
      )
      .get();
    const summaryRow = database
      .prepare<[], { count: bigint; min_lap: bigint; max_lap: bigint }>(
        "select count(*) as count, min(lap) as min_lap, max(lap) as max_lap from SummaryMessageIdData",
      )
      .get();
    const attackEntryRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from AttackEntry")
      .get();
    const operationLogRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from OperationLog")
      .get();
    const playerResourceStateRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from PlayerResourceState")
      .get();

    expect(result).toBe(true);
    expect(responseChannel.sentPayloads).toEqual([
      { content: "\u5468\u56de\u6570\u30923\u306b\u8a2d\u5b9a\u3057\u307e\u3059" },
    ]);
    expect(attackRow?.count).toBe(0n);
    expect(attackEntryRow?.count).toBe(0n);
    expect(operationLogRow?.count).toBe(0n);
    expect(playerResourceStateRow?.count).toBe(0n);
    expect(bossStatusRow?.count).toBe(5n);
    expect(bossStatusRow?.min_lap).toBe(3n);
    expect(bossStatusRow?.max_lap).toBe(3n);
    expect(progressRow?.count).toBe(1n);
    expect(progressRow?.min_lap).toBe(3n);
    expect(progressRow?.max_lap).toBe(3n);
    expect(summaryRow?.count).toBe(1n);
    expect(summaryRow?.min_lap).toBe(3n);
    expect(summaryRow?.max_lap).toBe(3n);
    expect(clanData.progressMessageIdsByLap.size).toBe(1);
    expect(clanData.progressMessageIdsByLap.has(3)).toBe(true);
    expect(clanData.summaryMessageIdsByLap.size).toBe(1);
    expect(clanData.summaryMessageIdsByLap.has(3)).toBe(true);
    expect(clanData.bossStatusByLap.size).toBe(1);
    expect(clanData.bossStatusByLap.has(3)).toBe(true);
    expect(playerData.battleAttackCount).toBe(0);
    expect(playerData.carryOverList).toHaveLength(0);
    expect(playerData.log).toHaveLength(0);
    expect(summaryChannel.sentMessages).toHaveLength(0);
    expect(summaryMessage.edits).toHaveLength(1);
    expect(remainChannel.messages.get(clanData.remainAttackMessageId!)?.edits).toHaveLength(1);
    expect(remainChannel.messages.get(clanData.remainAttackMessageId!)?.edits[0]?.components).toEqual([]);

    for (const channelId of clanData.bossChannelIds) {
      const bossChannel = await gateway.getTextChannel(channelId);
      expect(bossChannel.sentMessages).toHaveLength(1);
      expect(bossChannel.sentMessages[0]?.edits[0]?.components).toHaveLength(2);
    }
  });

  it("resets only one boss progress to a target lap and retargets the current summary row", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new ClanQueryService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    seedLap(database, clanData, 1);
    const playerData = new PlayerData({ userId: "333", magicAttack: 1 });
    seedPlayer(database, clanData, playerData);
    new AttackEntryRepository(database).insert(
      new AttackEntry({
        attackEntryId: "attack-boss1",
        categoryId: clanData.categoryId,
        userId: playerData.userId,
        dayKey: clanData.date,
        lap: 1,
        bossIndex: 0,
        kind: AttackEntryKind.BATTLE,
        status: AttackEntryStatus.FINISHED,
        declaredAt: new Date("2026-03-08T00:00:00+09:00"),
        resolvedAt: new Date("2026-03-08T00:01:00+09:00"),
        damage: 111111,
      }),
    );
    new AttackEntryRepository(database).insert(
      new AttackEntry({
        attackEntryId: "attack-boss2",
        categoryId: clanData.categoryId,
        userId: playerData.userId,
        dayKey: clanData.date,
        lap: 1,
        bossIndex: 1,
        kind: AttackEntryKind.BATTLE,
        status: AttackEntryStatus.FINISHED,
        declaredAt: new Date("2026-03-08T00:02:00+09:00"),
        resolvedAt: new Date("2026-03-08T00:03:00+09:00"),
        damage: 222222,
      }),
    );
    new OperationLogRepository(database).insert(
      new OperationLog({
        operationId: "operation-boss1",
        categoryId: clanData.categoryId,
        userId: playerData.userId,
        dayKey: clanData.date,
        lap: 1,
        bossIndex: 0,
        targetAttackEntryId: "attack-boss1",
        operationType: OperationLogType.FINISH,
        beforeKind: AttackEntryKind.BATTLE,
        afterKind: AttackEntryKind.BATTLE,
        beforeStatus: AttackEntryStatus.DECLARED,
        afterStatus: AttackEntryStatus.FINISHED,
        occurredAt: new Date("2026-03-08T00:01:00+09:00"),
      }),
    );
    new OperationLogRepository(database).insert(
      new OperationLog({
        operationId: "operation-boss2",
        categoryId: clanData.categoryId,
        userId: playerData.userId,
        dayKey: clanData.date,
        lap: 1,
        bossIndex: 1,
        targetAttackEntryId: "attack-boss2",
        operationType: OperationLogType.FINISH,
        beforeKind: AttackEntryKind.BATTLE,
        afterKind: AttackEntryKind.BATTLE,
        beforeStatus: AttackEntryStatus.DECLARED,
        afterStatus: AttackEntryStatus.FINISHED,
        occurredAt: new Date("2026-03-08T00:03:00+09:00"),
      }),
    );
    new PlayerResourceStateRepository(database).insert(
      new PlayerResourceState({
        categoryId: clanData.categoryId,
        userId: playerData.userId,
        dayKey: clanData.date,
        battleReservedCount: 0,
        battleConsumedCount: 2,
        carryAvailableCount: 0,
        carryReservedCount: 0,
      }),
    );
    playerData.battleAttackCount = 2;
    runtimeStateService.set(clanData);

    const nextId = createSnowflakeFactory();
    const responseChannel = new FakeTextChannel("response", nextId);
    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!, nextId);
    bossChannel.attachMessage(new FakeMessage("111"));
    const remainChannel = new FakeTextChannel(clanData.remainAttackChannelId, nextId);
    remainChannel.attachMessage(new FakeMessage(clanData.remainAttackMessageId!));
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId, nextId);
    const summaryMessage = new FakeMessage("211");
    summaryChannel.attachMessage(summaryMessage);
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(bossChannel);
    gateway.registerChannel(remainChannel);
    gateway.registerChannel(summaryChannel);

    const result = await service.setLap({
      categoryId: clanData.categoryId,
      channelId: clanData.commandChannelId,
      lap: 2,
      bossNumber: 1,
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    const lap1Row = database
      .prepare<[], { boss1: bigint | null }>("select boss1 from ProgressMessageIdData where lap=1")
      .get();
    const lap2Row = database
      .prepare<[], { boss1: bigint | null }>("select boss1 from ProgressMessageIdData where lap=2")
      .get();
    const summaryCount = database
      .prepare<[], { count: bigint }>("select count(*) as count from SummaryMessageIdData")
      .get();
    const lap2SummaryRow = database
      .prepare<[], { boss1: bigint | null }>("select boss1 from SummaryMessageIdData where lap=2")
      .get();
    const bossStatusCount = database
      .prepare<[], { count: bigint }>("select count(*) as count from BossStatusData")
      .get();
    const attackEntryRows = database
      .prepare<[], { attack_entry_id: string; boss_index: bigint }>(
        "select attack_entry_id, boss_index from AttackEntry order by attack_entry_id asc",
      )
      .all();
    const operationLogRows = database
      .prepare<[], { operation_id: string; boss_index: bigint }>(
        "select operation_id, boss_index from OperationLog order by operation_id asc",
      )
      .all();

    expect(result).toBe(true);
    expect(responseChannel.sentPayloads).toEqual([
      { content: "1\u30dc\u30b9\u306e\u307f\u5468\u56de\u6570\u30922\u306b\u8a2d\u5b9a\u3057\u307e\u3059" },
    ]);
    expect(bossChannel.sentMessages).toHaveLength(1);
    expect(bossChannel.sentMessages[0]?.edits[0]?.components).toHaveLength(2);
    expect(lap1Row?.boss1).toBeNull();
    expect(lap2Row?.boss1?.toString()).toBe(bossChannel.sentMessages[0]?.id);
    expect(summaryCount?.count).toBe(1n);
    expect(lap2SummaryRow?.boss1?.toString()).toBe(summaryMessage.id);
    expect(summaryChannel.sentMessages).toHaveLength(0);
    expect(summaryMessage.edits).toHaveLength(1);
    expect(bossStatusCount?.count).toBe(9n);
    expect(attackEntryRows).toEqual([
      {
        attack_entry_id: "attack-boss2",
        boss_index: 1n,
      },
    ]);
    expect(operationLogRows).toEqual([
      {
        operation_id: "operation-boss2",
        boss_index: 1n,
      },
    ]);
    expect(clanData.progressMessageIdsByLap.get(1)?.[0]).toBeNull();
    expect(clanData.progressMessageIdsByLap.get(2)?.[0]).toBe(bossChannel.sentMessages[0]?.id);
    expect(clanData.summaryMessageIdsByLap.get(2)?.[0]).toBe(summaryMessage.id);
    expect(playerData.battleAttackCount).toBe(1);
    expect(remainChannel.messages.get(clanData.remainAttackMessageId!)?.edits).toHaveLength(1);
    expect(remainChannel.messages.get(clanData.remainAttackMessageId!)?.edits[0]?.components).toEqual([]);
  });

  it("creates a new remain-attack message on day rollover before set_lap", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new ClanQueryService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    clanData.date = "2026-03-07";
    new ClanRepository(database).insert(clanData);
    seedLap(database, clanData, 1);
    runtimeStateService.set(clanData);

    const nextId = createSnowflakeFactory();
    const responseChannel = new FakeTextChannel("response", nextId);
    const remainChannel = new FakeTextChannel(clanData.remainAttackChannelId, nextId);
    const oldRemainMessage = new FakeMessage(clanData.remainAttackMessageId!);
    remainChannel.attachMessage(oldRemainMessage);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId, nextId);
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(remainChannel);
    gateway.registerChannel(summaryChannel);

    for (const channelId of clanData.bossChannelIds) {
      gateway.registerChannel(new FakeTextChannel(channelId, nextId));
    }

    const result = await service.setLap({
      categoryId: clanData.categoryId,
      channelId: clanData.commandChannelId,
      lap: 2,
      responseChannel,
      discordGateway: gateway,
    });

    const clanRow = database
      .prepare<[], { remain_attack_message_id: bigint | null; day: string }>(
        "select remain_attack_message_id, day from ClanData where category_id=223456789012345678",
      )
      .get();

    expect(result).toBe(true);
    expect(clanData.date).toBe("2026-03-08");
    expect(oldRemainMessage.edits).toHaveLength(0);
    expect(remainChannel.sentMessages).toHaveLength(1);
    expect(remainChannel.sentMessages[0]?.reactions).toEqual(["💀"]);
    expect(remainChannel.sentMessages[0]?.edits).toHaveLength(2);
    expect(remainChannel.sentMessages[0]?.edits[0]?.components).toBeUndefined();
    expect(remainChannel.sentMessages[0]?.edits[1]?.components).toEqual([]);
    expect(clanData.remainAttackMessageId).toBe(remainChannel.sentMessages[0]?.id);
    expect(clanRow?.remain_attack_message_id?.toString()).toBe(clanData.remainAttackMessageId);
    expect(clanRow?.day).toBe("2026-03-08");
  });

  it("formats calc_cot success output with only attack lines and carryover time", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const service = new ClanQueryService({
      database,
      runtimeStateService: new RuntimeStateService({ database }),
    });
    const responseChannel = new FakeTextChannel("response");

    const content = await service.calcCarryOver({
      values: "1200000 300000 450000 600000 100000",
      responseChannel,
    });

    expect(content).toBe("1人目 300000 削り　2人目 450000 削り　3人目 600000 討伐\n持越し 43秒");
    expect(responseChannel.sentPayloads).toEqual([{ content }]);
    const carryOverRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from CarryOver")
      .get();
    expect(carryOverRow?.count).toBe(0n);
  });

  it("formats calc_cot not-killed output", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const service = new ClanQueryService({
      database,
      runtimeStateService: new RuntimeStateService({ database }),
    });
    const responseChannel = new FakeTextChannel("response");

    const content = await service.calcCarryOver({
      values: "1200000 300000 450000",
      responseChannel,
    });

    expect(content).toBe("1人目 300000 削り　2人目 450000 削り");
    expect(responseChannel.sentPayloads).toEqual([{ content }]);
  });

  it("accepts full-width digits, spaces, and commas in calc_cot input", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const service = new ClanQueryService({
      database,
      runtimeStateService: new RuntimeStateService({ database }),
    });
    const responseChannel = new FakeTextChannel("response");

    const content = await service.calcCarryOver({
      values: "１，２００，０００　３００，０００　４５０，０００　６００，０００",
      responseChannel,
    });

    expect(content).toBe("1人目 300000 削り　2人目 450000 削り　3人目 600000 討伐\n持越し 43秒");
    expect(responseChannel.sentPayloads).toEqual([{ content }]);
  });

  it("rejects calc_cot input with malformed numeric tokens", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const service = new ClanQueryService({
      database,
      runtimeStateService: new RuntimeStateService({ database }),
    });
    const responseChannel = new FakeTextChannel("response");

    const content = await service.calcCarryOver({
      values: "1200000 300000abc 450000 600000",
      responseChannel,
    });

    expect(content).toBeNull();
    expect(responseChannel.sentPayloads).toEqual([{ content: USER_MESSAGES.calcCot.nonNumeric }]);
  });

  it("rejects calc_cot input with fewer than two numbers", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const service = new ClanQueryService({
      database,
      runtimeStateService: new RuntimeStateService({ database }),
    });
    const responseChannel = new FakeTextChannel("response");

    const content = await service.calcCarryOver({
      values: "1200000",
      responseChannel,
    });

    expect(content).toBeNull();
    expect(responseChannel.sentPayloads).toEqual([
      {
        content:
          "\u5165\u529b\u5f62\u5f0f\u304c\u4e0d\u6b63\u3067\u3059\u3002\n\u5148\u982d\u306b\u30dc\u30b9HP\u3001\u305d\u306e\u5f8c\u306b\u30c0\u30e1\u30fc\u30b8\u3092\u534a\u89d2\u30b9\u30da\u30fc\u30b9\u533a\u5207\u308a\u3067\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002\n\u4f8b: `1200000 300000 450000 600000`",
      },
    ]);
  });

  it("adjusts remaining battle count through ResourceAdjustmentLog and redraws remain attack", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new ClanQueryService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    new ClanRepository(database).insert(clanData);
    seedLap(database, clanData, 1);
    const playerData = new PlayerData({ userId: "333" });
    seedPlayer(database, clanData, playerData);
    runtimeStateService.set(clanData);
    runtimeStateService.syncProjectedStateForCategory(clanData.categoryId, clanData.date);

    const nextId = createSnowflakeFactory();
    const responseChannel = new FakeTextChannel("response", nextId);
    const remainChannel = new FakeTextChannel(clanData.remainAttackChannelId, nextId);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId, nextId);
    remainChannel.attachMessage(new FakeMessage(clanData.remainAttackMessageId!));
    summaryChannel.attachMessage(new FakeMessage("211"));
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(remainChannel);
    gateway.registerChannel(summaryChannel);

    const result = await service.adjustRemainAttackCount({
      categoryId: clanData.categoryId,
      channelId: clanData.commandChannelId,
      actor: { id: "444", displayName: "Manager" },
      member: { id: playerData.userId, displayName: "Alice" },
      type: ResourceAdjustmentType.BATTLE,
      remaining: 2,
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    const adjustmentRows = database
      .prepare<[], { resource_type: string; remaining: bigint }>(
        "select resource_type, remaining from ResourceAdjustmentLog order by occurred_at asc",
      )
      .all();
    const persistedPlayer = new PlayerRepository(database)
      .findByCategoryId(clanData.categoryId)
      .get(playerData.userId);
    const projectedState = runtimeStateService.getPlayerResourceState(
      clanData.categoryId,
      playerData.userId,
      clanData.date,
    );

    expect(result).toBe(true);
    expect(responseChannel.sentPayloads).toEqual([
      {
        content: "Aliceの本戦凸残数を2に修正します",
      },
    ]);
    expect(adjustmentRows).toEqual([
      {
        resource_type: ResourceAdjustmentType.BATTLE,
        remaining: 2n,
      },
    ]);
    expect(projectedState?.battleConsumedCount).toBe(1);
    expect(projectedState?.battleReservedCount).toBe(0);
    expect(persistedPlayer?.battleAttackCount).toBe(1);
    expect(remainChannel.messages.get(clanData.remainAttackMessageId!)?.edits).toHaveLength(1);
    expect(summaryChannel.messages.get("211")?.edits).toHaveLength(1);
  });

  it("adjusts available carry count and persists synthetic carryovers when needed", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new ClanQueryService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    new ClanRepository(database).insert(clanData);
    seedLap(database, clanData, 1);
    const playerData = new PlayerData({ userId: "333" });
    seedPlayer(database, clanData, playerData);
    runtimeStateService.set(clanData);
    runtimeStateService.syncProjectedStateForCategory(clanData.categoryId, clanData.date);

    const nextId = createSnowflakeFactory();
    const responseChannel = new FakeTextChannel("response", nextId);
    const remainChannel = new FakeTextChannel(clanData.remainAttackChannelId, nextId);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId, nextId);
    remainChannel.attachMessage(new FakeMessage(clanData.remainAttackMessageId!));
    summaryChannel.attachMessage(new FakeMessage("211"));
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(remainChannel);
    gateway.registerChannel(summaryChannel);

    const result = await service.adjustRemainAttackCount({
      categoryId: clanData.categoryId,
      channelId: clanData.commandChannelId,
      actor: { id: "444", displayName: "Manager" },
      member: { id: playerData.userId, displayName: "Alice" },
      type: ResourceAdjustmentType.CARRYOVER,
      remaining: 2,
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    const carryOverRows = database
      .prepare<[], { boss_index: bigint; attack_type: string }>(
        "select boss_index, attack_type from CarryOver where category_id=223456789012345678 and user_id=333 order by created asc",
      )
      .all();
    const projectedState = runtimeStateService.getPlayerResourceState(
      clanData.categoryId,
      playerData.userId,
      clanData.date,
    );

    expect(result).toBe(true);
    expect(responseChannel.sentPayloads).toEqual([
      {
        content: "Aliceの持越凸残数を2に修正します",
      },
    ]);
    expect(projectedState?.carryAvailableCount).toBe(2);
    expect(playerData.carryOverList).toHaveLength(2);
    expect(carryOverRows).toEqual([
      { boss_index: -1n, attack_type: AttackType.BATTLE },
      { boss_index: -1n, attack_type: AttackType.BATTLE },
    ]);
    expect(summaryChannel.messages.get("211")?.edits).toHaveLength(1);
  });

  it("rejects battle adjustment when unresolved battle declarations make the target remaining count impossible", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new ClanQueryService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    new ClanRepository(database).insert(clanData);
    seedLap(database, clanData, 1);
    const playerData = new PlayerData({ userId: "333" });
    seedPlayer(database, clanData, playerData);
    new AttackEntryRepository(database).insert(
      new AttackEntry({
        attackEntryId: "battle-declare-1",
        categoryId: clanData.categoryId,
        userId: playerData.userId,
        dayKey: clanData.date,
        lap: 1,
        bossIndex: 0,
        kind: AttackEntryKind.BATTLE,
        status: AttackEntryStatus.DECLARED,
        declaredAt: new Date("2026-03-08T00:00:00+09:00"),
      }),
    );
    new AttackEntryRepository(database).insert(
      new AttackEntry({
        attackEntryId: "battle-declare-2",
        categoryId: clanData.categoryId,
        userId: playerData.userId,
        dayKey: clanData.date,
        lap: 1,
        bossIndex: 1,
        kind: AttackEntryKind.BATTLE,
        status: AttackEntryStatus.DECLARED,
        declaredAt: new Date("2026-03-08T00:01:00+09:00"),
      }),
    );
    runtimeStateService.set(clanData);
    runtimeStateService.syncProjectedStateForCategory(clanData.categoryId, clanData.date);

    const responseChannel = new FakeTextChannel("response");
    const remainChannel = new FakeTextChannel(clanData.remainAttackChannelId);
    remainChannel.attachMessage(new FakeMessage(clanData.remainAttackMessageId!));
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(remainChannel);

    const result = await service.adjustRemainAttackCount({
      categoryId: clanData.categoryId,
      channelId: clanData.commandChannelId,
      actor: { id: "444", displayName: "Manager" },
      member: { id: playerData.userId, displayName: "Alice" },
      type: ResourceAdjustmentType.BATTLE,
      remaining: 2,
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    const adjustmentRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from ResourceAdjustmentLog")
      .get();

    expect(result).toBe(false);
    expect(responseChannel.sentPayloads).toEqual([
      {
        content: "未確定の本戦宣言があるため、その残数にはできません。",
      },
    ]);
    expect(adjustmentRow?.count).toBe(0n);
  });
});
