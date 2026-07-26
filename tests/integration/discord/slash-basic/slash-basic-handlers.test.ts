import {
  ChannelType,
  Collection,
  MessageFlags,
  PermissionFlagsBits,
  type APIRole,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type Role,
  type User,
} from "discord.js";
import { describe, expect, it } from "vitest";

import { ClanData } from "../../../../src/domain/clan-data.js";
import { PlayerData } from "../../../../src/domain/player-data.js";
import { registerMemberCommandHandlers } from "../../../../src/discord/command-handlers/member.js";
import { registerQueryCommandHandlers } from "../../../../src/discord/command-handlers/query.js";
import { registerSetupCommandHandlers } from "../../../../src/discord/command-handlers/setup.js";
import { InteractionRouter } from "../../../../src/discord/interaction-router.js";
import { SLASH_COMMAND_PAYLOADS } from "../../../../src/discord/register-commands.js";
import type { Logger } from "../../../../src/shared/logger.js";

type RecordedReply = { content: string; ephemeral: boolean };

function normalizeRecordedReply(payload: {
  content?: string;
  ephemeral?: boolean;
  flags?: MessageFlags;
}): RecordedReply {
  return {
    content: payload.content ?? "",
    ephemeral: payload.ephemeral ?? payload.flags === MessageFlags.Ephemeral,
  };
}

function createMemoryLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

class FakeMembersManager {
  readonly cache: Collection<string, GuildMember>;
  fetchAllCount = 0;

  constructor(
    private readonly membersById: Map<string, GuildMember>,
    private readonly allMembers: Collection<string, GuildMember>,
    cachedMembers: ReadonlyMap<string, GuildMember> = membersById,
  ) {
    this.cache = new Collection(Array.from(cachedMembers.entries()));
  }

  async fetch(
    input?: string | { user?: string | readonly string[] },
  ): Promise<GuildMember | Collection<string, GuildMember>> {
    if (!input) {
      this.fetchAllCount += 1;
      for (const [memberId, member] of this.allMembers.entries()) {
        this.cache.set(memberId, member);
      }
      return this.allMembers;
    }

    if (typeof input === "string") {
      const member = this.membersById.get(input);
      if (!member) {
        const error = new Error(`Unknown member: ${input}`) as Error & { code: number };
        error.code = 10_007;
        throw error;
      }

      this.cache.set(member.id, member);
      return member;
    }

    const requestedUserIds = Array.isArray(input.user)
      ? [...input.user]
      : input.user
        ? [input.user]
        : [];
    const fetched = new Collection(
      requestedUserIds.flatMap((userId) => {
        const member = this.membersById.get(userId);
        return member ? [[userId, member] as const] : [];
      }),
    );
    for (const [memberId, member] of fetched.entries()) {
      this.cache.set(memberId, member);
    }
    return fetched;
  }
}

class FakeChannelsManager {
  constructor(private readonly channelsById: Map<string, GuildBasedChannel>) {}

  async fetch(channelId: string): Promise<GuildBasedChannel | null> {
    return this.channelsById.get(channelId) ?? null;
  }
}

function createGuildMember(
  id: string,
  displayName: string,
  roleIds: string[] = [],
): GuildMember {
  return {
    id,
    displayName,
    roles: {
      cache: new Collection(roleIds.map((roleId) => [roleId, { id: roleId }])),
    },
  } as unknown as GuildMember;
}

function createGuildChannel(
  id: string,
  parentId: string | null,
  type: ChannelType = ChannelType.GuildText,
): GuildBasedChannel {
  return {
    id,
    parentId,
    type,
    isTextBased: () => true,
    name: `channel-${id}`,
    send: async () => {
      throw new Error("send should not be called in slash-basic handler tests");
    },
    messages: {
      fetch: async () => {
        throw new Error("fetch should not be called in slash-basic handler tests");
      },
    },
  } as unknown as GuildBasedChannel;
}

