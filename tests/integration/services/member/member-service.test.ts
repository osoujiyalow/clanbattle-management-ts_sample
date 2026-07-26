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
import {
  ResourceAdjustment,
  ResourceAdjustmentType,
} from "../../../../src/domain/resource-adjustment.js";
import { AttackEntryRepository } from "../../../../src/repositories/sqlite/attack-entry-repository.js";
import { AttackStatusRepository } from "../../../../src/repositories/sqlite/attack-status-repository.js";
import { CarryOverRepository } from "../../../../src/repositories/sqlite/carry-over-repository.js";
import { ClanRepository } from "../../../../src/repositories/sqlite/clan-repository.js";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
  type SqliteDatabase,
} from "../../../../src/repositories/sqlite/db.js";
import { OperationLogRepository } from "../../../../src/repositories/sqlite/operation-log-repository.js";
import { PlayerRepository } from "../../../../src/repositories/sqlite/player-repository.js";
import { ResourceAdjustmentRepository } from "../../../../src/repositories/sqlite/resource-adjustment-repository.js";
import {
  MemberService,
  type MemberDiscordGateway,
  type MemberEditableMessage,
  type MemberResponseChannel,
  type MemberTextChannel,
} from "../../../../src/services/member-service.js";
import { AttackService } from "../../../../src/services/attack-service.js";
import { RuntimeStateService } from "../../../../src/services/runtime-state-service.js";
import { createFixedClock } from "../../../../src/shared/time.js";
import { createCoreRepositorySchema } from "../../../unit/repositories/sqlite/core-repository-schema.js";
import { createTempSqlitePath, type TempSqlitePath } from "../../../unit/repositories/sqlite/test-sqlite-path.js";

interface SentPayload {
  content?: string;
}

class FakeEditableMessage implements MemberEditableMessage {
  readonly edits: Array<{ embeds?: unknown[]; components?: unknown[] }> = [];
  readonly reactions: string[] = [];
  deleted = false;

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

  async delete(): Promise<void> {
    this.deleted = true;
  }
}

class FakeReactionFailingMessage extends FakeEditableMessage {
  async addReaction(): Promise<void> {
    throw new Error("Failed to add reaction");
  }
}

class FakeTextChannel implements MemberTextChannel, MemberResponseChannel {
  readonly sentPayloads: SentPayload[] = [];
  readonly sentMessages: FakeEditableMessage[] = [];
  readonly messages = new Map<string, FakeEditableMessage>();

  constructor(readonly id: string, private readonly nextId: () => string = createSnowflakeFactory()) {}

  async send(payload: SentPayload): Promise<void> {
    this.sentPayloads.push(payload);
  }

