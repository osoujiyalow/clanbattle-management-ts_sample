import { afterEach, describe, expect, it } from "vitest";
import type { Guild, GuildMember, Message, User } from "discord.js";

import { AttackStatus } from "../../../../src/domain/attack-status.js";
import { AttackType } from "../../../../src/domain/attack-type.js";
import { ClanData } from "../../../../src/domain/clan-data.js";
import { PlayerData } from "../../../../src/domain/player-data.js";
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
import { AttackStatusRepository } from "../../../../src/repositories/sqlite/attack-status-repository.js";
import { createMessageCreateHandler } from "../../../../src/discord/event-handlers/message-create.js";
import {
  AttackService,
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

class FakeTextChannel implements AttackTextChannel {
  readonly messages = new Map<string, FakeEditableMessage>();
  readonly sentMessages: FakeEditableMessage[] = [];
  private nextId = 900000000000000000n;

  constructor(readonly id: string) {}

  async fetchMessage(messageId: string): Promise<FakeEditableMessage> {
    const message = this.messages.get(messageId);
    if (!message) {
      throw new Error(`Unknown message id: ${messageId}`);
    }
    return message;
  }

  async sendMessage(payload?: {
    embeds?: readonly { toJSON(): unknown }[];
    components?: readonly { toJSON(): unknown }[];
  }): Promise<FakeEditableMessage> {
    const message = new FakeEditableMessage((this.nextId++).toString());
    this.attachMessage(message);
    this.sentMessages.push(message);
    if (payload?.embeds || payload?.components) {
      await message.edit(payload);
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
  const playerRepository = new PlayerRepository(database);
  clanData.addPlayerData(playerData);
  playerRepository.insertMany(clanData.categoryId, [playerData]);
  playerRepository.update(clanData.categoryId, playerData);
}

function seedDeclaredAttack(
  database: SqliteDatabase,
  clanData: ClanData,
  playerData: PlayerData,
  options?: {
    attacked?: boolean;
  },
): AttackStatus {
  const attackStatus = new AttackStatus({
    playerData,
    attackType: AttackType.BATTLE,
    carryOver: false,
    attacked: options?.attacked ?? false,
    created: new Date("2026-03-08T00:00:00+09:00"),
  });
  clanData.bossStatusByLap.get(1)![0]!.attackPlayers.push(attackStatus);
  new AttackStatusRepository(database).insert(clanData.categoryId, 1, 0, attackStatus);
  return attackStatus;
}

interface FakeGuildMember {
  id: string;
  nickname?: string | null;
  displayName?: string | null;
  user?: {
    id: string;
    globalName?: string | null;
  } | null;
}

function createGuild(options?: {
  cachedMembers?: readonly FakeGuildMember[];
  fetchedMembers?: readonly FakeGuildMember[];
}): Guild {
  const cachedMembers = new Map<string, FakeGuildMember>();
  for (const member of options?.cachedMembers ?? []) {
    cachedMembers.set(member.id, member);
  }

  const fetchableMembers = new Map<string, FakeGuildMember>();
  for (const member of [...(options?.cachedMembers ?? []), ...(options?.fetchedMembers ?? [])]) {
    fetchableMembers.set(member.id, member);
  }

  return {
    id: "123456789012345678",
    members: {
      cache: cachedMembers,
      async fetch(input?: string | { user?: string | readonly string[] }) {
        if (typeof input === "string") {
          const member = fetchableMembers.get(input);
          if (!member) {
            throw new Error(`Unknown member id: ${input}`);
          }
          cachedMembers.set(member.id, member);
          return member;
        }

        if (input && typeof input === "object" && "user" in input) {
          const requestedUserIds = Array.isArray(input.user)
            ? [...input.user]
            : input.user
              ? [input.user]
              : [];
          const fetched = new Map<string, FakeGuildMember>();
          for (const userId of requestedUserIds) {
            const member = fetchableMembers.get(userId);
            if (!member) {
              continue;
            }
            cachedMembers.set(member.id, member);
            fetched.set(member.id, member);
          }
          return fetched;
        }

        for (const member of fetchableMembers.values()) {
          cachedMembers.set(member.id, member);
        }
        return new Map(fetchableMembers);
      },
    },
  } as Guild;
}

function createMessage(options: {
  guild: Guild | null;
  categoryId: string | null;
  channelId: string;
  userId: string;
  displayName: string;
  content: string;
  bot?: boolean;
}): Message {
  return {
    guild: options.guild,
    guildId: options.guild?.id ?? null,
    channelId: options.channelId,
    channel: {
      id: options.channelId,
      parentId: options.categoryId,
    },
    author: {
      id: options.userId,
      bot: options.bot ?? false,
      username: options.displayName,
      globalName: options.displayName,
      displayName: options.displayName,
    } as User,
    member: {
      id: options.userId,
      displayName: options.displayName,
    } as GuildMember,
    content: options.content,
  } as unknown as Message;
}

describe("messageCreate handler", () => {
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

  it("updates the latest undeclared attack damage from a boss channel message", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const attackService = new AttackService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    seedLapOneState(database, clanData);
    const playerData = new PlayerData({ userId: "333", physicsAttack: 1 });
    seedPlayer(database, clanData, playerData);
    const attackStatus = seedDeclaredAttack(database, clanData, playerData);
    runtimeStateService.set(clanData);

    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId);
    bossChannel.attachMessage(new FakeEditableMessage("111"));
    summaryChannel.attachMessage(new FakeEditableMessage("211"));
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(bossChannel);
    gateway.registerChannel(summaryChannel);
    const guild = createGuild();

    const handler = createMessageCreateHandler({
      attackService,
      runtimeStateService,
      createDiscordGateway: () => gateway,
      resolveDisplayNames: async () => new Map([[playerData.userId, "Alice"]]),
    });

    await handler(
      createMessage({
        guild,
        categoryId: clanData.categoryId,
        channelId: clanData.bossChannelIds[0]!,
        userId: playerData.userId,
        displayName: "Alice",
        content: "600 60s",
      }),
    );

    const row = database
      .prepare<[], { damage: bigint; memo: string }>(
        "select damage, memo from AttackStatus where category_id = 223456789012345678 and lap = 1 and boss_index = 0",
      )
      .get();

    expect(attackStatus.damage).toBe(600);
    expect(attackStatus.memo).toBe("60s");
    expect(row).toEqual({
      damage: 600n,
      memo: "60s",
    });
    expect(bossChannel.messages.get("111")?.edits).toHaveLength(1);
    expect(summaryChannel.messages.get("211")?.edits).toHaveLength(1);
  });

  it("ignores managed member damage messages without a declaration", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const attackService = new AttackService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    seedLapOneState(database, clanData);
    const playerData = new PlayerData({ userId: "333", physicsAttack: 1 });
    seedPlayer(database, clanData, playerData);
    runtimeStateService.set(clanData);

    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId);
    bossChannel.attachMessage(new FakeEditableMessage("111"));
    summaryChannel.attachMessage(new FakeEditableMessage("211"));
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(bossChannel);
    gateway.registerChannel(summaryChannel);
    const guild = createGuild();

    const handler = createMessageCreateHandler({
      attackService,
      runtimeStateService,
      createDiscordGateway: () => gateway,
      resolveDisplayNames: async () => new Map([[playerData.userId, "Alice"]]),
    });

    await handler(
      createMessage({
        guild,
        categoryId: clanData.categoryId,
        channelId: clanData.bossChannelIds[0]!,
        userId: playerData.userId,
        displayName: "Alice",
        content: "600",
      }),
    );

    expect(bossChannel.messages.get("111")?.edits).toHaveLength(0);
    expect(summaryChannel.messages.get("211")?.edits).toHaveLength(0);
  });

  it("ignores unrelated messages without changing state", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const attackService = new AttackService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    seedLapOneState(database, clanData);
    const playerData = new PlayerData({ userId: "333", physicsAttack: 1 });
    seedPlayer(database, clanData, playerData);
    const attackStatus = seedDeclaredAttack(database, clanData, playerData);
    runtimeStateService.set(clanData);

    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId);
    bossChannel.attachMessage(new FakeEditableMessage("111"));
    summaryChannel.attachMessage(new FakeEditableMessage("211"));
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(bossChannel);
    gateway.registerChannel(summaryChannel);
    const guild = createGuild();

    const handler = createMessageCreateHandler({
      attackService,
      runtimeStateService,
      createDiscordGateway: () => gateway,
      resolveDisplayNames: async () => new Map([[playerData.userId, "Alice"]]),
    });

    await handler(
      createMessage({
        guild,
        categoryId: clanData.categoryId,
        channelId: "999",
        userId: playerData.userId,
        displayName: "Alice",
        content: "600",
      }),
    );
    await handler(
      createMessage({
        guild,
        categoryId: clanData.categoryId,
        channelId: clanData.bossChannelIds[0]!,
        userId: "999999999999999999",
        displayName: "Ghost",
        content: "600",
      }),
    );
    await handler(
      createMessage({
        guild,
        categoryId: clanData.categoryId,
        channelId: clanData.bossChannelIds[0]!,
        userId: playerData.userId,
        displayName: "Alice",
        content: "hello world",
      }),
    );

    const row = database
      .prepare<[], { damage: bigint; memo: string }>(
        "select damage, memo from AttackStatus where category_id = 223456789012345678 and lap = 1 and boss_index = 0",
      )
      .get();

    expect(attackStatus.damage).toBe(0);
    expect(attackStatus.memo).toBe("");
    expect(row).toEqual({
      damage: 0n,
      memo: "",
    });
    expect(bossChannel.messages.get("111")?.edits).toHaveLength(0);
    expect(summaryChannel.messages.get("211")?.edits).toHaveLength(0);
  });

  it("fills missing managed member names when damage input redraws progress from messageCreate", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const attackService = new AttackService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    seedLapOneState(database, clanData);
    const alice = new PlayerData({ userId: "333", physicsAttack: 1 });
    const bob = new PlayerData({ userId: "444" });
    seedPlayer(database, clanData, alice);
    seedPlayer(database, clanData, bob);
    const aliceAttackStatus = seedDeclaredAttack(database, clanData, alice);
    seedDeclaredAttack(database, clanData, bob);
    runtimeStateService.set(clanData);

    const bossChannel = new FakeTextChannel(clanData.bossChannelIds[0]!);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId);
    bossChannel.attachMessage(new FakeEditableMessage("111"));
    summaryChannel.attachMessage(new FakeEditableMessage("211"));
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(bossChannel);
    gateway.registerChannel(summaryChannel);

    const handler = createMessageCreateHandler({
      attackService,
      runtimeStateService,
      createDiscordGateway: () => gateway,
    });

    const guild = createGuild({
      cachedMembers: [
        {
          id: alice.userId,
          nickname: "Alice",
          user: {
            id: alice.userId,
            globalName: "Alice",
          },
        },
      ],
      fetchedMembers: [
        {
          id: bob.userId,
          nickname: "Bob",
          user: {
            id: bob.userId,
            globalName: "Bob",
          },
        },
      ],
    });

    await handler(
      createMessage({
        guild,
        categoryId: clanData.categoryId,
        channelId: clanData.bossChannelIds[0]!,
        userId: alice.userId,
        displayName: "Alice",
        content: "600 60s",
      }),
    );

    const progressEmbedText = JSON.stringify(
      bossChannel.messages.get("111")?.edits[0]?.embeds?.[0],
    );
    const summaryEmbedText = JSON.stringify(
      summaryChannel.messages.get("211")?.edits[0]?.embeds?.[0],
    );

    expect(aliceAttackStatus.damage).toBe(600);
    expect(progressEmbedText).toContain("Alice");
    expect(progressEmbedText).toContain("Bob");
    expect(summaryEmbedText).toContain("残");
  });

  it("creates fresh remain and summary messages on the first category message after rollover", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const attackService = new AttackService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    clanData.date = "2026-03-07";
    seedLapOneState(database, clanData);
    const playerData = new PlayerData({ userId: "333", physicsAttack: 1 });
    seedPlayer(database, clanData, playerData);
    runtimeStateService.set(clanData);

    const remainChannel = new FakeTextChannel(clanData.remainAttackChannelId);
    const summaryChannel = new FakeTextChannel(clanData.summaryChannelId);
    summaryChannel.attachMessage(new FakeEditableMessage("211"));
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(remainChannel);
    gateway.registerChannel(summaryChannel);
    const guild = createGuild();

    const handler = createMessageCreateHandler({
      attackService,
      runtimeStateService,
      createDiscordGateway: () => gateway,
      resolveDisplayNames: async () => new Map([[playerData.userId, "Alice"]]),
    });

    await handler(
      createMessage({
        guild,
        categoryId: clanData.categoryId,
        channelId: clanData.commandChannelId,
        userId: playerData.userId,
        displayName: "Alice",
        content: "hello world",
      }),
    );

    const currentSummaryMessageId = clanData.summaryMessageIdsByLap.get(1)?.[0];

    expect(clanData.date).toBe("2026-03-08");
    expect(clanData.remainAttackMessageId).toBe(remainChannel.sentMessages[0]?.id);
    expect(remainChannel.sentMessages).toHaveLength(1);
    expect(summaryChannel.sentMessages).toHaveLength(1);
    expect(currentSummaryMessageId).toBe(summaryChannel.sentMessages[0]?.id);
    expect(currentSummaryMessageId).not.toBe("211");
    expect(summaryChannel.messages.get("211")?.edits).toHaveLength(0);
  });
});
