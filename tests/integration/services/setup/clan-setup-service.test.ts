import { afterEach, describe, expect, it } from "vitest";

import { EMOJIS } from "../../../../src/constants/emojis.js";
import { USER_MESSAGES } from "../../../../src/constants/messages.js";
import { ProgressMessageIdRepository } from "../../../../src/repositories/sqlite/boss-message-id-repository.js";
import { ClanRepository } from "../../../../src/repositories/sqlite/clan-repository.js";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
  type SqliteDatabase,
} from "../../../../src/repositories/sqlite/db.js";
import {
  ClanSetupService,
  SetupPermissionError,
  type SetupCategory,
  type SetupGuild,
  type SetupMessage,
  type SetupSendPayload,
  type SetupTextChannel,
} from "../../../../src/services/clan-setup-service.js";
import { RuntimeStateService } from "../../../../src/services/runtime-state-service.js";
import { createFixedClock } from "../../../../src/shared/time.js";
import { createCoreRepositorySchema } from "../../../unit/repositories/sqlite/core-repository-schema.js";
import { createTempSqlitePath, type TempSqlitePath } from "../../../unit/repositories/sqlite/test-sqlite-path.js";

interface RecordedPayload {
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
}

class FakeSetupMessage implements SetupMessage {
  readonly reactions: string[] = [];

  constructor(
    readonly id: string,
    readonly payload: RecordedPayload,
  ) {}

  async addReaction(emoji: string): Promise<void> {
    this.reactions.push(emoji);
  }
}

class FakeTextChannel implements SetupTextChannel {
  readonly messages: FakeSetupMessage[] = [];
  deleted = false;

  constructor(
    readonly id: string,
    readonly name: string,
    protected readonly idFactory: () => string,
  ) {}

  async send(payload: SetupSendPayload): Promise<FakeSetupMessage> {
    const message = this.createMessage({
      content: payload.content,
      embeds: payload.embeds?.map((embed) => embed.toJSON()),
      components: payload.components?.map((component) => component.toJSON()),
    });
    this.messages.push(message);
    return message;
  }

  async delete(): Promise<void> {
    this.deleted = true;
  }

  protected createMessage(payload: RecordedPayload): FakeSetupMessage {
    return new FakeSetupMessage(this.idFactory(), payload);
  }
}

class FakeSendFailingTextChannel extends FakeTextChannel {
  async send(): Promise<FakeSetupMessage> {
    throw new Error("Failed to send progress message");
  }
}

class FakeCategory implements SetupCategory {
  readonly channels: FakeTextChannel[] = [];
  deleted = false;

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly idFactory: () => string,
    private readonly createTextChannelImpl?: (name: string) => Promise<FakeTextChannel>,
  ) {}

  async createTextChannel(name: string): Promise<FakeTextChannel> {
    const channel = this.createTextChannelImpl
      ? await this.createTextChannelImpl(name)
      : new FakeTextChannel(this.idFactory(), name, this.idFactory);
    this.channels.push(channel);
    return channel;
  }

  async delete(): Promise<void> {
    this.deleted = true;
  }
}

class FakeGuild implements SetupGuild {
  readonly createdCategories: FakeCategory[] = [];

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly idFactory: () => string,
    private readonly createCategoryImpl?: (name: string) => Promise<FakeCategory>,
  ) {}

  async createCategory(name: string): Promise<FakeCategory> {
    if (this.createCategoryImpl) {
      const category = await this.createCategoryImpl(name);
      this.createdCategories.push(category);
      return category;
    }

    const category = new FakeCategory(this.idFactory(), name, this.idFactory);
    this.createdCategories.push(category);
    return category;
  }
}

function createSnowflakeFactory(start = 1000000000000000000n): () => string {
  let current = start;

  return () => {
    const value = current.toString();
    current += 1n;
    return value;
  };
}