  async sendMessage(payload: {
    content?: string;
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

function createSnowflakeFactory(start = 700000000000000000n): () => string {
  let current = start;
  return () => (current++).toString();
}

class FakeDiscordGateway implements MemberDiscordGateway {
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

function createClanData(): ClanData {
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
    progressMessageIdsByLap: new Map([[1, ["123", null, null, null, null]]]),
    summaryMessageIdsByLap: new Map([[1, ["223", null, null, null, null]]]),
    date: "2026-03-08",
  });
  clanData.initializeBossStatusData(1);
  return clanData;
}

describe("MemberService", () => {
  let tempPath: TempSqlitePath | undefined;
  let database: SqliteDatabase | undefined;

  afterEach(() => {
    if (database) {
      closeSqliteDatabase(database);
      database = undefined;
    }

    tempPath?.cleanup();
    tempPath = undefined;
  });

  it("adds the command actor when no role or member is specified", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new MemberService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    runtimeStateService.set(clanData);

    const responseChannel = new FakeTextChannel("response");
    const remainAttackChannel = new FakeTextChannel(clanData.remainAttackChannelId);
    const remainAttackMessage = new FakeEditableMessage(clanData.remainAttackMessageId!);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId);
    const summaryMessage = new FakeEditableMessage("223");
    remainAttackChannel.attachMessage(remainAttackMessage);
    summaryChannel.attachMessage(summaryMessage);

    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(remainAttackChannel);
    gateway.registerChannel(summaryChannel);

    const result = await service.add({
      categoryId: clanData.categoryId,
      actor: {
        id: "333333333333333333",
        displayName: "Alice_1",
      },
      responseChannel,
      discordGateway: gateway,
    });

    const playerRow = database
      .prepare<[], { count: bigint; user_id: bigint }>(
        "select count(*) as count, max(user_id) as user_id from PlayerData",
      )
      .get();

    expect(result).toBe(1);
    expect(responseChannel.sentPayloads).toHaveLength(1);
    expect(responseChannel.sentPayloads[0]?.content).toContain("1");
    expect(playerRow?.count).toBe(1n);
    expect(playerRow?.user_id.toString()).toBe("333333333333333333");
    expect(runtimeStateService.get(clanData.categoryId)?.playerDataMap.size).toBe(1);
    expect(remainAttackMessage.edits).toHaveLength(1);
    expect(summaryMessage.edits).toHaveLength(1);
  });

  it("adds explicit member and role members", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new MemberService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    runtimeStateService.set(clanData);

    const responseChannel = new FakeTextChannel("response");
    const remainAttackChannel = new FakeTextChannel(clanData.remainAttackChannelId);
    const remainAttackMessage = new FakeEditableMessage(clanData.remainAttackMessageId!);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId);
    const summaryMessage = new FakeEditableMessage("223");
    remainAttackChannel.attachMessage(remainAttackMessage);
    summaryChannel.attachMessage(summaryMessage);

    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(remainAttackChannel);
    gateway.registerChannel(summaryChannel);

    const result = await service.add({
      categoryId: clanData.categoryId,
      actor: {
        id: "333333333333333333",
        displayName: "Invoker",
      },
      member: {
        id: "444444444444444444",
        displayName: "Bob",
      },
      role: {
        members: [
          {
            id: "555555555555555555",
            displayName: "Carol",
          },
          {
            id: "666666666666666666",
            displayName: "Dave",
          },
        ],
      },
      responseChannel,
      discordGateway: gateway,
    });

    const playerRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from PlayerData")
      .get();

    expect(result).toBe(3);
    expect(responseChannel.sentPayloads).toHaveLength(1);
    expect(responseChannel.sentPayloads[0]?.content).toContain("3");
    expect(playerRow?.count).toBe(3n);
    expect(runtimeStateService.get(clanData.categoryId)?.playerDataMap.size).toBe(3);
    expect(remainAttackMessage.edits).toHaveLength(1);
    expect(summaryMessage.edits).toHaveLength(1);
  });

  it("skips already managed and duplicate members during batch add", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new MemberService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    const existingPlayer = new PlayerData({ userId: "444444444444444444" });
    new ClanRepository(database).insert(clanData);
    new PlayerRepository(database).insertMany(clanData.categoryId, [existingPlayer]);
    clanData.addPlayerData(existingPlayer);
    runtimeStateService.set(clanData);

    const responseChannel = new FakeTextChannel("response");
    const remainAttackChannel = new FakeTextChannel(clanData.remainAttackChannelId);
    const remainAttackMessage = new FakeEditableMessage(clanData.remainAttackMessageId!);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId);
    const summaryMessage = new FakeEditableMessage("223");
    remainAttackChannel.attachMessage(remainAttackMessage);
    summaryChannel.attachMessage(summaryMessage);

    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(remainAttackChannel);
    gateway.registerChannel(summaryChannel);

    const result = await service.add({
      categoryId: clanData.categoryId,
      actor: {
        id: "333333333333333333",
        displayName: "Invoker",
      },
      member: {
        id: "444444444444444444",
        displayName: "Bob",
      },
      role: {
        members: [
          {
            id: "444444444444444444",
            displayName: "Bob",
          },
          {
            id: "555555555555555555",
            displayName: "Carol",
          },
          {
            id: "555555555555555555",
            displayName: "Carol",
          },
        ],
      },
      responseChannel,
      discordGateway: gateway,
    });

    const playerRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from PlayerData")
      .get();

    expect(result).toBe(1);
    expect(responseChannel.sentPayloads).toHaveLength(1);
    expect(responseChannel.sentPayloads[0]?.content).toContain("1名追加");
    expect(responseChannel.sentPayloads[0]?.content).toContain("3名は既存または重複のためスキップ");
    expect(playerRow?.count).toBe(2n);
    expect(runtimeStateService.get(clanData.categoryId)?.playerDataMap.size).toBe(2);
    expect(remainAttackMessage.edits).toHaveLength(1);
    expect(summaryMessage.edits).toHaveLength(1);
  });

  it("increases an existing member's battle limit and preserves it across day rollover", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new MemberService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    const playerData = new PlayerData({
      userId: "444444444444444444",
      battleAttackCount: 2,
    });
    new ClanRepository(database).insert(clanData);
    new PlayerRepository(database).insertMany(clanData.categoryId, [playerData]);
    new PlayerRepository(database).update(clanData.categoryId, playerData);
    const resourceAdjustmentRepository = new ResourceAdjustmentRepository(database);
    resourceAdjustmentRepository.insert(
      new ResourceAdjustment({
        adjustmentId: "adjustment-before-limit-increase",
        categoryId: clanData.categoryId,
        userId: playerData.userId,
        actorUserId: "333333333333333333",
        dayKey: clanData.date,
        resourceType: ResourceAdjustmentType.BATTLE,
        remaining: 1,
        occurredAt: new Date("2026-03-08T05:30:00+09:00"),
      }),
    );
    clanData.addPlayerData(playerData);
    runtimeStateService.set(clanData);

    const responseChannel = new FakeTextChannel("response");
    const remainAttackChannel = new FakeTextChannel(clanData.remainAttackChannelId);
    const remainAttackMessage = new FakeEditableMessage(clanData.remainAttackMessageId!);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId);
    const summaryMessage = new FakeEditableMessage("223");
    remainAttackChannel.attachMessage(remainAttackMessage);
    summaryChannel.attachMessage(summaryMessage);

    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(remainAttackChannel);
    gateway.registerChannel(summaryChannel);

    const result = await service.increaseBattleAttackLimit({
      categoryId: clanData.categoryId,
      actor: { id: "333333333333333333", displayName: "Invoker" },
      member: { id: playerData.userId, displayName: "Bob" },
      responseChannel,
      discordGateway: gateway,
    });

    expect(result).toBe(6);
    expect(playerData.battleAttackLimit).toBe(6);
    expect(new PlayerRepository(database).findByCategoryId(clanData.categoryId).get(playerData.userId)?.battleAttackLimit).toBe(6);
    expect(
      resourceAdjustmentRepository
        .findAllByCategory(clanData.categoryId)
        .filter((adjustment) => adjustment.resourceType === ResourceAdjustmentType.BATTLE)
        .at(-1)?.remaining,
    ).toBe(4);

    const decreasedResult = await service.decreaseBattleAttackLimit({
      categoryId: clanData.categoryId,
      actor: { id: "333333333333333333", displayName: "Invoker" },
      member: { id: playerData.userId, displayName: "Bob" },
      responseChannel,
      discordGateway: gateway,
    });
    expect(decreasedResult).toBe(3);
    expect(playerData.battleAttackLimit).toBe(3);

    const belowMinimumResult = await service.decreaseBattleAttackLimit({
      categoryId: clanData.categoryId,
      actor: { id: "333333333333333333", displayName: "Invoker" },
      member: { id: playerData.userId, displayName: "Bob" },
      responseChannel,
      discordGateway: gateway,
    });
    expect(belowMinimumResult).toBeNull();
    expect(playerData.battleAttackLimit).toBe(3);

    await service.increaseBattleAttackLimit({
      categoryId: clanData.categoryId,
      actor: { id: "333333333333333333", displayName: "Invoker" },
      member: { id: playerData.userId, displayName: "Bob" },
      responseChannel,
      discordGateway: gateway,
    });

    await runtimeStateService.ensureDateUpToDate(
      clanData.categoryId,
      createFixedClock("2026-03-09T06:00:00+09:00"),
    );

    expect(playerData.battleAttackCount).toBe(0);
    expect(playerData.battleAttackLimit).toBe(6);
    const restored = new PlayerRepository(database)
      .findByCategoryId(clanData.categoryId)
      .get(playerData.userId);
    expect(restored?.battleAttackCount).toBe(0);
    expect(restored?.battleAttackLimit).toBe(6);
  });

  it("removes a member without progress activity and still redraws the summary totals", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new MemberService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });
    const playerRepository = new PlayerRepository(database);

    const clanData = createClanData();
    const bob = new PlayerData({ userId: "444444444444444444" });
    clanData.addPlayerData(bob);
    new ClanRepository(database).insert(clanData);
    playerRepository.insertMany(clanData.categoryId, [bob]);
    runtimeStateService.set(clanData);

    const responseChannel = new FakeTextChannel("response");
    const remainAttackChannel = new FakeTextChannel(clanData.remainAttackChannelId);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId);
    const remainAttackMessage = new FakeEditableMessage(clanData.remainAttackMessageId!);
    const summaryMessage = new FakeEditableMessage("223");
    remainAttackChannel.attachMessage(remainAttackMessage);
    summaryChannel.attachMessage(summaryMessage);
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(remainAttackChannel);
    gateway.registerChannel(summaryChannel);

    const result = await service.remove({
      categoryId: clanData.categoryId,
      actor: {
        id: "999999999999999999",
        displayName: "Invoker",
      },
      member: {
        id: bob.userId,
        displayName: "Bob",
      },
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[bob.userId, "Bob"]]),
    });

    expect(result).toBe(1);
    expect(remainAttackMessage.edits).toHaveLength(1);
    expect(summaryMessage.edits).toHaveLength(1);
  });

  it("removes a member and deletes unresolved dependent DB rows", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new MemberService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });
    const playerRepository = new PlayerRepository(database);
    const attackEntryRepository = new AttackEntryRepository(database);
    const attackStatusRepository = new AttackStatusRepository(database);
    const carryOverRepository = new CarryOverRepository(database);
    const operationLogRepository = new OperationLogRepository(database);

    const clanData = createClanData();
    const alice = new PlayerData({ userId: "333333333333333333" });
    const bob = new PlayerData({ userId: "444444444444444444" });
    clanData.addPlayerData(alice);
    clanData.addPlayerData(bob);

    runtimeStateService.set(clanData);
    playerRepository.insertMany(clanData.categoryId, [alice, bob]);
    const bobAttackStatus = new AttackStatus({
      playerData: bob,
      attackType: AttackType.BATTLE,
      carryOver: false,
      damage: 123_456,
      attacked: false,
      created: new Date("2026-03-08T00:00:00+09:00"),
    });
    clanData.bossStatusByLap.get(1)![0]!.attackPlayers.push(bobAttackStatus);
    attackStatusRepository.insert(clanData.categoryId, 1, 0, bobAttackStatus);
    attackEntryRepository.insert(
      new AttackEntry({
        attackEntryId: "attack-1",
        categoryId: clanData.categoryId,
        userId: bob.userId,
        dayKey: clanData.date,
        lap: 1,
        bossIndex: 0,
        kind: AttackEntryKind.BATTLE,
        status: AttackEntryStatus.DECLARED,
        declaredAt: new Date("2026-03-08T00:00:00+09:00"),
        damage: 123_456,
      }),
    );
    operationLogRepository.insert(
      new OperationLog({
        operationId: "operation-1",
        categoryId: clanData.categoryId,
        userId: bob.userId,
        dayKey: clanData.date,
        lap: 1,
        bossIndex: 0,
        targetAttackEntryId: "attack-1",
        operationType: OperationLogType.DECLARE,
        afterKind: AttackEntryKind.BATTLE,
        afterStatus: AttackEntryStatus.DECLARED,
        occurredAt: new Date("2026-03-08T00:00:00+09:00"),
      }),
    );
    carryOverRepository.insert(
      clanData.categoryId,
      bob.userId,
      new CarryOver({
        attackType: AttackType.BATTLE,
        bossIndex: 0,
        created: new Date("2026-03-08T00:00:00+09:00"),
      }),
    );

    const responseChannel = new FakeTextChannel("response");
    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId);
    const remainAttackChannel = new FakeTextChannel(clanData.remainAttackChannelId);
    const progressMessage = new FakeEditableMessage("123");
    const summaryMessage = new FakeEditableMessage("223");
    const remainAttackMessage = new FakeEditableMessage(clanData.remainAttackMessageId!);
    bossChannel.attachMessage(progressMessage);
    summaryChannel.attachMessage(summaryMessage);
    remainAttackChannel.attachMessage(remainAttackMessage);
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(bossChannel);
    gateway.registerChannel(summaryChannel);
    gateway.registerChannel(remainAttackChannel);

    const result = await service.remove({
      categoryId: clanData.categoryId,
      actor: {
        id: "999999999999999999",
        displayName: "Invoker",
      },
      member: {
        id: bob.userId,
        displayName: "Bob",
      },
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([
        [alice.userId, "Alice"],
        [bob.userId, "Bob"],
      ]),
    });

    const playerRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from PlayerData")
      .get();
    const attackStatusRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from AttackStatus")
      .get();
    const attackEntryRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from AttackEntry")
      .get();
    const carryOverRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from CarryOver")
      .get();
    const operationLogRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from OperationLog")
      .get();

    expect(result).toBe(1);
    expect(responseChannel.sentPayloads).toHaveLength(2);
    expect(responseChannel.sentPayloads[0]?.content).toContain("1");
    expect(playerRow?.count).toBe(1n);
    expect(attackStatusRow?.count).toBe(0n);
    expect(attackEntryRow?.count).toBe(0n);
    expect(carryOverRow?.count).toBe(0n);
    expect(operationLogRow?.count).toBe(0n);
    expect(runtimeStateService.get(clanData.categoryId)?.playerDataMap.has(bob.userId)).toBe(false);
    expect(runtimeStateService.get(clanData.categoryId)?.bossStatusByLap.get(1)?.[0]?.attackPlayers).toHaveLength(0);
    expect(runtimeStateService.getAttackEntries(clanData.categoryId)).toHaveLength(0);
    expect(runtimeStateService.getOperationLogs(clanData.categoryId)).toHaveLength(0);
    expect(progressMessage.edits).toHaveLength(1);
    expect(summaryMessage.edits).toHaveLength(1);
    expect(remainAttackMessage.edits).toHaveLength(1);
  });

  it("keeps resolved progress history when removing a member", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new MemberService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });
    const playerRepository = new PlayerRepository(database);
    const attackEntryRepository = new AttackEntryRepository(database);
    const attackStatusRepository = new AttackStatusRepository(database);
    const operationLogRepository = new OperationLogRepository(database);

    const clanData = createClanData();
    const bob = new PlayerData({ userId: "444444444444444444" });
    clanData.addPlayerData(bob);
    clanData.bossStatusByLap.get(1)![0]!.attackPlayers.push(
      new AttackStatus({
        playerData: bob,
        attackType: AttackType.BATTLE,
        carryOver: false,
        damage: 1_234_567,
        attacked: true,
        created: new Date("2026-03-08T00:00:00+09:00"),
      }),
    );

    runtimeStateService.set(clanData);
    playerRepository.insertMany(clanData.categoryId, [bob]);
    attackStatusRepository.insert(
      clanData.categoryId,
      1,
      0,
      clanData.bossStatusByLap.get(1)![0]!.attackPlayers[0]!,
    );
    attackEntryRepository.insert(
      new AttackEntry({
        attackEntryId: "attack-1",
        categoryId: clanData.categoryId,
        userId: bob.userId,
        dayKey: clanData.date,
        lap: 1,
        bossIndex: 0,
        kind: AttackEntryKind.BATTLE,
        status: AttackEntryStatus.FINISHED,
        declaredAt: new Date("2026-03-08T00:00:00+09:00"),
        resolvedAt: new Date("2026-03-08T00:01:00+09:00"),
        damage: 1_234_567,
      }),
    );
    operationLogRepository.insert(
      new OperationLog({
        operationId: "operation-1",
        categoryId: clanData.categoryId,
        userId: bob.userId,
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
    runtimeStateService.syncProjectedStateForCategory(clanData.categoryId, clanData.date);

    const responseChannel = new FakeTextChannel("response");
    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId);
    const remainAttackChannel = new FakeTextChannel(clanData.remainAttackChannelId);
    const progressMessage = new FakeEditableMessage("123");
    const summaryMessage = new FakeEditableMessage("223");
    const remainAttackMessage = new FakeEditableMessage(clanData.remainAttackMessageId!);
    bossChannel.attachMessage(progressMessage);
    summaryChannel.attachMessage(summaryMessage);
    remainAttackChannel.attachMessage(remainAttackMessage);
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(bossChannel);
    gateway.registerChannel(summaryChannel);
    gateway.registerChannel(remainAttackChannel);

    const result = await service.remove({
      categoryId: clanData.categoryId,
      actor: {
        id: "999999999999999999",
        displayName: "Invoker",
      },
      member: {
        id: bob.userId,
        displayName: "Bob",
      },
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[bob.userId, "Bob"]]),
    });

    const playerRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from PlayerData")
      .get();
    const attackStatusRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from AttackStatus")
      .get();
    const attackEntryRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from AttackEntry")
      .get();
    const operationLogRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from OperationLog")
      .get();

    expect(result).toBe(1);
    expect(playerRow?.count).toBe(0n);
    expect(attackStatusRow?.count).toBe(1n);
    expect(attackEntryRow?.count).toBe(0n);
    expect(operationLogRow?.count).toBe(0n);
    expect(runtimeStateService.get(clanData.categoryId)?.playerDataMap.has(bob.userId)).toBe(false);
    expect(runtimeStateService.getAttackEntries(clanData.categoryId)).toHaveLength(0);
    expect(runtimeStateService.getOperationLogs(clanData.categoryId)).toHaveLength(0);
    expect(runtimeStateService.get(clanData.categoryId)?.bossStatusByLap.get(1)?.[0]?.attackPlayers).toHaveLength(1);
    expect(progressMessage.edits).toHaveLength(1);
    expect(summaryMessage.edits).toHaveLength(1);
    expect(remainAttackMessage.edits).toHaveLength(1);
    expect(JSON.stringify(progressMessage.edits[0]?.embeds?.[0] ?? {})).toContain("1,234,567");
    expect(JSON.stringify(progressMessage.edits[0]?.embeds?.[0] ?? {})).toContain("Bob");
  });

  it("allows a removed and re-added member to declare again without inheriting hidden-state consumption", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const memberService = new MemberService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });
    const attackService = new AttackService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
      redrawRetryDelayMs: 0,
    });
    const playerRepository = new PlayerRepository(database);
    const attackEntryRepository = new AttackEntryRepository(database);
    const attackStatusRepository = new AttackStatusRepository(database);

    const clanData = createClanData();
    const bob = new PlayerData({ userId: "444444444444444444" });
    clanData.addPlayerData(bob);
    runtimeStateService.set(clanData);
    playerRepository.insertMany(clanData.categoryId, [bob]);

    for (const bossIndex of [0, 1, 2] as const) {
      const resolvedStatus = new AttackStatus({
        playerData: bob,
        attackType: AttackType.BATTLE,
        carryOver: false,
        damage: 100_000 + bossIndex,
        attacked: true,
        created: new Date(`2026-03-08T00:0${bossIndex}:00+09:00`),
      });
      clanData.bossStatusByLap.get(1)![bossIndex]!.attackPlayers.push(resolvedStatus);
      attackStatusRepository.insert(clanData.categoryId, 1, bossIndex, resolvedStatus);
      attackEntryRepository.insert(
        new AttackEntry({
          attackEntryId: `attack-${bossIndex}`,
          categoryId: clanData.categoryId,
          userId: bob.userId,
          dayKey: clanData.date,
          lap: 1,
          bossIndex,
          kind: AttackEntryKind.BATTLE,
          status: AttackEntryStatus.FINISHED,
          declaredAt: new Date(`2026-03-08T00:0${bossIndex}:00+09:00`),
          resolvedAt: new Date(`2026-03-08T00:1${bossIndex}:00+09:00`),
          damage: 100_000 + bossIndex,
        }),
      );
    }
    runtimeStateService.syncProjectedStateForCategory(clanData.categoryId, clanData.date);

    const responseChannel = new FakeTextChannel("response");
    const declareResponseChannel = new FakeTextChannel("declare-response");
    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId);
    const remainAttackChannel = new FakeTextChannel(clanData.remainAttackChannelId);
    const progressMessage = new FakeEditableMessage("123");
    const summaryMessage = new FakeEditableMessage("223");
    const remainAttackMessage = new FakeEditableMessage(clanData.remainAttackMessageId!);
    bossChannel.attachMessage(progressMessage);
    summaryChannel.attachMessage(summaryMessage);
    remainAttackChannel.attachMessage(remainAttackMessage);
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(bossChannel);
    gateway.registerChannel(summaryChannel);
    gateway.registerChannel(remainAttackChannel);

    const removed = await memberService.remove({
      categoryId: clanData.categoryId,
      actor: {
        id: "999999999999999999",
        displayName: "Invoker",
      },
      member: {
        id: bob.userId,
        displayName: "Bob",
      },
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[bob.userId, "Bob"]]),
    });

    const readded = await memberService.add({
      categoryId: clanData.categoryId,
      actor: {
        id: "999999999999999999",
        displayName: "Invoker",
      },
      member: {
        id: bob.userId,
        displayName: "Bob",
      },
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[bob.userId, "Bob"]]),
    });

    const declared = await attackService.declare({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      member: {
        id: bob.userId,
        displayName: "Bob",
      },
      attackType: ATTACK_TYPE_INPUTS.BATTLE,
      responseChannel: declareResponseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[bob.userId, "Bob"]]),
    });

    const attackEntryRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from AttackEntry where user_id = 444444444444444444")
      .get();

    expect(removed).toBe(1);
    expect(readded).toBe(1);
    expect(declared).not.toBeNull();
    expect(attackEntryRow?.count).toBe(1n);
    expect(declareResponseChannel.sentPayloads.at(-1)?.content).toContain("Bobの凸を");
  });

  it("keeps legacy resolved progress history when removing a member and after restore", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    let runtimeStateService = new RuntimeStateService({ database });
    const service = new MemberService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });
    const playerRepository = new PlayerRepository(database);
    const attackStatusRepository = new AttackStatusRepository(database);

    const clanData = createClanData();
    const bob = new PlayerData({ userId: "444444444444444444" });
    const resolvedStatus = new AttackStatus({
      playerData: bob,
      attackType: AttackType.BATTLE,
      carryOver: false,
      damage: 1_234_567,
      attacked: true,
      created: new Date("2026-03-08T00:00:00+09:00"),
    });
    clanData.addPlayerData(bob);
    clanData.bossStatusByLap.get(1)![0]!.attackPlayers.push(resolvedStatus);

    new ClanRepository(database).insert(clanData);
    runtimeStateService.set(clanData);
    playerRepository.insertMany(clanData.categoryId, [bob]);
    attackStatusRepository.insert(clanData.categoryId, 1, 0, resolvedStatus);

    const responseChannel = new FakeTextChannel("response");
    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId);
    const remainAttackChannel = new FakeTextChannel(clanData.remainAttackChannelId);
    const progressMessage = new FakeEditableMessage("123");
    const summaryMessage = new FakeEditableMessage("223");
    const remainAttackMessage = new FakeEditableMessage(clanData.remainAttackMessageId!);
    bossChannel.attachMessage(progressMessage);
    summaryChannel.attachMessage(summaryMessage);
    remainAttackChannel.attachMessage(remainAttackMessage);
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(bossChannel);
    gateway.registerChannel(summaryChannel);
    gateway.registerChannel(remainAttackChannel);

    const result = await service.remove({
      categoryId: clanData.categoryId,
      actor: {
        id: "999999999999999999",
        displayName: "Invoker",
      },
      member: {
        id: bob.userId,
        displayName: "Bob",
      },
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[bob.userId, "Bob"]]),
    });

    const playerRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from PlayerData")
      .get();
    const attackStatusRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from AttackStatus")
      .get();

    expect(result).toBe(1);
    expect(playerRow?.count).toBe(0n);
    expect(attackStatusRow?.count).toBe(1n);
    expect(runtimeStateService.get(clanData.categoryId)?.bossStatusByLap.get(1)?.[0]?.attackPlayers).toHaveLength(1);
    expect(JSON.stringify(progressMessage.edits[0]?.embeds?.[0] ?? {})).toContain("1,234,567");
    expect(JSON.stringify(progressMessage.edits[0]?.embeds?.[0] ?? {})).toContain("Bob");

    runtimeStateService = new RuntimeStateService({ database });
    runtimeStateService.restoreFromDatabase();

    const restoredClanData = runtimeStateService.get(clanData.categoryId);
    expect(restoredClanData?.playerDataMap.has(bob.userId)).toBe(false);
    expect(restoredClanData?.bossStatusByLap.get(1)?.[0]?.attackPlayers).toHaveLength(1);
    expect(restoredClanData?.bossStatusByLap.get(1)?.[0]?.attackPlayers[0]?.playerData.userId).toBe(
      bob.userId,
    );
    expect(restoredClanData?.bossStatusByLap.get(1)?.[0]?.attackPlayers[0]?.damage).toBe(1_234_567);
  });

  it("returns a public error when the member is not managed", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new MemberService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    runtimeStateService.set(clanData);

    const responseChannel = new FakeTextChannel("response");
    const remainAttackChannel = new FakeTextChannel(clanData.remainAttackChannelId);
    remainAttackChannel.attachMessage(new FakeEditableMessage(clanData.remainAttackMessageId!));
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(remainAttackChannel);

    const result = await service.remove({
      categoryId: clanData.categoryId,
      actor: {
        id: "999999999999999999",
        displayName: "Invoker",
      },
      member: {
        id: "444444444444444444",
        displayName: "Bob",
      },
      responseChannel,
      discordGateway: gateway,
    });

    expect(result).toBeNull();
    expect(responseChannel.sentPayloads).toHaveLength(1);
    expect(responseChannel.sentPayloads[0]?.content).toContain("Bob");
  });

  it("creates a new remain-attack message on day rollover and leaves the old one untouched", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new MemberService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    clanData.date = "2026-03-07";
    new ClanRepository(database).insert(clanData);
    runtimeStateService.set(clanData);

    const responseChannel = new FakeTextChannel("response");
    const remainAttackChannel = new FakeTextChannel(clanData.remainAttackChannelId);
    const oldRemainAttackMessage = new FakeEditableMessage(clanData.remainAttackMessageId!);
    remainAttackChannel.attachMessage(oldRemainAttackMessage);

    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(remainAttackChannel);

    const result = await service.add({
      categoryId: clanData.categoryId,
      actor: {
        id: "333333333333333333",
        displayName: "Alice_1",
      },
      responseChannel,
      discordGateway: gateway,
    });

    const clanRow = database
      .prepare<[], { remain_attack_message_id: bigint | null; day: string }>(
        "select remain_attack_message_id, day from ClanData where category_id = 223456789012345678",
      )
      .get();

    expect(result).toBe(1);
    expect(clanData.date).toBe("2026-03-08");
    expect(oldRemainAttackMessage.edits).toHaveLength(0);
    expect(remainAttackChannel.sentMessages).toHaveLength(1);
    expect(clanData.remainAttackMessageId).toBe(remainAttackChannel.sentMessages[0]?.id);
    expect(remainAttackChannel.sentMessages[0]?.reactions).toEqual(["💀"]);
    expect(remainAttackChannel.sentMessages[0]?.edits).toHaveLength(2);
    expect(clanRow?.remain_attack_message_id?.toString()).toBe(clanData.remainAttackMessageId);
    expect(clanRow?.day).toBe("2026-03-08");
  });

  it("updates only the current remain-attack message and never rewrites a historical one", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new MemberService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });
    const playerRepository = new PlayerRepository(database);

    const clanData = createClanData();
    clanData.remainAttackMessageId = "213456789012345678";
    new ClanRepository(database).insert(clanData);
    const playerData = new PlayerData({ userId: "333333333333333333" });
    clanData.addPlayerData(playerData);
    playerRepository.insertMany(clanData.categoryId, [playerData]);
    playerRepository.update(clanData.categoryId, playerData);
    runtimeStateService.set(clanData);

    const historicalRemainAttackMessage = new FakeEditableMessage("113456789012345678");
    const currentRemainAttackMessage = new FakeEditableMessage(clanData.remainAttackMessageId!);
    const remainAttackChannel = new FakeTextChannel(clanData.remainAttackChannelId);
    remainAttackChannel.attachMessage(historicalRemainAttackMessage);
    remainAttackChannel.attachMessage(currentRemainAttackMessage);
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(remainAttackChannel);

    const result = await service.setTaskKill({
      categoryId: clanData.categoryId,
      member: {
        id: playerData.userId,
        displayName: "Alice_1",
      },
      taskKill: true,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice_1"]]),
    });

    const playerRow = database
      .prepare<[], { task_kill: bigint }>(
        "select task_kill from PlayerData where category_id = 223456789012345678 and user_id = 333333333333333333",
      )
      .get();

    expect(result).toBe(true);
    expect(playerData.taskKill).toBe(true);
    expect(playerRow?.task_kill).toBe(1n);
    expect(historicalRemainAttackMessage.edits).toHaveLength(0);
    expect(currentRemainAttackMessage.edits).toHaveLength(1);
  });

  it("persists the new remain-attack message id even if adding the task-kill reaction fails", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new MemberService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    clanData.date = "2026-03-07";
    new ClanRepository(database).insert(clanData);
    runtimeStateService.set(clanData);
    runtimeStateService.ensureDateUpToDateLocked(
      clanData.categoryId,
      createFixedClock("2026-03-08T06:00:00+09:00"),
    );

    const remainAttackChannel = new FakeReactionFailingTextChannel(clanData.remainAttackChannelId);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId);
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(remainAttackChannel);
    gateway.registerChannel(summaryChannel);

    const messageId = await service.ensureCurrentRemainAttackMessage({
      categoryId: clanData.categoryId,
      member: {
        id: "333333333333333333",
        displayName: "Alice",
      },
      discordGateway: gateway,
      displayNamesByUserId: new Map([["333333333333333333", "Alice"]]),
    });

    const secondMessageId = await service.ensureCurrentRemainAttackMessage({
      categoryId: clanData.categoryId,
      member: {
        id: "333333333333333333",
        displayName: "Alice",
      },
      discordGateway: gateway,
      displayNamesByUserId: new Map([["333333333333333333", "Alice"]]),
    });

    const clanRow = database
      .prepare<[], { remain_attack_message_id: bigint | null }>(
        "select remain_attack_message_id from ClanData where category_id = 223456789012345678",
      )
      .get();

    expect(messageId).toBe(remainAttackChannel.sentMessages[0]?.id);
    expect(secondMessageId).toBe(messageId);
    expect(remainAttackChannel.sentMessages).toHaveLength(1);
    expect(remainAttackChannel.sentMessages[0]?.reactions).toEqual([]);
    expect(summaryChannel.sentMessages).toHaveLength(1);
    expect(clanData.summaryMessageIdsByLap.get(1)?.[0]).toBe(summaryChannel.sentMessages[0]?.id);
    expect(clanData.remainAttackMessageId).toBe(messageId);
    expect(clanRow?.remain_attack_message_id?.toString()).toBe(messageId);
  });

  it("recreates a missing current remain-attack message instead of failing add", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new MemberService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    new ClanRepository(database).insert(clanData);
    runtimeStateService.set(clanData);

    const responseChannel = new FakeTextChannel("response");
    const remainAttackChannel = new FakeTextChannel(clanData.remainAttackChannelId);
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(remainAttackChannel);

    const result = await service.add({
      categoryId: clanData.categoryId,
      actor: {
        id: "333333333333333333",
        displayName: "Alice_1",
      },
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([["333333333333333333", "Alice_1"]]),
    });

    const clanRow = database
      .prepare<[], { remain_attack_message_id: bigint | null }>(
        "select remain_attack_message_id from ClanData where category_id = 223456789012345678",
      )
      .get();

    expect(result).toBe(1);
    expect(responseChannel.sentPayloads).toHaveLength(1);
    expect(remainAttackChannel.sentMessages).toHaveLength(1);
    expect(remainAttackChannel.sentMessages[0]?.reactions).toEqual(["💀"]);
    expect(clanData.remainAttackMessageId).toBe(remainAttackChannel.sentMessages[0]?.id);
    expect(clanRow?.remain_attack_message_id?.toString()).toBe(clanData.remainAttackMessageId);
  });
});