function createInteraction(options: {
  commandName: string;
  optionValues?: Record<string, unknown>;
  guild?: Guild;
  user?: User;
  member?: GuildMember;
  channelId?: string;
  hasAdministratorPermission?: boolean;
  buttonSelection?: "increase" | "decrease" | "cancel";
}): {
  interaction: ChatInputCommandInteraction;
  replies: RecordedReply[];
  deletedReplies: number[];
} {
  const replies: RecordedReply[] = [];
  const deletedReplies: number[] = [];
  const optionValues = options.optionValues ?? {};
  let replied = false;
  let deferred = false;
  let deferredEphemeral = false;
  let confirmationCustomIds: string[] = [];

  const interaction = {
    commandName: options.commandName,
    id: "interaction-1",
    guild: options.guild ?? null,
    guildId: options.guild?.id ?? null,
    channelId: options.channelId ?? "333333333333333333",
    channel: {
      id: options.channelId ?? "333333333333333333",
      name: "invoke-channel",
      isTextBased: () => true,
    },
    user:
      options.user ??
      ({
        id: "111111111111111111",
        username: "Invoker",
        globalName: "Invoker",
        displayName: "Invoker",
      } as User),
    member: options.member ?? createGuildMember("111111111111111111", "Invoker"),
    memberPermissions: {
      has(permission: bigint) {
        if (permission === PermissionFlagsBits.Administrator) {
          return options.hasAdministratorPermission ?? true;
        }

        return false;
      },
    },
    get deferred() {
      return deferred;
    },
    get replied() {
      return replied;
    },
    isChatInputCommand: () => true,
    isButton: () => false,
    isModalSubmit: () => false,
    isRepliable: () => true,
    options: {
      getString(name: string) {
        const value = optionValues[name];
        return typeof value === "string" ? value : null;
      },
      getInteger(name: string, required?: boolean) {
        const value = optionValues[name];
        if (typeof value === "number") {
          return value;
        }
        if (required) {
          throw new Error(`Missing integer option: ${name}`);
        }
        return null;
      },
      getBoolean(name: string) {
        const value = optionValues[name];
        return typeof value === "boolean" ? value : null;
      },
      getUser(name: string) {
        const value = optionValues[name];
        return value && typeof value === "object" ? (value as User) : null;
      },
      getRole(name: string) {
        const value = optionValues[name];
        return value && typeof value === "object" ? (value as Role | APIRole) : null;
      },
    },
    async deferReply(payload?: { flags?: MessageFlags }) {
      deferred = true;
      deferredEphemeral = payload?.flags === MessageFlags.Ephemeral;
    },
    async reply(payload: { content?: string; ephemeral?: boolean; flags?: MessageFlags }) {
      replied = true;
      replies.push(normalizeRecordedReply(payload));
    },
    async editReply(payload: {
      content?: string;
      components?: readonly { toJSON(): { components?: Array<{ custom_id?: string }> } }[];
    }) {
      replied = true;
      confirmationCustomIds =
        payload.components?.flatMap(
          (row) => row.toJSON().components?.flatMap((component) => component.custom_id ?? []) ?? [],
        ) ?? [];
      replies.push(
        normalizeRecordedReply({
          content: payload.content,
          ...(deferredEphemeral ? { flags: MessageFlags.Ephemeral } : {}),
        }),
      );
    },
    async followUp(payload: { content?: string; ephemeral?: boolean; flags?: MessageFlags }) {
      replies.push(normalizeRecordedReply(payload));
    },
    async fetchReply() {
      return {
        async awaitMessageComponent(collectorOptions: {
          filter(interaction: { user: User; customId: string }): boolean;
        }) {
          const selectedSuffix = options.buttonSelection ?? "cancel";
          const customId = confirmationCustomIds.find((candidate) =>
            candidate.endsWith(`:${selectedSuffix}`),
          );
          if (!customId) {
            throw new Error("Confirmation button was not rendered");
          }

          const buttonInteraction = {
            user: interaction.user,
            customId,
            async deferUpdate() {},
          };
          if (!collectorOptions.filter(buttonInteraction)) {
            throw new Error("Confirmation button was rejected by the collector");
          }
          return buttonInteraction;
        },
      };
    },
    async deleteReply() {
      deletedReplies.push(1);
    },
  } as unknown as ChatInputCommandInteraction;

  return { interaction, replies, deletedReplies };
}

