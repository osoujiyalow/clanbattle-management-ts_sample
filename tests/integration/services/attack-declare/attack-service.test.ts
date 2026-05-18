import { afterEach, describe, expect, it } from "vitest";

import { USER_MESSAGES } from "../../../../src/constants/messages.js";
import { ATTACK_TYPE_INPUTS, AttackType } from "../../../../src/domain/attack-type.js";
import { ClanData } from "../../../../src/domain/clan-data.js";
import { CarryOver, PlayerData } from "../../../../src/domain/player-data.js";
import { OperationType } from "../../../../src/domain/operation-type.js";
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
import { PlayerRepository } from "../../../../src/repositories/sqlite/player-repository.js";
import {
  AttackService,
  type AttackDeclareResponseChannel,
  type AttackDiscordGateway,
  type AttackEditableMessage,
  type AttackTextChannel,
} from "../../../../src/services/attack-service.js";
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

class FakeTextChannel implements AttackTextChannel, AttackDeclareResponseChannel {
  readonly sentPayloads: Array<{ content?: string }> = [];
  readonly transientPayloads: Array<{ content?: string; deleteAfterMs?: number }> = [];
  readonly sentMessages: FakeEditableMessage[] = [];
  readonly messages = new Map<string, FakeEditableMessage>();
  private nextMessageId = 0;

  constructor(readonly id: string) {}

  async send(payload: { content?: string }): Promise<void> {
    this.sentPayloads.push(payload);
  }

  async sendTransient(
    payload: { content?: string },
    deleteAfterMs?: number,
  ): Promise<void> {
    this.transientPayloads.push({
      ...payload,
      ...(deleteAfterMs !== undefined ? { deleteAfterMs } : {}),
    });
  }

  async sendMessage(payload: {
    content?: string;
    embeds?: readonly { toJSON(): unknown }[];
    components?: readonly { toJSON(): unknown }[];
  }): Promise<FakeEditableMessage> {
    this.nextMessageId += 1;
    const message = new FakeEditableMessage(`${this.id}-${this.nextMessageId}`);
    if (payload.embeds || payload.components) {
      await message.edit(payload);
    }
    this.attachMessage(message);
    this.sentMessages.push(message);
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
    progressMessageIdsByLap: new Map([[1, ["111", "112", "113", "114", "115"]]]),
    summaryMessageIdsByLap: new Map([[1, ["211", null, null, null, null]]]),
    date: "2026-03-08",
  });
  clanData.initializeBossStatusData(1);
  return clanData;
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

function seedPlayer(database: SqliteDatabase, clanData: ClanData, playerData: PlayerData): void {
  clanData.addPlayerData(playerData);
  const playerRepository = new PlayerRepository(database);
  playerRepository.insertMany(clanData.categoryId, [playerData]);
  playerRepository.update(clanData.categoryId, playerData);
}

