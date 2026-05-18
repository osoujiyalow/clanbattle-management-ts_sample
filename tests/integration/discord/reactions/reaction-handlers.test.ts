import { afterEach, describe, expect, it } from "vitest";
import type { Guild, Message, MessageReaction, PartialMessageReaction, User } from "discord.js";

import { EMOJIS } from "../../../../src/constants/emojis.js";
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
import { CarryOverRepository } from "../../../../src/repositories/sqlite/carry-over-repository.js";
import { PlayerRepository } from "../../../../src/repositories/sqlite/player-repository.js";
import { createReactionAddHandler } from "../../../../src/discord/event-handlers/reaction-add.js";
import { createReactionRemoveHandler } from "../../../../src/discord/event-handlers/reaction-remove.js";
import {
  AttackService,
  type AttackDiscordGateway,
  type AttackEditableMessage,
  type AttackTextChannel,
} from "../../../../src/services/attack-service.js";
import {
  MemberService,
  type MemberDiscordGateway,
  type MemberEditableMessage,
  type MemberTextChannel,
} from "../../../../src/services/member-service.js";
import { RuntimeStateService } from "../../../../src/services/runtime-state-service.js";
import { createFixedClock } from "../../../../src/shared/time.js";
import { createCoreRepositorySchema } from "../../../unit/repositories/sqlite/core-repository-schema.js";
import { createTempSqlitePath, type TempSqlitePath } from "../../../unit/repositories/sqlite/test-sqlite-path.js";

class FakeEditableMessage implements AttackEditableMessage, MemberEditableMessage {
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

class FakeNoticeMessage {
  deleted = false;

  async delete(): Promise<void> {
    this.deleted = true;
  }
}

class FakeTextChannel implements AttackTextChannel, MemberTextChannel {
  readonly messages = new Map<string, FakeEditableMessage>();
  readonly warningPayloads: Array<{ content?: string }> = [];
  readonly noticeMessages: FakeNoticeMessage[] = [];
  readonly sentMessages: FakeEditableMessage[] = [];

  constructor(
    readonly id: string,
    readonly parentId: string | null,
    private readonly nextId: () => string,
  ) {}

  async fetchMessage(messageId: string): Promise<FakeEditableMessage> {
    const message = this.messages.get(messageId);
    if (!message) {
      throw new Error(`Unknown message id: ${messageId}`);
    }
    return message;
  }

  async sendMessage(payload: {
    content?: string;
    embeds?: readonly { toJSON(): unknown }[];
    components?: readonly { toJSON(): unknown }[];
  }): Promise<FakeEditableMessage> {
    const message = new FakeEditableMessage(this.nextId());
    this.attachMessage(message);
    this.sentMessages.push(message);

    if (payload.embeds || payload.components) {
      await message.edit(payload);
    }

    return message;
  }

  async send(payload: { content?: string }): Promise<FakeNoticeMessage> {
    this.warningPayloads.push(payload);
    const notice = new FakeNoticeMessage();
    this.noticeMessages.push(notice);
    return notice;
  }

  attachMessage(message: FakeEditableMessage): void {
    this.messages.set(message.id, message);
  }
}

class FakeDiscordGateway implements AttackDiscordGateway, MemberDiscordGateway {
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

class FakeReactionUsersManager {
  readonly removedUserIds: string[] = [];