function createGuildFixture(): Guild {
  const roleMembers = new Collection<string, GuildMember>([
    ["222222222222222222", createGuildMember("222222222222222222", "Alice", ["999"])],
    ["333333333333333333", createGuildMember("333333333333333333", "Bob", ["999"])],
  ]);
  const guildMembersById = new Map<string, GuildMember>([
    ["111111111111111111", createGuildMember("111111111111111111", "Invoker")],
    ["222222222222222222", roleMembers.get("222222222222222222")!],
    ["333333333333333333", roleMembers.get("333333333333333333")!],
    ["444444444444444444", createGuildMember("444444444444444444", "Carol")],
  ]);
  const channelsById = new Map<string, GuildBasedChannel>([
    ["333333333333333333", createGuildChannel("333333333333333333", "999999999999999999")],
    [
      "555555555555555555",
      createGuildChannel("555555555555555555", "333333333333333333", ChannelType.PublicThread),
    ],
  ]);

  return {
    id: "123456789012345678",
    name: "Test Guild",
    channels: new FakeChannelsManager(channelsById),
    members: new FakeMembersManager(
      guildMembersById,
      new Collection(Array.from(guildMembersById.entries())),
    ),
  } as unknown as Guild;
}

function createManagedClanData(
  guildId: string,
  categoryId: string,
  userIds: readonly string[],
): ClanData {
  const clanData = new ClanData({
    guildId,
    categoryId,
    bossChannelIds: [
      "101111111111111111",
      "101111111111111112",
      "101111111111111113",
      "101111111111111114",
      "101111111111111115",
    ],
    remainAttackChannelId: "101111111111111116",
    commandChannelId: "101111111111111117",
    summaryChannelId: "101111111111111118",
    date: "2026-03-08",
  });

  for (const userId of userIds) {
    clanData.addPlayerData(new PlayerData({ userId }));
  }

  return clanData;
}