describe("AttackService declare", () => {
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

  it("declares an attack, stores AttackStatus, and redraws progress plus summary", async () => {
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
    const playerData = new PlayerData({ userId: "333333333333333333" });
    seedPlayer(database, clanData, playerData);
    runtimeStateService.set(clanData);

    const responseChannel = new FakeTextChannel("response");
    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId);
    const bossMessage = new FakeEditableMessage("111");
    const summaryMessage = new FakeEditableMessage("211");
    bossChannel.attachMessage(bossMessage);
    summaryChannel.attachMessage(summaryMessage);

    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(bossChannel);
    gateway.registerChannel(summaryChannel);

    const result = await service.declare({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      member: {
        id: playerData.userId,
        displayName: "Alice",
      },
      attackType: ATTACK_TYPE_INPUTS.BATTLE,
      responseChannel,
      discordGateway: gateway,
      displayNamesByUserId: new Map([[playerData.userId, "Alice"]]),
    });

    const row = database
      .prepare<
        [],
        {
          count: bigint;
          attack_type: string;
          attacked: bigint;
          carry_over: bigint;
        }
      >(
        "select count(*) as count, max(attack_type) as attack_type, max(attacked) as attacked, max(carry_over) as carry_over from AttackStatus",
      )
      .get();
    const attackEntryRow = database
      .prepare<[], { count: bigint; kind: string; status: string }>(
        "select count(*) as count, max(kind) as kind, max(status) as status from AttackEntry",
      )
      .get();
    const operationLogRow = database
      .prepare<[], { count: bigint; operation_type: string }>(
        "select count(*) as count, max(operation_type) as operation_type from OperationLog",
      )
      .get();

    expect(result).not.toBeNull();
    expect(responseChannel.sentPayloads).toHaveLength(1);
    expect(responseChannel.sentPayloads[0]?.content).toContain("Alice");
    expect(row).toEqual({
      count: 1n,
      attack_type: AttackType.BATTLE,
      attacked: 0n,
      carry_over: 0n,
    });
    expect(attackEntryRow).toEqual({
      count: 1n,
      kind: "battle",
      status: "declared",
    });
    expect(operationLogRow).toEqual({
      count: 1n,
      operation_type: "declare",
    });
    expect(clanData.bossStatusByLap.get(1)?.[0]?.attackPlayers).toHaveLength(1);
    expect(playerData.log).toEqual([
      {
        operationType: OperationType.ATTACK_DECLAR,
        lap: 1,
        bossIndex: 0,
      },
    ]);
    expect(bossMessage.edits).toHaveLength(1);
    expect(summaryMessage.edits).toHaveLength(1);
    expect(bossMessage.edits[0]?.embeds?.[0]).toMatchObject({
      description: expect.stringContaining("Alice"),
    });
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
  });

  it("blocks carryover declare when the player has no carryover", async () => {
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
    const playerData = new PlayerData({ userId: "333333333333333333" });
    seedPlayer(database, clanData, playerData);
    runtimeStateService.set(clanData);

    const responseChannel = new FakeTextChannel("response");
    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId);
    bossChannel.attachMessage(new FakeEditableMessage("111"));
    summaryChannel.attachMessage(new FakeEditableMessage("211"));

    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(bossChannel);
    gateway.registerChannel(summaryChannel);

    const result = await service.declare({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      member: {
        id: playerData.userId,
        displayName: "Alice",
      },
      attackType: ATTACK_TYPE_INPUTS.CARRYOVER,
      responseChannel,
      discordGateway: gateway,
    });

    const row = database
      .prepare<[], { count: bigint }>("select count(*) as count from AttackStatus")
      .get();

    expect(result).toBeNull();
    expect(responseChannel.sentPayloads).toHaveLength(0);
    expect(responseChannel.transientPayloads).toEqual([
      {
        content: expect.any(String),
        deleteAfterMs: 15000,
      },
    ]);
    expect(row?.count).toBe(0n);
  });

  it("blocks a fourth battle declaration with a transient message", async () => {
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
    const playerData = new PlayerData({
      userId: "333333333333333333",
      battleAttackCount: 3,
    });
    seedPlayer(database, clanData, playerData);
    runtimeStateService.set(clanData);

    const responseChannel = new FakeTextChannel("response");
    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId);
    bossChannel.attachMessage(new FakeEditableMessage("111"));
    summaryChannel.attachMessage(new FakeEditableMessage("211"));
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(bossChannel);
    gateway.registerChannel(summaryChannel);

    const result = await service.declare({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      member: {
        id: playerData.userId,
        displayName: "Alice",
      },
      attackType: ATTACK_TYPE_INPUTS.BATTLE,
      responseChannel,
      discordGateway: gateway,
    });

    const row = database
      .prepare<[], { count: bigint }>("select count(*) as count from AttackStatus")
      .get();

    expect(result).toBeNull();
    expect(responseChannel.sentPayloads).toHaveLength(0);
    expect(responseChannel.transientPayloads).toEqual([
      {
        content: "本戦凸は全て使っています。凸宣言をキャンセルします。",
        deleteAfterMs: 15000,
      },
    ]);
    expect(row?.count).toBe(0n);
  });

  it("returns public errors for invalid lap and missing managed member", async () => {
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
    runtimeStateService.set(clanData);

    const responseChannel = new FakeTextChannel("response");
    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId);
    bossChannel.attachMessage(new FakeEditableMessage("111"));
    summaryChannel.attachMessage(new FakeEditableMessage("211"));
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(bossChannel);
    gateway.registerChannel(summaryChannel);

    const invalidLapResult = await service.declare({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      member: {
        id: "333333333333333333",
        displayName: "Alice",
      },
      attackType: ATTACK_TYPE_INPUTS.BATTLE,
      lap: 2,
      responseChannel,
      discordGateway: gateway,
    });
    const missingMemberResult = await service.declare({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      member: {
        id: "333333333333333333",
        displayName: "Alice",
      },
      attackType: ATTACK_TYPE_INPUTS.BATTLE,
      responseChannel,
      discordGateway: gateway,
    });

    expect(invalidLapResult).toBeNull();
    expect(missingMemberResult).toBeNull();
    expect(responseChannel.sentPayloads).toHaveLength(2);
    expect(responseChannel.sentPayloads[0]?.content).toBe(USER_MESSAGES.errors.invalidLap);
    expect(responseChannel.sentPayloads[1]?.content).toContain("Alice");
  });

  it("returns a validation error when attack_type is invalid", async () => {
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
    const playerData = new PlayerData({
      userId: "333333333333333333",
      carryOverList: [
        new CarryOver({
          attackType: AttackType.BATTLE,
          bossIndex: 0,
          created: new Date("2026-03-07T12:34:56+09:00"),
        }),
      ],
    });
    seedPlayer(database, clanData, playerData);
    runtimeStateService.set(clanData);

    const responseChannel = new FakeTextChannel("response");
    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId);
    bossChannel.attachMessage(new FakeEditableMessage("111"));
    summaryChannel.attachMessage(new FakeEditableMessage("211"));
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(bossChannel);
    gateway.registerChannel(summaryChannel);

    const rowBefore = database
      .prepare<[], { count: bigint }>("select count(*) as count from AttackStatus")
      .get();

    const result = await service.declare({
      categoryId: clanData.categoryId,
      channelId: clanData.bossChannelIds[0]!,
      member: {
        id: playerData.userId,
        displayName: "Alice",
      },
      attackType: "invalid",
      responseChannel,
      discordGateway: gateway,
    });

    const rowAfter = database
      .prepare<[], { count: bigint }>("select count(*) as count from AttackStatus")
      .get();

    expect(result).toBeNull();
    expect(rowBefore?.count).toBe(0n);
    expect(rowAfter?.count).toBe(0n);
    expect(responseChannel.sentPayloads).toEqual([
      { content: USER_MESSAGES.errors.invalidAttackType },
    ]);
  });
});