  async remove(userId: string): Promise<void> {
    this.removedUserIds.push(userId);
  }
}

function createSnowflakeFactory(start = 900000000000000000n): () => string {
  let current = start;
  return () => (current++).toString();
}

function createClanData(options?: {
  date?: string;
}): ClanData {
  return new ClanData({
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
    commandChannelId: "1023456789012345678",
    summaryChannelId: "1123456789012345678",
    remainAttackMessageId: "611",
    progressMessageIdsByLap: new Map([[1, ["111", "112", "113", "114", "115"]]]),
    summaryMessageIdsByLap: new Map([[1, ["211", null, null, null, null]]]),
    date: options?.date ?? "2026-03-08",
  });
}

function seedLapOneState(database: SqliteDatabase, clanData: ClanData): void {
  clanData.initializeBossStatusData(1);
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
  const carryOverRepository = new CarryOverRepository(database);

  playerRepository.insertMany(clanData.categoryId, [playerData]);
  playerRepository.update(clanData.categoryId, playerData);
  carryOverRepository.replaceAll(clanData.categoryId, playerData.userId, playerData.carryOverList);
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

function createUser(userId: string, displayName: string, bot = false): User {
  return {
    id: userId,
    bot,
    username: displayName,
    globalName: displayName,
    displayName,
  } as unknown as User;
}

function createReactionMessage(options: {
  messageId: string;
  channel: FakeTextChannel;
  guild: Guild;
  partial?: boolean;
}): Message {
  const message = {
    id: options.messageId,
    partial: options.partial ?? false,
    guild: options.guild,
    channelId: options.channel.id,
    channel: options.channel,
    async fetch() {
      this.partial = false;
      return this as Message;
    },
  };

  return message as unknown as Message;
}

function createReaction(options: {
  message: Message;
  emoji: string;
  partial?: boolean;
}): (MessageReaction | PartialMessageReaction) & { users: FakeReactionUsersManager } {
  const reaction = {
    partial: options.partial ?? false,
    emoji: {
      name: options.emoji,
      toString: () => options.emoji,
    },
    message: options.message,
    users: new FakeReactionUsersManager(),
    async fetch() {
      this.partial = false;
      return this as MessageReaction;
    },
  };

  return reaction as unknown as (MessageReaction | PartialMessageReaction) & {
    users: FakeReactionUsersManager;
  };
}

describe("reaction handlers", () => {
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

  it("ignores legacy progress declare reactions without mutating state", async () => {
    const nextId = createSnowflakeFactory();
    const bossChannel = new FakeTextChannel("323456789012345678", "223456789012345678", nextId);
    const guild = createGuild();
    const reaction = createReaction({
      message: createReactionMessage({
        messageId: "111",
        channel: bossChannel,
        guild,
        partial: true,
      }),
      emoji: EMOJIS.magic,
      partial: true,
    });

    const handler = createReactionAddHandler({
      runtimeStateService: {
        get() {
          throw new Error("legacy progress reactions must be ignored before runtime lookup");
        },
        async ensureDateUpToDate() {
          throw new Error("legacy progress reactions must not trigger date updates");
        },
      },
      memberService: {
        async ensureCurrentRemainAttackMessage() {
          throw new Error("legacy progress reactions must not ensure remain attack");
        },
        async setTaskKill() {
          throw new Error("legacy progress reactions must not toggle task-kill");
        },
      },
    });

    await handler(reaction, createUser("333333333333333333", "Alice"));

    expect(reaction.users.removedUserIds).toHaveLength(0);
    expect(bossChannel.warningPayloads).toHaveLength(0);
  });

  it("ignores legacy progress finish, defeat, and undo reactions", async () => {
    const nextId = createSnowflakeFactory();
    const bossChannel = new FakeTextChannel("323456789012345678", "223456789012345678", nextId);
    const guild = createGuild();
    const handler = createReactionAddHandler({
      runtimeStateService: {
        get() {
          throw new Error("legacy progress reactions must be ignored before runtime lookup");
        },
        async ensureDateUpToDate() {
          throw new Error("legacy progress reactions must not trigger date updates");
        },
      },
      memberService: {
        async ensureCurrentRemainAttackMessage() {
          throw new Error("legacy progress reactions must not ensure remain attack");
        },
        async setTaskKill() {
          throw new Error("legacy progress reactions must not toggle task-kill");
        },
      },
    });

    for (const emoji of [EMOJIS.attack, EMOJIS.lastAttack, EMOJIS.reverse]) {
      const reaction = createReaction({
        message: createReactionMessage({
          messageId: "111",
          channel: bossChannel,
          guild,
        }),
        emoji,
      });

      await handler(reaction, createUser("333333333333333333", "Alice"));

      expect(reaction.users.removedUserIds).toHaveLength(0);
    }

    expect(bossChannel.warningPayloads).toHaveLength(0);
  });

  it("toggles task-kill from reaction add and remove without removing the reaction", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({
      database,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });
    const attackService = new AttackService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });
    const memberService = new MemberService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    seedLapOneState(database, clanData);
    const playerData = new PlayerData({ userId: "333333333333333333" });
    seedPlayer(database, clanData, playerData);
    runtimeStateService.set(clanData);

    const nextId = createSnowflakeFactory();
    const remainChannel = new FakeTextChannel(
      clanData.remainAttackChannelId,
      clanData.categoryId,
      nextId,
    );
    remainChannel.attachMessage(new FakeEditableMessage(clanData.remainAttackMessageId!));
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(remainChannel);

    const addHandler = createReactionAddHandler({
      runtimeStateService,
      attackService,
      memberService,
      createDiscordGateway: () => gateway,
      resolveDisplayNames: async () => new Map([[playerData.userId, "Alice"]]),
    });
    const removeHandler = createReactionRemoveHandler({
      runtimeStateService,
      memberService,
      createDiscordGateway: () => gateway,
      resolveDisplayNames: async () => new Map([[playerData.userId, "Alice"]]),
    });

    const guild = createGuild();
    const reactionMessage = createReactionMessage({
      messageId: clanData.remainAttackMessageId!,
      channel: remainChannel,
      guild,
    });
    const addReaction = createReaction({
      message: reactionMessage,
      emoji: EMOJIS.taskKill,
    });
    const removeReaction = createReaction({
      message: reactionMessage,
      emoji: EMOJIS.taskKill,
    });

    await addHandler(addReaction, createUser(playerData.userId, "Alice"));
    await removeHandler(removeReaction, createUser(playerData.userId, "Alice"));

    const row = database
      .prepare<[], { task_kill: bigint }>("select task_kill from PlayerData where user_id = 333333333333333333")
      .get();

    expect(playerData.taskKill).toBe(false);
    expect(row?.task_kill).toBe(0n);
    expect(addReaction.users.removedUserIds).toHaveLength(0);
    expect(removeReaction.users.removedUserIds).toHaveLength(0);
    expect(remainChannel.messages.get(clanData.remainAttackMessageId!)?.edits).toHaveLength(2);
  });