describe("ClanSetupService", () => {
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

  it("creates setup channels, initial messages, and persists lap 1 state", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new ClanSetupService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T00:00:00+09:00"),
    });

    const nextId = createSnowflakeFactory();
    const guild = new FakeGuild("123456789012345678", "Test Guild", nextId);
    const responseChannel = new FakeTextChannel(nextId(), "invoke", nextId);

    const result = await service.execute({
      guild,
      responseChannel,
    });

    expect(result).not.toBeNull();
    expect(guild.createdCategories).toHaveLength(1);
    expect(guild.createdCategories[0]?.name).toBe("凸管理");
    expect(guild.createdCategories[0]?.channels.map((channel) => channel.name)).toEqual([
      "クラバト雑談",
      "ボス1",
      "ボス2",
      "ボス3",
      "ボス4",
      "ボス5",
      "進行把握板",
      "残凸把握板",
      "コマンド入力板",
      "持越変換",
    ]);

    expect(responseChannel.messages.map((message) => message.payload.content)).toEqual([
      USER_MESSAGES.setup.started,
      USER_MESSAGES.setup.completed,
    ]);

    const boss1Channel = guild.createdCategories[0]!.channels[1]!;
    const summaryChannel = guild.createdCategories[0]!.channels[6]!;
    const remainAttackChannel = guild.createdCategories[0]!.channels[7]!;
    const tlConversionChannel = guild.createdCategories[0]!.channels[9]!;

    expect(boss1Channel.messages).toHaveLength(1);
    expect(summaryChannel.messages).toHaveLength(1);
    expect(remainAttackChannel.messages).toHaveLength(1);
    expect(tlConversionChannel.messages).toHaveLength(1);
    expect(tlConversionChannel.messages[0]?.payload.content).toBe("/tlコマンドでTL変換できます。");
    expect(boss1Channel.messages[0]?.payload.components).toHaveLength(2);
    expect(remainAttackChannel.messages[0]?.reactions).toEqual([EMOJIS.taskKill]);
    expect(summaryChannel.messages[0]?.payload.embeds?.[0]).toMatchObject({
      color: 3066993,
      title: "3月7日の進行状況",
      description: expect.stringContaining("残 0凸 0持"),
    });

    expect(boss1Channel.messages[0]?.payload.embeds?.[0]).toMatchInlineSnapshot(`
      {
        "color": 15158332,
        "description": "
      ",
        "title": "[1周目] 1ボス 1,200万/1,200万 合計 0万",
      }
    `);
    expect(remainAttackChannel.messages[0]?.payload.embeds?.[0]).toMatchObject({
      color: 15105570,
      description: "残 0凸 0持",
    });

    const clanRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from ClanData")
      .get();
    const bossStatusRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from BossStatusData")
      .get();
    const progressRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from ProgressMessageIdData")
      .get();
    const summaryRow = database
      .prepare<[], { count: bigint }>("select count(*) as count from SummaryMessageIdData")
      .get();

    expect(clanRow?.count).toBe(1n);
    expect(bossStatusRow?.count).toBe(5n);
    expect(progressRow?.count).toBe(1n);
    expect(summaryRow?.count).toBe(1n);
    expect(new ProgressMessageIdRepository(database).findAllGroupedByCategory().size).toBe(1);
    expect(runtimeStateService.get(result!.clanData.categoryId)?.progressMessageIdsByLap.get(1)?.[0]).toBe(
      boss1Channel.messages[0]!.id,
    );
  });

  it("reports missing channel permissions and skips DB writes", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new ClanSetupService({
      database,
      runtimeStateService,
    });

    const nextId = createSnowflakeFactory();
    const guild = new FakeGuild(
      "123456789012345678",
      "Test Guild",
      nextId,
      async () => {
        throw new SetupPermissionError();
      },
    );
    const responseChannel = new FakeTextChannel(nextId(), "invoke", nextId);

    const result = await service.execute({
      guild,
      responseChannel,
      categoryChannelName: "custom",
    });

    expect(result).toBeNull();
    expect(responseChannel.messages.map((message) => message.payload.content)).toEqual([
      USER_MESSAGES.setup.started,
      USER_MESSAGES.setup.missingPermission,
    ]);
    expect(new ClanRepository(database).findAll().size).toBe(0);
    expect(runtimeStateService.getAll().size).toBe(0);
  });

  it("rolls back created Discord resources when setup fails after channel creation", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const service = new ClanSetupService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T00:00:00+09:00"),
    });

    const nextId = createSnowflakeFactory();
    const failingCategory = new FakeCategory(
      nextId(),
      "凸管理",
      nextId,
      async (name) =>
        name === "ボス1"
          ? new FakeSendFailingTextChannel(nextId(), name, nextId)
          : new FakeTextChannel(nextId(), name, nextId),
    );
    const guild = new FakeGuild(
      "123456789012345678",
      "Test Guild",
      nextId,
      async () => failingCategory,
    );
    const responseChannel = new FakeTextChannel(nextId(), "invoke", nextId);

    const result = await service.execute({
      guild,
      responseChannel,
    });

    expect(result).toBeNull();
    expect(responseChannel.messages).toHaveLength(2);
    expect(responseChannel.messages[0]?.payload.content).toBe(USER_MESSAGES.setup.started);
    expect(responseChannel.messages[1]?.payload.content).toContain("チャンネルの作成に失敗しました");
    expect(responseChannel.messages[1]?.payload.content).toContain("Failed to send progress message");
    expect(failingCategory.deleted).toBe(true);
    expect(failingCategory.channels).toHaveLength(10);
    expect(failingCategory.channels.every((channel) => channel.deleted)).toBe(true);
    expect(new ClanRepository(database).findAll().size).toBe(0);
    expect(runtimeStateService.getAll().size).toBe(0);
  });
});