describe("slash basic handlers", () => {
  it("keeps the basic slash command option schema aligned with the command spec", () => {
    const addPayload = SLASH_COMMAND_PAYLOADS.find((payload) => payload.name === "add");
    const removePayload = SLASH_COMMAND_PAYLOADS.find((payload) => payload.name === "remove");
    const setupPayload = SLASH_COMMAND_PAYLOADS.find((payload) => payload.name === "setup");
    const lapPayload = SLASH_COMMAND_PAYLOADS.find((payload) => payload.name === "lap");
    const calcCotPayload = SLASH_COMMAND_PAYLOADS.find((payload) => payload.name === "time");
    const tlPayload = SLASH_COMMAND_PAYLOADS.find((payload) => payload.name === "tl");
    const adjustRemainAttackCountPayload = SLASH_COMMAND_PAYLOADS.find(
      (payload) => payload.name === "adjust_remain_attack_count",
    );

    expect(addPayload?.options).toEqual([
      { type: 8, name: "role", description: "…", required: false },
      { type: 6, name: "member", description: "…", required: false },
    ]);
    expect(removePayload?.options).toEqual([
      { type: 6, name: "member", description: "…", required: false },
      { type: 5, name: "all", description: "…", required: false },
    ]);
    expect(setupPayload?.options).toEqual([
      { type: 3, name: "category_channel_name", description: "…", required: false },
    ]);
    expect(setupPayload?.default_member_permissions).toBe(PermissionFlagsBits.Administrator.toString());
    expect(lapPayload?.options).toEqual([
      { type: 4, name: "lap", description: "…", required: true },
      { type: 4, name: "boss_number", description: "…", required: false },
    ]);
    expect(calcCotPayload?.options).toEqual([
      {
        type: 3,
        name: "values",
        description:
          "先頭にボスHP、その後にダメージを半角スペース区切りで入力 例: 1200000 300000 450000 600000",
        required: true,
      },
    ]);
    expect(tlPayload?.options).toBeUndefined();
    expect(adjustRemainAttackCountPayload?.options).toEqual([
      { type: 6, name: "member", description: "…", required: true },
      {
        type: 3,
        name: "type",
        description: "…",
        required: true,
        choices: [
          { name: "本戦凸", value: "battle" },
          { name: "持越凸", value: "carryover" },
        ],
      },
      {
        type: 4,
        name: "remaining",
        description: "…",
        required: true,
        choices: [
          { name: "0", value: 0 },
          { name: "1", value: 1 },
          { name: "2", value: 2 },
          { name: "3", value: 3 },
        ],
      },
    ]);
  });

  it("maps /繧ｻ繝・ヨ繧｢繝・・ to ClanSetupService and keeps replies public", async () => {
    const guild = createGuildFixture();
    const router = new InteractionRouter({ logger: createMemoryLogger() });
    const capturedRequests: Array<{ guildId: string; categoryChannelName?: string }> = [];

    registerSetupCommandHandlers(router, {
      clanSetupService: {
        async execute(request) {
          capturedRequests.push({
            guildId: request.guild.id,
            categoryChannelName: request.categoryChannelName,
          });
          await request.responseChannel.send({ content: "started" });
          await request.responseChannel.send({ content: "completed" });
          return null;
        },
      },
    });

    const { interaction, replies } = createInteraction({
      commandName: "setup",
      guild,
      optionValues: {
        category_channel_name: "custom-category",
      },
    });

    await router.handle(interaction);

    expect(capturedRequests).toEqual([
      {
        guildId: guild.id,
        categoryChannelName: "custom-category",
      },
    ]);
    expect(replies).toEqual([
      { content: "started", ephemeral: false },
      { content: "completed", ephemeral: false },
    ]);
  });

  it("blocks /繧ｻ繝・ヨ繧｢繝・・ for non-administrators before calling ClanSetupService", async () => {
    const guild = createGuildFixture();
    const router = new InteractionRouter({ logger: createMemoryLogger() });
    let executeCalled = false;

    registerSetupCommandHandlers(router, {
      clanSetupService: {
        async execute() {
          executeCalled = true;
          throw new Error("execute should not be called");
        },
      },
    });

    const { interaction, replies } = createInteraction({
      commandName: "setup",
      guild,
      hasAdministratorPermission: false,
    });

    await router.handle(interaction);

    expect(executeCalled).toBe(false);
    expect(replies).toEqual([
      {
        content:
          "/setup は管理者権限を持つユーザーだけ実行できます。",
        ephemeral: true,
      },
    ]);
  });

  it("maps /繝｡繝ｳ繝舌・霑ｽ蜉 and /繝｡繝ｳ繝舌・蜑企勁 to MemberService with public replies", async () => {
    const guild = createGuildFixture();
    const router = new InteractionRouter({ logger: createMemoryLogger() });
    const addRequests: Array<Record<string, unknown>> = [];
    const removeRequests: Array<Record<string, unknown>> = [];
    const role = {
      id: "999",
      members: new Collection<string, GuildMember>([
        ["222222222222222222", createGuildMember("222222222222222222", "Alice", ["999"])],
        ["333333333333333333", createGuildMember("333333333333333333", "Bob", ["999"])],
      ]),
    } as unknown as Role;
    const memberUser = {
      id: "444444444444444444",
      username: "Carol",
      globalName: "Carol",
      displayName: "Carol",
    } as User;

    registerMemberCommandHandlers(router, {
      memberService: {
        async add(request) {
          addRequests.push({
            categoryId: request.categoryId,
            actorId: request.actor.id,
            memberId: request.member?.id,
            roleMemberIds: request.role?.members.map((member) => member.id),
            displayNameCount: request.displayNamesByUserId?.size,
          });
          await request.responseChannel.send({ content: "add ok" });
          return 3;
        },
        async remove(request) {
          removeRequests.push({
            categoryId: request.categoryId,
            actorId: request.actor.id,
            memberId: request.member?.id,
            all: request.all,
            displayNameCount: request.displayNamesByUserId?.size,
          });
          await request.responseChannel.send({ content: "remove 1" });
          await request.responseChannel.send({ content: "remove 2" });
          return 1;
        },
      },
      runtimeStateService: {
        get() {
          return undefined;
        },
      },
    });

    const addInteraction = createInteraction({
      commandName: "add",
      guild,
      optionValues: {
        member: memberUser,
        role,
      },
    });
    await router.handle(addInteraction.interaction);

    const removeInteraction = createInteraction({
      commandName: "remove",
      guild,
      optionValues: {
        member: memberUser,
        all: true,
      },
    });
    await router.handle(removeInteraction.interaction);

    expect(addRequests).toEqual([
      {
        categoryId: "999999999999999999",
        actorId: "111111111111111111",
        memberId: "444444444444444444",
        roleMemberIds: ["222222222222222222", "333333333333333333"],
        displayNameCount: 4,
      },
    ]);
    expect(removeRequests).toEqual([
      {
        categoryId: "999999999999999999",
        actorId: "111111111111111111",
        memberId: "444444444444444444",
        all: true,
        displayNameCount: 4,
      },
    ]);
    expect((guild.members as unknown as FakeMembersManager).fetchAllCount).toBe(1);
    expect(addInteraction.replies).toEqual([{ content: "add ok", ephemeral: false }]);
    expect(removeInteraction.replies).toEqual([
      { content: "remove 1", ephemeral: false },
      { content: "remove 2", ephemeral: false },
    ]);
  });

  it("fetches uncached guild members before resolving /add role members", async () => {
    const roleId = "999";
    const invoker = createGuildMember("111111111111111111", "Invoker");
    const cachedRoleMember = createGuildMember("222222222222222222", "Alice", [roleId]);
    const uncachedRoleMember = createGuildMember("333333333333333333", "Bob", [roleId]);
    const allMembersById = new Map<string, GuildMember>([
      [invoker.id, invoker],
      [cachedRoleMember.id, cachedRoleMember],
      [uncachedRoleMember.id, uncachedRoleMember],
    ]);
    const membersManager = new FakeMembersManager(
      allMembersById,
      new Collection(Array.from(allMembersById.entries())),
      new Map([
        [invoker.id, invoker],
        [cachedRoleMember.id, cachedRoleMember],
      ]),
    );
    const guild = {
      ...createGuildFixture(),
      members: membersManager,
    } as unknown as Guild;
    const role = {
      id: roleId,
      members: new Collection([[cachedRoleMember.id, cachedRoleMember]]),
    } as unknown as Role;
    const addedRoleMemberIds: string[][] = [];
    const router = new InteractionRouter({ logger: createMemoryLogger() });

    registerMemberCommandHandlers(router, {
      memberService: {
        async add(request) {
          addedRoleMemberIds.push(request.role?.members.map((member) => member.id) ?? []);
          await request.responseChannel.send({ content: "add ok" });
          return request.role?.members.length ?? 0;
        },
      },
      runtimeStateService: {
        get() {
          return undefined;
        },
      },
    });

    const { interaction } = createInteraction({
      commandName: "add",
      guild,
      optionValues: { role },
    });
    await router.handle(interaction);

    expect(membersManager.fetchAllCount).toBe(1);
    expect(addedRoleMemberIds).toEqual([
      ["222222222222222222", "333333333333333333"],
    ]);
  });

  it.each([
    { selection: "increase" as const, expectedIncreaseCount: 1, expectedDecreaseCount: 0 },
    { selection: "decrease" as const, expectedIncreaseCount: 0, expectedDecreaseCount: 1 },
    { selection: "cancel" as const, expectedIncreaseCount: 0, expectedDecreaseCount: 0 },
  ])(
    "shows duplicate /add confirmation only to the invoker and deletes it after $selection",
    async ({ selection, expectedIncreaseCount, expectedDecreaseCount }) => {
      const guild = createGuildFixture();
      const router = new InteractionRouter({ logger: createMemoryLogger() });
      const memberUser = {
        id: "444444444444444444",
        username: "Carol",
        globalName: "Carol",
        displayName: "Carol",
      } as User;
      const clanData = createManagedClanData(guild.id, "999999999999999999", [memberUser.id]);
      clanData.getPlayerData(memberUser.id)!.battleAttackLimit = 6;
      let increaseCount = 0;
      let decreaseCount = 0;

      registerMemberCommandHandlers(router, {
        memberService: {
          async add() {
            throw new Error("add should not be called for an existing explicit member");
          },
          async remove() {
            return 0;
          },
          async increaseBattleAttackLimit() {
            increaseCount += 1;
            return 9;
          },
          async decreaseBattleAttackLimit() {
            decreaseCount += 1;
            return 3;
          },
        },
        runtimeStateService: {
          get() {
            return clanData;
          },
          async ensureDateUpToDate() {
            return {
              changed: false,
              previousDayKey: clanData.date,
              currentDayKey: clanData.date,
              shouldCreateRemainAttackMessage: false,
            };
          },
          getPlayerResourceState() {
            return undefined;
          },
        },
      });

      const addInteraction = createInteraction({
        commandName: "add",
        guild,
        optionValues: { member: memberUser },
        buttonSelection: selection,
      });
      await router.handle(addInteraction.interaction);

      expect(addInteraction.replies).toHaveLength(1);
      expect(addInteraction.replies[0]).toMatchObject({ ephemeral: true });
      expect(addInteraction.replies[0]?.content).toContain(`<@${memberUser.id}>は6凸`);
      expect(increaseCount).toBe(expectedIncreaseCount);
      expect(decreaseCount).toBe(expectedDecreaseCount);
      expect(addInteraction.deletedReplies).toHaveLength(1);
    },
  );

  it("cleans departed managed users during day rollover before member commands", async () => {
    const guild = createGuildFixture();
    const router = new InteractionRouter({ logger: createMemoryLogger() });
    const addRequests: Array<Record<string, unknown>> = [];
    const removeRequests: Array<Record<string, unknown>> = [];
    const clanData = createManagedClanData(guild.id, "999999999999999999", [
      "222222222222222222",
      "555555555555555555",
    ]);

    registerMemberCommandHandlers(router, {
      memberService: {
        async add(request) {
          addRequests.push({
            categoryId: request.categoryId,
            actorId: request.actor.id,
          });
          await request.responseChannel.send({ content: "add ok" });
          return 1;
        },
        async remove(request) {
          removeRequests.push({
            categoryId: request.categoryId,
            actorId: request.actor.id,
            memberId: request.member?.id,
            memberDisplayName: request.member?.displayName,
            displayName: request.displayNamesByUserId?.get("555555555555555555"),
          });
          if (request.member) {
            clanData.playerDataMap.delete(request.member.id);
          }
          return 1;
        },
      },
      runtimeStateService: {
        get() {
          return clanData;
        },
        async ensureDateUpToDate() {
          return {
            changed: true,
            previousDayKey: "2026-03-07",
            currentDayKey: "2026-03-08",
            shouldCreateRemainAttackMessage: true,
          };
        },
      },
    });

    const addInteraction = createInteraction({
      commandName: "add",
      guild,
    });
    await router.handle(addInteraction.interaction);

    expect(removeRequests).toEqual([
      {
        categoryId: "999999999999999999",
        actorId: "555555555555555555",
        memberId: "555555555555555555",
        memberDisplayName: "555555555555555555",
        displayName: "555555555555555555",
      },
    ]);
    expect(addRequests).toEqual([
      {
        categoryId: "999999999999999999",
        actorId: "111111111111111111",
      },
    ]);
    expect(addInteraction.replies).toEqual([{ content: "add ok", ephemeral: false }]);
  });

  it("maps /蜻ｨ蝗樊焚螟画峩, /time and /谿句・菫ｮ豁｣ to ClanQueryService with public replies", async () => {
    const guild = createGuildFixture();
    const router = new InteractionRouter({ logger: createMemoryLogger() });
    const lapRequests: Array<Record<string, unknown>> = [];
    const calcRequests: Array<Record<string, unknown>> = [];
    const adjustRequests: Array<Record<string, unknown>> = [];
    const targetUser = {
      id: "222222222222222222",
      username: "Alice",
      globalName: "Alice",
      displayName: "Alice",
    } as User;

    registerQueryCommandHandlers(router, {
      clanQueryService: {
        async setLap(request) {
          lapRequests.push({
            categoryId: request.categoryId,
            channelId: request.channelId,
            lap: request.lap,
            bossNumber: request.bossNumber,
            displayNameCount: request.displayNamesByUserId?.size,
          });
          await request.responseChannel.send({ content: "lap ok" });
          return true;
        },
        async calcCarryOver(request) {
          calcRequests.push({
            values: request.values,
          });
          await request.responseChannel.send({ content: "calc ok" });
          return "calc ok";
        },
        async adjustRemainAttackCount(request) {
          adjustRequests.push({
            categoryId: request.categoryId,
            channelId: request.channelId,
            actorId: request.actor.id,
            memberId: request.member.id,
            type: request.type,
            remaining: request.remaining,
            displayNameCount: request.displayNamesByUserId?.size,
          });
          await request.responseChannel.send({ content: "adjust ok" });
          return true;
        },
      },
      memberService: {
        async remove() {
          throw new Error("remove should not be called");
        },
      },
      runtimeStateService: {
        get() {
          return undefined;
        },
      },
    });

    const lapInteraction = createInteraction({
      commandName: "lap",
      guild,
      optionValues: {
        lap: 3,
        boss_number: 2,
      },
    });
    await router.handle(lapInteraction.interaction);

    const calcInteraction = createInteraction({
      commandName: "time",
      guild,
      optionValues: {
        values: "1200000 300000 450000",
      },
    });
    await router.handle(calcInteraction.interaction);

    const adjustInteraction = createInteraction({
      commandName: "adjust_remain_attack_count",
      guild,
      optionValues: {
        member: targetUser,
        type: "battle",
        remaining: 2,
      },
    });
    await router.handle(adjustInteraction.interaction);

    expect(lapRequests).toEqual([
      {
        categoryId: "999999999999999999",
        channelId: "333333333333333333",
        lap: 3,
        bossNumber: 2,
        displayNameCount: 4,
      },
    ]);
    expect(calcRequests).toEqual([
      {
        values: "1200000 300000 450000",
      },
    ]);
    expect(adjustRequests).toEqual([
      {
        categoryId: "999999999999999999",
        channelId: "333333333333333333",
        actorId: "111111111111111111",
        memberId: "222222222222222222",
        type: "battle",
        remaining: 2,
        displayNameCount: 4,
      },
    ]);
    expect((guild.members as unknown as FakeMembersManager).fetchAllCount).toBe(0);
    expect(lapInteraction.replies).toEqual([{ content: "lap ok", ephemeral: false }]);
    expect(calcInteraction.replies).toEqual([{ content: "calc ok", ephemeral: false }]);
    expect(adjustInteraction.replies).toEqual([{ content: "adjust ok", ephemeral: false }]);
  });

  it("resolves the managed category when /繝｡繝ｳ繝舌・霑ｽ蜉 and /蜻ｨ蝗樊焚螟画峩 run inside a managed thread", async () => {
    const guild = createGuildFixture();
    const router = new InteractionRouter({ logger: createMemoryLogger() });
    const addRequests: Array<Record<string, unknown>> = [];
    const lapRequests: Array<Record<string, unknown>> = [];
    const memberUser = {
      id: "444444444444444444",
      username: "Carol",
      globalName: "Carol",
      displayName: "Carol",
    } as User;

    registerMemberCommandHandlers(router, {
      memberService: {
        async add(request) {
          addRequests.push({
            categoryId: request.categoryId,
            actorId: request.actor.id,
            memberId: request.member?.id,
            displayNameCount: request.displayNamesByUserId?.size,
          });
          await request.responseChannel.send({ content: "add ok" });
          return 1;
        },
        async remove() {
          throw new Error("remove should not be called");
        },
      },
      runtimeStateService: {
        get() {
          return undefined;
        },
      },
    });
    registerQueryCommandHandlers(router, {
      clanQueryService: {
        async setLap(request) {
          lapRequests.push({
            categoryId: request.categoryId,
            channelId: request.channelId,
            lap: request.lap,
            bossNumber: request.bossNumber,
            displayNameCount: request.displayNamesByUserId?.size,
          });
          await request.responseChannel.send({ content: "lap ok" });
          return true;
        },
        async calcCarryOver() {
          throw new Error("calcCarryOver should not be called");
        },
        async adjustRemainAttackCount() {
          throw new Error("adjustRemainAttackCount should not be called");
        },
      },
      runtimeStateService: {
        get() {
          return undefined;
        },
      },
    });

    const addInteraction = createInteraction({
      commandName: "add",
      guild,
      channelId: "555555555555555555",
      optionValues: {
        member: memberUser,
      },
    });
    await router.handle(addInteraction.interaction);

    const lapInteraction = createInteraction({
      commandName: "lap",
      guild,
      channelId: "555555555555555555",
      optionValues: {
        lap: 3,
        boss_number: 2,
      },
    });
    await router.handle(lapInteraction.interaction);

    expect(addRequests).toEqual([
      {
        categoryId: "999999999999999999",
        actorId: "111111111111111111",
        memberId: "444444444444444444",
        displayNameCount: 4,
      },
    ]);
    expect(lapRequests).toEqual([
      {
        categoryId: "999999999999999999",
        channelId: "555555555555555555",
        lap: 3,
        bossNumber: 2,
        displayNameCount: 4,
      },
    ]);
    expect((guild.members as unknown as FakeMembersManager).fetchAllCount).toBe(0);
    expect(addInteraction.replies).toEqual([{ content: "add ok", ephemeral: false }]);
    expect(lapInteraction.replies).toEqual([{ content: "lap ok", ephemeral: false }]);
  });
});