  it("fills missing managed member names when task-kill redraws remain-attack from a reaction", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({
      database,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });
    const attackService = new AttackService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });
    const memberService = new MemberService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData();
    seedLapOneState(database, clanData);
    const actorPlayer = new PlayerData({ userId: "333333333333333333" });
    const uncachedPlayer = new PlayerData({ userId: "444444444444444444" });
    seedPlayer(database, clanData, actorPlayer);
    seedPlayer(database, clanData, uncachedPlayer);
    runtimeStateService.set(clanData);

    const nextId = createSnowflakeFactory();
    const remainChannel = new FakeTextChannel(
      clanData.remainAttackChannelId,
      clanData.categoryId,
      nextId,
    );
    remainChannel.attachMessage(new FakeEditableMessage(clanData.remainAttackMessageId!));
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(remainChannel);

    const handler = createReactionAddHandler({
      runtimeStateService,
      attackService,
      memberService,
      createDiscordGateway: () => gateway,
    });

    const guild = createGuild({
      cachedMembers: [
        {
          id: actorPlayer.userId,
          nickname: "Alice",
          user: {
            id: actorPlayer.userId,
            globalName: "Alice",
          },
        },
      ],
      fetchedMembers: [
        {
          id: uncachedPlayer.userId,
          nickname: "Bob",
          user: {
            id: uncachedPlayer.userId,
            globalName: "Bob",
          },
        },
      ],
    });
    const reactionMessage = createReactionMessage({
      messageId: clanData.remainAttackMessageId!,
      channel: remainChannel,
      guild,
    });
    const reaction = createReaction({
      message: reactionMessage,
      emoji: EMOJIS.taskKill,
    });

    await handler(reaction, createUser(actorPlayer.userId, "Alice"));

    const remainEmbedText = JSON.stringify(
      remainChannel.messages.get(clanData.remainAttackMessageId!)?.edits[0]?.embeds?.[0],
    );

    expect(actorPlayer.taskKill).toBe(true);
    expect(remainEmbedText).toContain("Alice");
    expect(remainEmbedText).toContain("Bob");
    expect(remainEmbedText).not.toContain(uncachedPlayer.userId);
  });

  it("ignores task-kill reactions on a historical remain-attack message after rollover", async () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({
      database,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });
    const attackService = new AttackService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });
    const memberService = new MemberService({
      database,
      runtimeStateService,
      clock: createFixedClock("2026-03-08T06:00:00+09:00"),
    });

    const clanData = createClanData({ date: "2026-03-07" });
    seedLapOneState(database, clanData);
    const playerData = new PlayerData({ userId: "333333333333333333" });
    seedPlayer(database, clanData, playerData);
    runtimeStateService.set(clanData);

    const nextId = createSnowflakeFactory();
    const remainChannel = new FakeTextChannel(
      clanData.remainAttackChannelId,
      clanData.categoryId,
      nextId,
    );
    const summaryChannel = new FakeTextChannel(
      clanData.summaryChannelId,
      clanData.categoryId,
      nextId,
    );
    const historicalRemainMessage = new FakeEditableMessage(clanData.remainAttackMessageId!);
    remainChannel.attachMessage(historicalRemainMessage);
    const gateway = new FakeDiscordGateway();
    gateway.registerChannel(remainChannel);
    gateway.registerChannel(summaryChannel);

    const addHandler = createReactionAddHandler({
      runtimeStateService,
      attackService,
      memberService,
      createDiscordGateway: () => gateway,
      resolveDisplayNames: async () => new Map([[playerData.userId, "Alice"]]),
    });
    const removeHandler = createReactionRemoveHandler({
      runtimeStateService,
      memberService,
      createDiscordGateway: () => gateway,
      resolveDisplayNames: async () => new Map([[playerData.userId, "Alice"]]),
    });

    const guild = createGuild();
    const reactionMessage = createReactionMessage({
      messageId: "611",
      channel: remainChannel,
      guild,
    });
    const addReaction = createReaction({
      message: reactionMessage,
      emoji: EMOJIS.taskKill,
    });
    const removeReaction = createReaction({
      message: reactionMessage,
      emoji: EMOJIS.taskKill,
    });

    await addHandler(addReaction, createUser(playerData.userId, "Alice"));
    await removeHandler(removeReaction, createUser(playerData.userId, "Alice"));

    const playerRow = database
      .prepare<[], { task_kill: bigint }>("select task_kill from PlayerData where user_id = 333333333333333333")
      .get();
    const currentRemainMessageId = clanData.remainAttackMessageId!;

    expect(clanData.date).toBe("2026-03-08");
    expect(currentRemainMessageId).not.toBe("611");
    expect(playerData.taskKill).toBe(false);
    expect(playerRow?.task_kill).toBe(0n);
    expect(addReaction.users.removedUserIds).toHaveLength(0);
    expect(removeReaction.users.removedUserIds).toHaveLength(0);
    expect(historicalRemainMessage.edits).toHaveLength(0);
    expect(remainChannel.sentMessages).toHaveLength(1);
    expect(summaryChannel.sentMessages).toHaveLength(1);
    expect(remainChannel.messages.get(currentRemainMessageId)?.edits).toHaveLength(1);
  });

});
