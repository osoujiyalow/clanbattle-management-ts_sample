import {
  type ButtonInteraction,
  ChannelType,
  Collection,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Message,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type User,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { ClanData } from "../../../../src/domain/clan-data.js";
import { ATTACK_TYPE_INPUTS, AttackType } from "../../../../src/domain/attack-type.js";
import { OperationType } from "../../../../src/domain/operation-type.js";
import { CarryOver, PlayerData } from "../../../../src/domain/player-data.js";
import {
  handleProgressActionButtonInteraction,
  createSlashCarryOverSelector,
  createSlashAttackEntrySelector,
  registerAttackCommandHandlers,
} from "../../../../src/discord/command-handlers/attack.js";
import {
  ProgressAction,
  createProgressActionButtonCustomId,
} from "../../../../src/discord/progress-action-buttons.js";
import {
  AttackEntry,
  AttackEntryKind,
  AttackEntryStatus,
} from "../../../../src/domain/attack-entry.js";
import { OperationLog, OperationLogType } from "../../../../src/domain/operation-log.js";
import {
  createBossInfoButtonCustomId,
  registerBossInfoCommandHandlers,
} from "../../../../src/discord/command-handlers/bossinfo.js";
import { InteractionRouter } from "../../../../src/discord/interaction-router.js";
import { SLASH_COMMAND_PAYLOADS } from "../../../../src/discord/register-commands.js";
import {
  ATTACK_NOT_DECLARED_MESSAGE,
  MESSAGE_DAMAGE_ALL_ATTACKS_CONSUMED_MESSAGE,
} from "../../../../src/services/attack-service-support.js";
import type { BossInfoViewSpec } from "../../../../src/services/bossinfo-service.js";
import type { Logger } from "../../../../src/shared/logger.js";

type RecordedReply = {
  content: string;
  ephemeral: boolean;
  components?: unknown[];
  files?: unknown[];
};

function normalizeRecordedReply(payload: {
  content?: string;
  ephemeral?: boolean;
  flags?: MessageFlags;
  components?: unknown[];
  files?: unknown[];
}): RecordedReply {
  return {
    content: payload.content ?? "",
    ephemeral: payload.ephemeral ?? payload.flags === MessageFlags.Ephemeral,
    ...(payload.components ? { components: payload.components } : {}),
    ...(payload.files ? { files: payload.files } : {}),
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
  readonly fetchCalls: Array<string | { user?: string | readonly string[] } | undefined> = [];

  constructor(
    private readonly membersById: Map<string, GuildMember>,
    private readonly allMembers: Collection<string, GuildMember>,
  ) {
    this.cache = new Collection(Array.from(this.membersById.entries()));
  }

  async fetch(
    input?: string | { user?: string | readonly string[] },
  ): Promise<GuildMember | Collection<string, GuildMember>> {
    this.fetchCalls.push(input);

    if (!input) {
      return this.allMembers;
    }

    if (typeof input === "string") {
      const member = this.membersById.get(input);
      if (!member) {
        throw new Error(`Unknown member: ${input}`);
      }

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

function createGuildMember(id: string, displayName: string, roleIds: string[] = []): GuildMember {
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
      throw new Error("send should not be called in slash-battle handler tests");
    },
    messages: {
      fetch: async () => {
        throw new Error("fetch should not be called in slash-battle handler tests");
      },
    },
  } as unknown as GuildBasedChannel;
}

function createSelectorMessage(options: {
  customId: string;
  userId: string;
}): Pick<Message, "awaitMessageComponent" | "delete"> & { deleted: boolean } {
  let deleted = false;

  return {
    get deleted() {
      return deleted;
    },
    async awaitMessageComponent() {
      return {
        customId: options.customId,
        user: {
          id: options.userId,
        },
        async deferUpdate() {},
      };
    },
    async delete() {
      deleted = true;
    },
  };
}

function createButtonInteraction(options: {
  customId: string;
  guild: Guild;
  channelId: string;
  parentId: string;
  messageId: string;
  user?: User;
}): ButtonInteraction & { replies: RecordedReply[] } {
  let deferred = false;
  let replied = false;
  const replies: RecordedReply[] = [];

  return {
    customId: options.customId,
    guild: options.guild,
    guildId: options.guild.id,
    channelId: options.channelId,
    channel: {
      id: options.channelId,
      parentId: options.parentId,
      async send() {
        throw new Error("send should not be called in button handler tests");
      },
    },
    message: {
      id: options.messageId,
    },
    user:
      options.user ??
      ({
        id: "222222222222222222",
        username: "Alice",
        globalName: "Alice",
        displayName: "Alice",
      } as User),
    memberPermissions: {
      has() {
        return true;
      },
    },
    get deferred() {
      return deferred;
    },
    get replied() {
      return replied;
    },
    isChatInputCommand: () => false,
    isButton: () => true,
    isModalSubmit: () => false,
    isRepliable: () => true,
    async deferUpdate() {
      deferred = true;
    },
    async reply(payload: {
      content?: string;
      ephemeral?: boolean;
      flags?: MessageFlags;
      components?: unknown[];
      files?: unknown[];
    }) {
      replied = true;
      replies.push(normalizeRecordedReply(payload));
      return {
        async delete() {},
      };
    },
    async followUp(payload: {
      content?: string;
      ephemeral?: boolean;
      flags?: MessageFlags;
      components?: unknown[];
      files?: unknown[];
    }) {
      replies.push(normalizeRecordedReply(payload));
      return {
        async delete() {},
      };
    },
    replies,
  } as unknown as ButtonInteraction & { replies: RecordedReply[] };
}

function createInteraction(options: {
  commandName: string;
  optionValues?: Record<string, unknown>;
  guild?: Guild;
  user?: User;
  member?: GuildMember;
  channelId?: string;
  hasManageGuildPermission?: boolean;
  channelSend?: (payload: { content?: string; components?: unknown[] }) => Promise<unknown>;
  interactionId?: string;
}): {
  interaction: ChatInputCommandInteraction;
  replies: RecordedReply[];
} {
  const replies: RecordedReply[] = [];
  const optionValues = options.optionValues ?? {};
  let replied = false;
  let deferred = false;
  let deferredEphemeral = false;

  const interaction = {
    id: options.interactionId ?? `${options.commandName}-interaction`,
    commandName: options.commandName,
    guild: options.guild ?? null,
    guildId: options.guild?.id ?? null,
    channelId: options.channelId ?? "333333333333333333",
    channel: {
      id: options.channelId ?? "333333333333333333",
      name: "invoke-channel",
      isTextBased: () => true,
      send:
        options.channelSend ??
        (async () => {
          throw new Error("send should not be called in slash-battle handler tests");
        }),
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
      has() {
        return options.hasManageGuildPermission === true;
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
      getString(name: string, required?: boolean) {
        const value = optionValues[name];
        if (typeof value === "string") {
          return value;
        }
        if (required) {
          throw new Error(`Missing string option: ${name}`);
        }
        return null;
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
      getUser(name: string, required?: boolean) {
        const value = optionValues[name];
        if (value && typeof value === "object") {
          return value as User;
        }
        if (required) {
          throw new Error(`Missing user option: ${name}`);
        }
        return null;
      },
      getBoolean(name: string) {
        const value = optionValues[name];
        return typeof value === "boolean" ? value : null;
      },
      getRole() {
        return null;
      },
    },
    async deferReply(payload?: { flags?: MessageFlags }) {
      deferred = true;
      deferredEphemeral = payload?.flags === MessageFlags.Ephemeral;
    },
    async reply(payload: {
      content?: string;
      ephemeral?: boolean;
      flags?: MessageFlags;
      components?: unknown[];
      files?: unknown[];
    }) {
      replied = true;
      replies.push(normalizeRecordedReply(payload));
    },
    async editReply(payload: {
      content?: string;
      components?: unknown[];
      files?: unknown[];
    }) {
      replied = true;
      replies.push(
        normalizeRecordedReply({
          content: payload.content,
          components: payload.components,
          files: payload.files,
          ...(deferredEphemeral ? { flags: MessageFlags.Ephemeral } : {}),
        }),
      );
    },
    async followUp(payload: {
      content?: string;
      ephemeral?: boolean;
      flags?: MessageFlags;
      components?: unknown[];
      files?: unknown[];
    }) {
      replies.push(normalizeRecordedReply(payload));
    },
  } as unknown as ChatInputCommandInteraction;

  return { interaction, replies };
}

function createGuildFixture(): Guild {
  const guildMembersById = new Map<string, GuildMember>([
    ["111111111111111111", createGuildMember("111111111111111111", "Invoker")],
    ["222222222222222222", createGuildMember("222222222222222222", "Alice")],
    ["333333333333333333", createGuildMember("333333333333333333", "Bob")],
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

function createBossInfoView(kind: BossInfoViewSpec["kind"]): BossInfoViewSpec {
  return {
    kind,
    timeoutSeconds: 600,
    buttons: [
      { label: "開始", style: "primary", action: "start" },
      { label: "キャンセル", style: "secondary", action: "cancel" },
    ],
  };
}

describe("slash battle handlers", () => {
  it("keeps attack and bossinfo slash command schema aligned with the command spec", () => {
    const attackDeclarePayload = SLASH_COMMAND_PAYLOADS.find((payload) => payload.name === "attack_declare");
    const attackFinPayload = SLASH_COMMAND_PAYLOADS.find((payload) => payload.name === "attack_fin");
    const defeatBossPayload = SLASH_COMMAND_PAYLOADS.find((payload) => payload.name === "defeat_boss");
    const undoPayload = SLASH_COMMAND_PAYLOADS.find((payload) => payload.name === "undo");
    const correctAttackKindPayload = SLASH_COMMAND_PAYLOADS.find(
      (payload) => payload.name === "correct_attack_kind",
    );
    const adminCorrectAttackKindPayload = SLASH_COMMAND_PAYLOADS.find(
      (payload) => payload.name === "admin_correct_attack_kind",
    );
    const resendPayload = SLASH_COMMAND_PAYLOADS.find(
      (payload) => payload.name === "resend",
    );
    const bossinfoShowPayload = SLASH_COMMAND_PAYLOADS.find(
      (payload) => payload.name === "bossinfo_show",
    );
    const bossinfoExportPayload = SLASH_COMMAND_PAYLOADS.find(
      (payload) => payload.name === "bossinfo_export_json",
    );
    const bossinfoEditPayload = SLASH_COMMAND_PAYLOADS.find(
      (payload) => payload.name === "bossinfo_edit",
    );

    expect(attackDeclarePayload?.options).toEqual([
      { type: 6, name: "member", description: "…", required: true },
      {
        type: 3,
        name: "attack_type",
        description: "…",
        required: true,
        choices: [
          { name: "本戦凸", value: ATTACK_TYPE_INPUTS.BATTLE },
          { name: "持越凸", value: ATTACK_TYPE_INPUTS.CARRYOVER },
        ],
      },
      { type: 4, name: "lap", description: "…", required: false },
      { type: 4, name: "boss_number", description: "…", required: false },
    ]);
    expect(attackFinPayload?.options).toEqual([
      { type: 6, name: "member", description: "…", required: true },
      { type: 4, name: "lap", description: "…", required: false },
      { type: 4, name: "boss_number", description: "…", required: false },
      { type: 4, name: "damage", description: "…", required: false },
    ]);
    expect(defeatBossPayload?.options).toEqual([
      { type: 6, name: "member", description: "…", required: true },
      { type: 4, name: "lap", description: "…", required: false },
      { type: 4, name: "boss_number", description: "…", required: false },
    ]);
    expect(undoPayload?.options).toEqual([
      { type: 6, name: "member", description: "…", required: true },
      { type: 4, name: "boss_number", description: "…", required: false },
    ]);
    expect(resendPayload?.options).toEqual([
      { type: 4, name: "lap", description: "…", required: false },
      { type: 4, name: "boss_number", description: "…", required: false },
    ]);
    expect(correctAttackKindPayload?.options).toMatchObject([
      { type: 4, name: "lap", required: true },
      { type: 4, name: "boss_number", required: true },
    ]);
    expect(adminCorrectAttackKindPayload?.default_member_permissions).toBe("32");
    expect(adminCorrectAttackKindPayload?.options).toMatchObject([
      { type: 6, name: "member", required: true },
      { type: 4, name: "lap", required: true },
      { type: 4, name: "boss_number", required: true },
    ]);
    expect(bossinfoShowPayload?.options).toBeUndefined();
    expect(bossinfoExportPayload?.options).toBeUndefined();
    expect(bossinfoEditPayload?.options).toBeUndefined();
  });

  it("maps attack slash commands to services with public replies", async () => {
    const guild = createGuildFixture();
    const router = new InteractionRouter({ logger: createMemoryLogger() });
    const declaredRequests: Array<Record<string, unknown>> = [];
    const finishedRequests: Array<Record<string, unknown>> = [];
    const defeatedRequests: Array<Record<string, unknown>> = [];
    const undoRequests: Array<Record<string, unknown>> = [];
    const correctedRequests: Array<Record<string, unknown>> = [];
    const resendRequests: Array<Record<string, unknown>> = [];
    const memberUser = {
      id: "222222222222222222",
      username: "Alice",
      globalName: "Alice",
      displayName: "Alice",
    } as User;

    registerAttackCommandHandlers(router, {
      attackService: {
        async declare(request) {
          declaredRequests.push({
            categoryId: request.categoryId,
            channelId: request.channelId,
            memberId: request.member.id,
            memberDisplayName: request.member.displayName,
            attackType: request.attackType,
            lap: request.lap,
            bossNumber: request.bossNumber,
            displayNameCount: request.displayNamesByUserId?.size,
          });
          await request.responseChannel.send({ content: "declare ok" });
          return null;
        },
        async finish(request) {
          finishedRequests.push({
            categoryId: request.categoryId,
            channelId: request.channelId,
            memberId: request.member.id,
            lap: request.lap,
            bossNumber: request.bossNumber,
            damage: request.damage,
            displayNameCount: request.displayNamesByUserId?.size,
            hasSelectCarryOver: typeof request.selectCarryOver === "function",
          });
          await request.responseChannel.send({ content: "finish ok" });
          return null;
        },
        async defeatBoss(request) {
          defeatedRequests.push({
            categoryId: request.categoryId,
            channelId: request.channelId,
            memberId: request.member.id,
            lap: request.lap,
            bossNumber: request.bossNumber,
            displayNameCount: request.displayNamesByUserId?.size,
            hasSelectCarryOver: typeof request.selectCarryOver === "function",
          });
          await request.responseChannel.send({ content: "defeat ok" });
          return null;
        },
        async undo(request) {
          undoRequests.push({
            categoryId: request.categoryId,
            channelId: request.channelId,
            memberId: request.member.id,
            memberDisplayName: request.member.displayName,
            bossNumber: request.bossNumber,
            displayNameCount: request.displayNamesByUserId?.size,
          });
          await request.responseChannel.send({ content: "undo ok" });
          return true;
        },
        async correctAttackKind(request) {
          correctedRequests.push({
            categoryId: request.categoryId,
            channelId: request.channelId,
            memberId: request.member.id,
            memberDisplayName: request.member.displayName,
            lap: request.lap,
            bossNumber: request.bossNumber,
            displayNameCount: request.displayNamesByUserId?.size,
            hasSelectAttackEntry: typeof request.selectAttackEntry === "function",
          });
          await request.responseChannel.send({ content: "correct ok" });
          return true;
        },
      },
      progressMessageService: {
        async resend(request) {
          resendRequests.push({
            categoryId: request.categoryId,
            channelId: request.channelId,
            lap: request.lap,
            bossNumber: request.bossNumber,
            displayNameCount: request.displayNamesByUserId?.size,
          });
          await request.responseChannel.send({ content: "resend ok" });
          return "700000000000000001";
        },
      },
      runtimeStateService: {
        get() {
          return undefined;
        },
        async ensureDateUpToDate() {
          return {
            changed: false,
            shouldCreateRemainAttackMessage: false,
          };
        },
      },
      memberService: {
        async ensureCurrentRemainAttackMessage() {
          return null;
        },
      },
    });

    const attackDeclareInteraction = createInteraction({
      commandName: "attack_declare",
      guild,
      optionValues: {
        member: memberUser,
        attack_type: ATTACK_TYPE_INPUTS.BATTLE,
        lap: 3,
        boss_number: 2,
      },
    });
    await router.handle(attackDeclareInteraction.interaction);

    const attackFinInteraction = createInteraction({
      commandName: "attack_fin",
      guild,
      optionValues: {
        member: memberUser,
        lap: 4,
        boss_number: 1,
        damage: 123456,
      },
    });
    await router.handle(attackFinInteraction.interaction);

    const defeatBossInteraction = createInteraction({
      commandName: "defeat_boss",
      guild,
      optionValues: {
        member: memberUser,
        lap: 5,
        boss_number: 3,
      },
    });
    await router.handle(defeatBossInteraction.interaction);

    const undoInteraction = createInteraction({
      commandName: "undo",
      guild,
      optionValues: {
        member: memberUser,
        boss_number: 2,
      },
    });
    await router.handle(undoInteraction.interaction);

    const resendInteraction = createInteraction({
      commandName: "resend",
      guild,
      optionValues: {
        lap: 6,
        boss_number: 4,
      },
    });
    await router.handle(resendInteraction.interaction);

    const correctAttackKindInteraction = createInteraction({
      commandName: "correct_attack_kind",
      guild,
      optionValues: {
        lap: 7,
        boss_number: 5,
      },
    });
    await router.handle(correctAttackKindInteraction.interaction);

    const adminCorrectAttackKindInteraction = createInteraction({
      commandName: "admin_correct_attack_kind",
      guild,
      hasManageGuildPermission: true,
      optionValues: {
        member: memberUser,
        lap: 8,
        boss_number: 2,
      },
    });
    await router.handle(adminCorrectAttackKindInteraction.interaction);

    expect(declaredRequests).toEqual([
      {
        categoryId: "999999999999999999",
        channelId: "333333333333333333",
        memberId: "222222222222222222",
        memberDisplayName: "Alice",
        attackType: ATTACK_TYPE_INPUTS.BATTLE,
        lap: 3,
        bossNumber: 2,
        displayNameCount: 3,
      },
    ]);
    expect(finishedRequests).toEqual([
      {
        categoryId: "999999999999999999",
        channelId: "333333333333333333",
        memberId: "222222222222222222",
        lap: 4,
        bossNumber: 1,
        damage: 123456,
        displayNameCount: 3,
        hasSelectCarryOver: false,
      },
    ]);
    expect(defeatedRequests).toEqual([
      {
        categoryId: "999999999999999999",
        channelId: "333333333333333333",
        memberId: "222222222222222222",
        lap: 5,
        bossNumber: 3,
        displayNameCount: 3,
        hasSelectCarryOver: false,
      },
    ]);
    expect(undoRequests).toEqual([
      {
        categoryId: "999999999999999999",
        channelId: "333333333333333333",
        memberId: "222222222222222222",
        memberDisplayName: "Alice",
        bossNumber: 2,
        displayNameCount: 3,
      },
    ]);
    expect(resendRequests).toEqual([
      {
        categoryId: "999999999999999999",
        channelId: "333333333333333333",
        lap: 6,
        bossNumber: 4,
        displayNameCount: 3,
      },
    ]);
    expect(correctedRequests).toEqual([
      {
        categoryId: "999999999999999999",
        channelId: "333333333333333333",
        memberId: "111111111111111111",
        memberDisplayName: "Invoker",
        lap: 7,
        bossNumber: 5,
        displayNameCount: 3,
        hasSelectAttackEntry: true,
      },
      {
        categoryId: "999999999999999999",
        channelId: "333333333333333333",
        memberId: "222222222222222222",
        memberDisplayName: "Alice",
        lap: 8,
        bossNumber: 2,
        displayNameCount: 3,
        hasSelectAttackEntry: true,
      },
    ]);
    expect(attackDeclareInteraction.replies).toEqual([{ content: "declare ok", ephemeral: false }]);
    expect(attackFinInteraction.replies).toEqual([{ content: "finish ok", ephemeral: false }]);
    expect(defeatBossInteraction.replies).toEqual([{ content: "defeat ok", ephemeral: false }]);
    expect(undoInteraction.replies).toEqual([{ content: "undo ok", ephemeral: false }]);
    expect(resendInteraction.replies).toEqual([{ content: "resend ok", ephemeral: false }]);
    expect(correctAttackKindInteraction.replies).toEqual([{ content: "correct ok", ephemeral: false }]);
    expect(adminCorrectAttackKindInteraction.replies).toEqual([{ content: "correct ok", ephemeral: false }]);
  });

  it("resolves managed thread context to the parent boss channel for battle commands", async () => {
    const guild = createGuildFixture();
    const router = new InteractionRouter({ logger: createMemoryLogger() });
    const declaredRequests: Array<Record<string, unknown>> = [];
    const resendRequests: Array<Record<string, unknown>> = [];
    const memberUser = {
      id: "222222222222222222",
      username: "Alice",
      globalName: "Alice",
      displayName: "Alice",
    } as User;

    registerAttackCommandHandlers(router, {
      attackService: {
        async declare(request) {
          declaredRequests.push({
            categoryId: request.categoryId,
            channelId: request.channelId,
            memberId: request.member.id,
            attackType: request.attackType,
            bossNumber: request.bossNumber,
          });
          await request.responseChannel.send({ content: "declare ok" });
          return null;
        },
        async finish() {
          throw new Error("finish should not be called");
        },
        async defeatBoss() {
          throw new Error("defeatBoss should not be called");
        },
        async undo() {
          throw new Error("undo should not be called");
        },
        async correctAttackKind() {
          throw new Error("correctAttackKind should not be called");
        },
      },
      progressMessageService: {
        async resend(request) {
          resendRequests.push({
            categoryId: request.categoryId,
            channelId: request.channelId,
            bossNumber: request.bossNumber,
          });
          await request.responseChannel.send({ content: "resend ok" });
          return "700000000000000001";
        },
      },
      runtimeStateService: {
        get() {
          return undefined;
        },
        async ensureDateUpToDate() {
          return {
            changed: false,
            shouldCreateRemainAttackMessage: false,
          };
        },
      },
      memberService: {
        async ensureCurrentRemainAttackMessage() {
          return null;
        },
      },
    });

    const attackDeclareInteraction = createInteraction({
      commandName: "attack_declare",
      guild,
      channelId: "555555555555555555",
      optionValues: {
        member: memberUser,
        attack_type: ATTACK_TYPE_INPUTS.BATTLE,
      },
    });
    await router.handle(attackDeclareInteraction.interaction);

    const resendInteraction = createInteraction({
      commandName: "resend",
      guild,
      channelId: "555555555555555555",
    });
    await router.handle(resendInteraction.interaction);

    expect(declaredRequests).toEqual([
      {
        categoryId: "999999999999999999",
        channelId: "333333333333333333",
        memberId: "222222222222222222",
        attackType: ATTACK_TYPE_INPUTS.BATTLE,
        bossNumber: undefined,
      },
    ]);
    expect(resendRequests).toEqual([
      {
        categoryId: "999999999999999999",
        channelId: "333333333333333333",
        bossNumber: undefined,
      },
    ]);
    expect(attackDeclareInteraction.replies).toEqual([{ content: "declare ok", ephemeral: false }]);
    expect(resendInteraction.replies).toEqual([{ content: "resend ok", ephemeral: false }]);
  });

  it("selects a carryover index from a slash follow-up prompt", async () => {
    const sentPayloads: Array<{ content?: string; components?: unknown[] }> = [];
    const selectorMessage = createSelectorMessage({
      customId: "carryover-select:interaction-1:123:1",
      userId: "111111111111111111",
    });
    const interaction = {
      id: "interaction-1",
      user: {
        id: "111111111111111111",
      },
      channel: {
        isTextBased: () => true,
        async send(payload: { content?: string; components?: unknown[] }) {
          sentPayloads.push(payload);
          return selectorMessage;
        },
      },
    } as unknown as ChatInputCommandInteraction;

    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(123);
    try {
      const selector = createSlashCarryOverSelector(interaction);
      const selectedIndex = await selector({
        member: {
          id: "111111111111111111",
          displayName: "Invoker",
        },
        carryOverList: [
          new CarryOver({
            attackType: AttackType.BATTLE,
            bossIndex: 0,
          }),
          new CarryOver({
            attackType: AttackType.BATTLE,
            bossIndex: 1,
          }),
        ],
        responseChannel: {
          async send() {},
        },
      });

      expect(selectedIndex).toBe(1);
      expect(sentPayloads).toHaveLength(1);
      expect(sentPayloads[0]?.content).toContain("1:");
      expect(sentPayloads[0]?.content).toContain("2:");
      expect(sentPayloads[0]?.content).not.toContain("秒");
      expect(sentPayloads[0]?.components).toHaveLength(1);
      expect(selectorMessage.deleted).toBe(true);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("selects an attack entry id from a slash follow-up prompt", async () => {
    const sentPayloads: Array<{ content?: string; components?: unknown[] }> = [];
    const selectorMessage = createSelectorMessage({
      customId: "attack-entry-select:interaction-2:123:1",
      userId: "111111111111111111",
    });
    const { interaction } = createInteraction({
      commandName: "correct_attack_kind",
      interactionId: "interaction-2",
      channelSend: async (payload) => {
        sentPayloads.push(payload);
        return selectorMessage;
      },
    });

    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(123);
    try {
      const selector = createSlashAttackEntrySelector(interaction);
      const selectedAttackEntryId = await selector({
        member: {
          id: "111111111111111111",
          displayName: "Invoker",
        },
        attackEntries: [
          new AttackEntry({
            attackEntryId: "attack-1",
            categoryId: "999999999999999999",
            userId: "111111111111111111",
            dayKey: "2026-03-28",
            lap: 1,
            bossIndex: 0,
            kind: AttackEntryKind.BATTLE,
            status: AttackEntryStatus.DECLARED,
            declaredAt: new Date("2026-03-28T06:00:00+09:00"),
          }),
          new AttackEntry({
            attackEntryId: "attack-2",
            categoryId: "999999999999999999",
            userId: "111111111111111111",
            dayKey: "2026-03-28",
            lap: 1,
            bossIndex: 0,
            kind: AttackEntryKind.CARRYOVER,
            status: AttackEntryStatus.FINISHED,
            declaredAt: new Date("2026-03-28T06:01:00+09:00"),
            damage: 123_456,
          }),
        ],
        responseChannel: {
          async send() {},
        },
      });

      expect(selectedAttackEntryId).toBe("attack-2");
      expect(sentPayloads).toHaveLength(1);
      expect(sentPayloads[0]?.content).toContain("1:");
      expect(sentPayloads[0]?.content).toContain("2:");
      expect(sentPayloads[0]?.content).toContain("123,456");
      expect(sentPayloads[0]?.components).toHaveLength(2);
      expect(selectorMessage.deleted).toBe(true);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("rejects the admin correction command without manage guild permission", async () => {
    const guild = createGuildFixture();
    const router = new InteractionRouter({ logger: createMemoryLogger() });
    const memberUser = {
      id: "222222222222222222",
      username: "Alice",
      globalName: "Alice",
      displayName: "Alice",
    } as User;
    let correctionCalls = 0;

    registerAttackCommandHandlers(router, {
      attackService: {
        async declare() {
          throw new Error("declare should not be called");
        },
        async finish() {
          throw new Error("finish should not be called");
        },
        async defeatBoss() {
          throw new Error("defeatBoss should not be called");
        },
        async undo() {
          throw new Error("undo should not be called");
        },
        async correctAttackKind() {
          correctionCalls += 1;
          return true;
        },
      },
      progressMessageService: {
        async resend() {
          throw new Error("resend should not be called");
        },
      },
      runtimeStateService: {
        get() {
          return undefined;
        },
        async ensureDateUpToDate() {
          return {
            changed: false,
            shouldCreateRemainAttackMessage: false,
          };
        },
      },
      memberService: {
        async ensureCurrentRemainAttackMessage() {
          return null;
        },
      },
    });

    const adminCorrectAttackKindInteraction = createInteraction({
      commandName: "admin_correct_attack_kind",
      guild,
      hasManageGuildPermission: false,
      optionValues: {
        member: memberUser,
        lap: 2,
        boss_number: 4,
      },
    });

    await router.handle(adminCorrectAttackKindInteraction.interaction);

    expect(correctionCalls).toBe(0);
    expect(adminCorrectAttackKindInteraction.replies).toEqual([
      {
        content: "このコマンドはサーバー管理権限があるメンバーのみ使えます",
        ephemeral: true,
      },
    ]);
  });

  it("maps slash transient responses to ephemeral follow-ups", async () => {
    const guild = createGuildFixture();
    const router = new InteractionRouter({ logger: createMemoryLogger() });
    const memberUser = {
      id: "222222222222222222",
      username: "Alice",
      globalName: "Alice",
      displayName: "Alice",
    } as User;

    registerAttackCommandHandlers(router, {
      attackService: {
        async declare(request) {
          await request.responseChannel.sendTransient?.({ content: "declare blocked" }, 15000);
          return null;
        },
        async finish() {
          throw new Error("finish should not be called");
        },
        async defeatBoss() {
          throw new Error("defeatBoss should not be called");
        },
        async undo() {
          throw new Error("undo should not be called");
        },
        async correctAttackKind() {
          throw new Error("correctAttackKind should not be called");
        },
      },
      progressMessageService: {
        async resend() {
          throw new Error("resend should not be called");
        },
      },
      runtimeStateService: {
        get() {
          return undefined;
        },
        async ensureDateUpToDate() {
          return {
            changed: false,
            shouldCreateRemainAttackMessage: false,
          };
        },
      },
      memberService: {
        async ensureCurrentRemainAttackMessage() {
          return null;
        },
      },
    });

    const attackDeclareInteraction = createInteraction({
      commandName: "attack_declare",
      guild,
      optionValues: {
        member: memberUser,
        attack_type: ATTACK_TYPE_INPUTS.BATTLE,
      },
    });

    await router.handle(attackDeclareInteraction.interaction);

    expect(attackDeclareInteraction.replies).toEqual([
      {
        content: "declare blocked",
        ephemeral: true,
      },
    ]);
  });

  it("maps button transient responses to ephemeral follow-ups", async () => {
    const guild = createGuildFixture();
    const categoryId = "999999999999999999";
    const bossChannelId = "333333333333333333";
    const progressMessageId = "progress-111";
    const clanData = new ClanData({
      guildId: guild.id,
      categoryId,
      bossChannelIds: [bossChannelId, "423", "523", "623", "723"],
      remainAttackChannelId: "823",
      commandChannelId: "923",
      summaryChannelId: "10323",
      remainAttackMessageId: "remain-1",
      progressMessageIdsByLap: new Map([[1, [progressMessageId, null, null, null, null]]]),
      summaryMessageIdsByLap: new Map([[1, ["summary-1", null, null, null, null]]]),
      date: "2026-03-08",
    });
    clanData.initializeBossStatusData(1);
    clanData.addPlayerData(new PlayerData({ userId: "222222222222222222" }));

    const buttonInteraction = createButtonInteraction({
      customId: createProgressActionButtonCustomId(ProgressAction.BATTLE),
      guild,
      channelId: bossChannelId,
      parentId: categoryId,
      messageId: progressMessageId,
    });

    await handleProgressActionButtonInteraction(buttonInteraction, {
      attackService: {
        async declare(request) {
          await request.responseChannel.sendTransient?.({ content: "declare blocked" }, 15000);
          return null;
        },
        async finish() {
          throw new Error("finish should not be called");
        },
        async defeatBoss() {
          throw new Error("defeatBoss should not be called");
        },
        async undo() {
          throw new Error("undo should not be called");
        },
        async correctAttackKind() {
          throw new Error("correctAttackKind should not be called");
        },
      },
      progressMessageService: {
        async resend() {
          throw new Error("resend should not be called");
        },
      },
      runtimeStateService: {
        get(requestCategoryId) {
          return requestCategoryId === categoryId ? clanData : undefined;
        },
        async ensureDateUpToDate() {
          return {
            changed: false,
            shouldCreateRemainAttackMessage: false,
          };
        },
      },
      memberService: {
        async ensureCurrentRemainAttackMessage() {
          return null;
        },
      },
    });

    expect(buttonInteraction.replies).toEqual([
      {
        content: "declare blocked",
        ephemeral: true,
      },
    ]);
  });

  it("warns managed members privately when finish or defeat buttons are pressed without a declaration", async () => {
    const guild = createGuildFixture();
    const categoryId = "999999999999999999";
    const bossChannelId = "333333333333333333";
    const progressMessageId = "progress-111";
    const clanData = new ClanData({
      guildId: guild.id,
      categoryId,
      bossChannelIds: [bossChannelId, "423", "523", "623", "723"],
      remainAttackChannelId: "823",
      commandChannelId: "923",
      summaryChannelId: "10323",
      remainAttackMessageId: "remain-1",
      progressMessageIdsByLap: new Map([[1, [progressMessageId, null, null, null, null]]]),
      summaryMessageIdsByLap: new Map([[1, ["summary-1", null, null, null, null]]]),
      date: "2026-03-08",
    });
    clanData.initializeBossStatusData(1);
    clanData.addPlayerData(new PlayerData({ userId: "222222222222222222" }));

    const interactions = [ProgressAction.FINISH, ProgressAction.DEFEAT].map((action) =>
      createButtonInteraction({
        customId: createProgressActionButtonCustomId(action),
        guild,
        channelId: bossChannelId,
        parentId: categoryId,
        messageId: progressMessageId,
      }),
    );

    for (const interaction of interactions) {
      await handleProgressActionButtonInteraction(interaction, {
        attackService: {
          async declare() {
            throw new Error("declare should not be called");
          },
          async finish() {
            throw new Error("finish should not be called");
          },
          async defeatBoss() {
            throw new Error("defeatBoss should not be called");
          },
          async undo() {
            throw new Error("undo should not be called");
          },
          async correctAttackKind() {
            throw new Error("correctAttackKind should not be called");
          },
        },
        progressMessageService: {
          async resend() {
            throw new Error("resend should not be called");
          },
        },
        runtimeStateService: {
          get(requestCategoryId) {
            return requestCategoryId === categoryId ? clanData : undefined;
          },
          async ensureDateUpToDate() {
            return {
              changed: false,
              shouldCreateRemainAttackMessage: false,
            };
          },
        },
        memberService: {
          async ensureCurrentRemainAttackMessage() {
            return null;
          },
        },
      });
    }

    expect(interactions.map((interaction) => interaction.replies)).toEqual([
      [
        {
          content: ATTACK_NOT_DECLARED_MESSAGE,
          ephemeral: true,
        },
      ],
      [
        {
          content: ATTACK_NOT_DECLARED_MESSAGE,
          ephemeral: true,
        },
      ],
    ]);
  });

  it("warns managed members privately when finish or defeat buttons are pressed after all attacks are consumed", async () => {
    const guild = createGuildFixture();
    const categoryId = "999999999999999999";
    const bossChannelId = "333333333333333333";
    const progressMessageId = "progress-111";
    const clanData = new ClanData({
      guildId: guild.id,
      categoryId,
      bossChannelIds: [bossChannelId, "423", "523", "623", "723"],
      remainAttackChannelId: "823",
      commandChannelId: "923",
      summaryChannelId: "10323",
      remainAttackMessageId: "remain-1",
      progressMessageIdsByLap: new Map([[1, [progressMessageId, null, null, null, null]]]),
      summaryMessageIdsByLap: new Map([[1, ["summary-1", null, null, null, null]]]),
      date: "2026-03-08",
    });
    clanData.initializeBossStatusData(1);
    clanData.addPlayerData(new PlayerData({ userId: "222222222222222222", battleAttackCount: 3 }));

    const interactions = [ProgressAction.FINISH, ProgressAction.DEFEAT].map((action) =>
      createButtonInteraction({
        customId: createProgressActionButtonCustomId(action),
        guild,
        channelId: bossChannelId,
        parentId: categoryId,
        messageId: progressMessageId,
      }),
    );

    for (const interaction of interactions) {
      await handleProgressActionButtonInteraction(interaction, {
        attackService: {
          async declare() {
            throw new Error("declare should not be called");
          },
          async finish() {
            throw new Error("finish should not be called");
          },
          async defeatBoss() {
            throw new Error("defeatBoss should not be called");
          },
          async undo() {
            throw new Error("undo should not be called");
          },
          async correctAttackKind() {
            throw new Error("correctAttackKind should not be called");
          },
        },
        progressMessageService: {
          async resend() {
            throw new Error("resend should not be called");
          },
        },
        runtimeStateService: {
          get(requestCategoryId) {
            return requestCategoryId === categoryId ? clanData : undefined;
          },
          async ensureDateUpToDate() {
            return {
              changed: false,
              shouldCreateRemainAttackMessage: false,
            };
          },
        },
        memberService: {
          async ensureCurrentRemainAttackMessage() {
            return null;
          },
        },
      });
    }

    expect(interactions.map((interaction) => interaction.replies)).toEqual([
      [
        {
          content: MESSAGE_DAMAGE_ALL_ATTACKS_CONSUMED_MESSAGE,
          ephemeral: true,
        },
      ],
      [
        {
          content: MESSAGE_DAMAGE_ALL_ATTACKS_CONSUMED_MESSAGE,
          ephemeral: true,
        },
      ],
    ]);
  });

  it("maps progress action buttons to battle services", async () => {
    const guild = createGuildFixture();
    const membersManager = guild.members as unknown as FakeMembersManager;
    const categoryId = "999999999999999999";
    const bossChannelId = "333333333333333333";
    const progressMessageId = "progress-111";
    const clanData = new ClanData({
      guildId: guild.id,
      categoryId,
      bossChannelIds: [bossChannelId, "423", "523", "623", "723"],
      remainAttackChannelId: "823",
      commandChannelId: "923",
      summaryChannelId: "10323",
      remainAttackMessageId: "remain-1",
      progressMessageIdsByLap: new Map([[1, [progressMessageId, null, null, null, null]]]),
      summaryMessageIdsByLap: new Map([[1, ["summary-1", null, null, null, null]]]),
      date: "2026-03-08",
    });
    clanData.initializeBossStatusData(1);
    clanData.addPlayerData(new PlayerData({ userId: "222222222222222222" }));
    clanData.addPlayerData(new PlayerData({ userId: "333333333333333333" }));
    membersManager.cache.delete("333333333333333333");

    const declaredRequests: Array<Record<string, unknown>> = [];
    let ensuredRemainAttackMessage = 0;

    await handleProgressActionButtonInteraction(
      createButtonInteraction({
        customId: createProgressActionButtonCustomId(ProgressAction.BATTLE),
        guild,
        channelId: bossChannelId,
        parentId: categoryId,
        messageId: progressMessageId,
      }),
      {
        attackService: {
          async declare(request) {
            declaredRequests.push({
              categoryId: request.categoryId,
              channelId: request.channelId,
              lap: request.lap,
              bossNumber: request.bossNumber,
              attackType: request.attackType,
              memberId: request.member.id,
              displayNameCount: request.displayNamesByUserId?.size,
            });
            return null;
          },
          async finish() {
            throw new Error("finish should not be called");
          },
          async defeatBoss() {
            throw new Error("defeatBoss should not be called");
          },
          async undo() {
            throw new Error("undo should not be called");
          },
          async correctAttackKind() {
            throw new Error("correctAttackKind should not be called");
          },
        },
        progressMessageService: {
          async resend() {
            throw new Error("resend should not be called");
          },
        },
        runtimeStateService: {
          get(requestCategoryId) {
            return requestCategoryId === categoryId ? clanData : undefined;
          },
          async ensureDateUpToDate() {
            return {
              changed: false,
              shouldCreateRemainAttackMessage: false,
            };
          },
        },
        memberService: {
          async ensureCurrentRemainAttackMessage() {
            ensuredRemainAttackMessage += 1;
            return clanData.remainAttackMessageId;
          },
        },
      },
    );

    expect(ensuredRemainAttackMessage).toBe(0);
    expect(declaredRequests).toEqual([
      {
        categoryId,
        channelId: bossChannelId,
        lap: 1,
        bossNumber: 1,
        attackType: ATTACK_TYPE_INPUTS.BATTLE,
        memberId: "222222222222222222",
        displayNameCount: 1,
      },
    ]);
    expect(membersManager.fetchCalls).toEqual([]);
  });

  it("allows undo from the next-lap progress button for the same boss after a defeat", async () => {
    const guild = createGuildFixture();
    const categoryId = "999999999999999999";
    const bossChannelId = "333333333333333333";
    const currentLapMessageId = "progress-111";
    const nextLapMessageId = "progress-211";
    const clanData = new ClanData({
      guildId: guild.id,
      categoryId,
      bossChannelIds: [bossChannelId, "423", "523", "623", "723"],
      remainAttackChannelId: "823",
      commandChannelId: "923",
      summaryChannelId: "10323",
      remainAttackMessageId: "remain-1",
      progressMessageIdsByLap: new Map([
        [1, [currentLapMessageId, null, null, null, null]],
        [2, [nextLapMessageId, null, null, null, null]],
      ]),
      summaryMessageIdsByLap: new Map([
        [1, ["summary-1", null, null, null, null]],
        [2, ["summary-2", null, null, null, null]],
      ]),
      date: "2026-03-08",
    });
    clanData.initializeBossStatusData(1);
    clanData.initializeBossStatusData(2);

    const playerData = new PlayerData({ userId: "222222222222222222", battleAttackCount: 3 });
    playerData.log.push({
      operationType: OperationType.LAST_ATTACK,
      lap: 1,
      bossIndex: 0,
      playerData: {
        battleAttackCount: 2,
        carryOverList: [],
      },
      beated: false,
    });
    clanData.addPlayerData(playerData);

    const undoRequests: Array<Record<string, unknown>> = [];
    let ensuredRemainAttackMessage = 0;

    await handleProgressActionButtonInteraction(
      createButtonInteraction({
        customId: createProgressActionButtonCustomId(ProgressAction.UNDO),
        guild,
        channelId: bossChannelId,
        parentId: categoryId,
        messageId: nextLapMessageId,
      }),
      {
        attackService: {
          async declare() {
            throw new Error("declare should not be called");
          },
          async finish() {
            throw new Error("finish should not be called");
          },
          async defeatBoss() {
            throw new Error("defeatBoss should not be called");
          },
          async undo(request) {
            undoRequests.push({
              categoryId: request.categoryId,
              channelId: request.channelId,
              lap: request.lap,
              bossNumber: request.bossNumber,
              suppressSuccessResponse: request.suppressSuccessResponse,
              memberId: request.member.id,
              memberDisplayName: request.member.displayName,
              displayNameCount: request.displayNamesByUserId?.size,
            });
            return true;
          },
          async correctAttackKind() {
            throw new Error("correctAttackKind should not be called");
          },
        },
        progressMessageService: {
          async resend() {
            throw new Error("resend should not be called");
          },
        },
        runtimeStateService: {
          get(requestCategoryId) {
            return requestCategoryId === categoryId ? clanData : undefined;
          },
          async ensureDateUpToDate() {
            return {
              changed: false,
              shouldCreateRemainAttackMessage: false,
            };
          },
        },
        memberService: {
          async ensureCurrentRemainAttackMessage() {
            ensuredRemainAttackMessage += 1;
            return clanData.remainAttackMessageId;
          },
        },
      },
    );

    expect(ensuredRemainAttackMessage).toBe(0);
    expect(undoRequests).toEqual([
      {
        categoryId,
        channelId: bossChannelId,
        lap: 2,
        bossNumber: 1,
        suppressSuccessResponse: true,
        memberId: "222222222222222222",
        memberDisplayName: "Alice",
        displayNameCount: 1,
      },
    ]);
  });

  it("uses the latest undoable log for the current boss instead of the member's global latest log", async () => {
    const guild = createGuildFixture();
    const categoryId = "999999999999999999";
    const bossOneChannelId = "333333333333333333";
    const bossTwoChannelId = "423";
    const bossOneMessageId = "progress-111";
    const bossTwoMessageId = "progress-112";
    const clanData = new ClanData({
      guildId: guild.id,
      categoryId,
      bossChannelIds: [bossOneChannelId, bossTwoChannelId, "523", "623", "723"],
      remainAttackChannelId: "823",
      commandChannelId: "923",
      summaryChannelId: "10323",
      remainAttackMessageId: "remain-1",
      progressMessageIdsByLap: new Map([[1, [bossOneMessageId, bossTwoMessageId, null, null, null]]]),
      summaryMessageIdsByLap: new Map([[1, ["summary-1", "summary-2", null, null, null]]]),
      date: "2026-03-08",
    });
    clanData.initializeBossStatusData(1);

    const playerData = new PlayerData({ userId: "222222222222222222" });
    playerData.log.push({
      operationType: OperationType.ATTACK_DECLAR,
      lap: 1,
      bossIndex: 0,
    });
    playerData.log.push({
      operationType: OperationType.ATTACK_DECLAR,
      lap: 1,
      bossIndex: 1,
    });
    clanData.addPlayerData(playerData);

    const undoRequests: Array<Record<string, unknown>> = [];

    await handleProgressActionButtonInteraction(
      createButtonInteraction({
        customId: createProgressActionButtonCustomId(ProgressAction.UNDO),
        guild,
        channelId: bossOneChannelId,
        parentId: categoryId,
        messageId: bossOneMessageId,
      }),
      {
        attackService: {
          async declare() {
            throw new Error("declare should not be called");
          },
          async finish() {
            throw new Error("finish should not be called");
          },
          async defeatBoss() {
            throw new Error("defeatBoss should not be called");
          },
          async undo(request) {
            undoRequests.push({
              categoryId: request.categoryId,
              channelId: request.channelId,
              lap: request.lap,
              bossNumber: request.bossNumber,
              memberId: request.member.id,
            });
            return true;
          },
          async correctAttackKind() {
            throw new Error("correctAttackKind should not be called");
          },
        },
        progressMessageService: {
          async resend() {
            throw new Error("resend should not be called");
          },
        },
        runtimeStateService: {
          get(requestCategoryId) {
            return requestCategoryId === categoryId ? clanData : undefined;
          },
          async ensureDateUpToDate() {
            return {
              changed: false,
              shouldCreateRemainAttackMessage: false,
            };
          },
        },
        memberService: {
          async ensureCurrentRemainAttackMessage() {
            return clanData.remainAttackMessageId;
          },
        },
      },
    );

    expect(undoRequests).toEqual([
      {
        categoryId,
        channelId: bossOneChannelId,
        lap: 1,
        bossNumber: 1,
        memberId: "222222222222222222",
      },
    ]);
  });

  it("uses projected operation logs for the undo button when available", async () => {
    const guild = createGuildFixture();
    const categoryId = "999999999999999999";
    const bossChannelId = "333333333333333333";
    const progressMessageId = "progress-111";
    const clanData = new ClanData({
      guildId: guild.id,
      categoryId,
      bossChannelIds: [bossChannelId, "423", "523", "623", "723"],
      remainAttackChannelId: "823",
      commandChannelId: "923",
      summaryChannelId: "10323",
      remainAttackMessageId: "remain-1",
      progressMessageIdsByLap: new Map([[1, [progressMessageId, null, null, null, null]]]),
      summaryMessageIdsByLap: new Map([[1, ["summary-1", null, null, null, null]]]),
      date: "2026-03-08",
    });
    clanData.initializeBossStatusData(1);
    clanData.addPlayerData(new PlayerData({ userId: "222222222222222222" }));

    const undoRequests: Array<Record<string, unknown>> = [];

    await handleProgressActionButtonInteraction(
      createButtonInteraction({
        customId: createProgressActionButtonCustomId(ProgressAction.UNDO),
        guild,
        channelId: bossChannelId,
        parentId: categoryId,
        messageId: progressMessageId,
      }),
      {
        attackService: {
          async declare() {
            throw new Error("declare should not be called");
          },
          async finish() {
            throw new Error("finish should not be called");
          },
          async defeatBoss() {
            throw new Error("defeatBoss should not be called");
          },
          async undo(request) {
            undoRequests.push({
              categoryId: request.categoryId,
              channelId: request.channelId,
              lap: request.lap,
              bossNumber: request.bossNumber,
              memberId: request.member.id,
            });
            return true;
          },
          async correctAttackKind() {
            throw new Error("correctAttackKind should not be called");
          },
        },
        progressMessageService: {
          async resend() {
            throw new Error("resend should not be called");
          },
        },
        runtimeStateService: {
          get(requestCategoryId) {
            return requestCategoryId === categoryId ? clanData : undefined;
          },
          getOperationLogs(requestCategoryId) {
            if (requestCategoryId !== categoryId) {
              return [];
            }

            return [
              new OperationLog({
                operationId: "operation-1",
                categoryId,
                userId: "222222222222222222",
                dayKey: "2026-03-08",
                lap: 1,
                bossIndex: 0,
                targetAttackEntryId: "attack-entry-1",
                operationType: OperationLogType.FINISH,
                beforeKind: AttackEntryKind.BATTLE,
                afterKind: AttackEntryKind.BATTLE,
                beforeStatus: AttackEntryStatus.DECLARED,
                afterStatus: AttackEntryStatus.FINISHED,
                occurredAt: new Date("2026-03-08T00:05:00+09:00"),
              }),
            ];
          },
          async ensureDateUpToDate() {
            return {
              changed: false,
              shouldCreateRemainAttackMessage: false,
            };
          },
        },
        memberService: {
          async ensureCurrentRemainAttackMessage() {
            return clanData.remainAttackMessageId;
          },
        },
      },
    );

    expect(undoRequests).toEqual([
      {
        categoryId,
        channelId: bossChannelId,
        lap: 1,
        bossNumber: 1,
        memberId: "222222222222222222",
      },
    ]);
  });

  it("does not fall back to legacy player logs when projected operation logs exist but the current boss has no projected undo target", async () => {
    const guild = createGuildFixture();
    const categoryId = "999999999999999999";
    const bossOneChannelId = "333333333333333333";
    const bossTwoChannelId = "423";
    const bossOneMessageId = "progress-111";
    const clanData = new ClanData({
      guildId: guild.id,
      categoryId,
      bossChannelIds: [bossOneChannelId, bossTwoChannelId, "523", "623", "723"],
      remainAttackChannelId: "823",
      commandChannelId: "923",
      summaryChannelId: "10323",
      remainAttackMessageId: "remain-1",
      progressMessageIdsByLap: new Map([[1, [bossOneMessageId, "progress-112", null, null, null]]]),
      summaryMessageIdsByLap: new Map([[1, ["summary-1", "summary-2", null, null, null]]]),
      date: "2026-03-08",
    });
    clanData.initializeBossStatusData(1);

    const playerData = new PlayerData({ userId: "222222222222222222" });
    playerData.log.push({
      operationType: OperationType.ATTACK_DECLAR,
      lap: 1,
      bossIndex: 0,
    });
    clanData.addPlayerData(playerData);

    const undoRequests: Array<Record<string, unknown>> = [];

    await handleProgressActionButtonInteraction(
      createButtonInteraction({
        customId: createProgressActionButtonCustomId(ProgressAction.UNDO),
        guild,
        channelId: bossOneChannelId,
        parentId: categoryId,
        messageId: bossOneMessageId,
      }),
      {
        attackService: {
          async declare() {
            throw new Error("declare should not be called");
          },
          async finish() {
            throw new Error("finish should not be called");
          },
          async defeatBoss() {
            throw new Error("defeatBoss should not be called");
          },
          async undo(request) {
            undoRequests.push({
              categoryId: request.categoryId,
              channelId: request.channelId,
              lap: request.lap,
              bossNumber: request.bossNumber,
              memberId: request.member.id,
            });
            return true;
          },
          async correctAttackKind() {
            throw new Error("correctAttackKind should not be called");
          },
        },
        progressMessageService: {
          async resend() {
            throw new Error("resend should not be called");
          },
        },
        runtimeStateService: {
          get(requestCategoryId) {
            return requestCategoryId === categoryId ? clanData : undefined;
          },
          getOperationLogs(requestCategoryId) {
            if (requestCategoryId !== categoryId) {
              return [];
            }

            return [
              new OperationLog({
                operationId: "operation-2",
                categoryId,
                userId: "222222222222222222",
                dayKey: "2026-03-08",
                lap: 1,
                bossIndex: 1,
                targetAttackEntryId: "attack-entry-2",
                operationType: OperationLogType.FINISH,
                beforeKind: AttackEntryKind.BATTLE,
                afterKind: AttackEntryKind.BATTLE,
                beforeStatus: AttackEntryStatus.DECLARED,
                afterStatus: AttackEntryStatus.FINISHED,
                occurredAt: new Date("2026-03-08T00:05:00+09:00"),
              }),
            ];
          },
          async ensureDateUpToDate() {
            return {
              changed: false,
              shouldCreateRemainAttackMessage: false,
            };
          },
        },
        memberService: {
          async ensureCurrentRemainAttackMessage() {
            return clanData.remainAttackMessageId;
          },
        },
      },
    );

    expect(undoRequests).toEqual([]);
  });

  it("maps bossinfo slash commands to ephemeral replies, files, and buttons", async () => {
    const guild = createGuildFixture();
    const router = new InteractionRouter({ logger: createMemoryLogger() });
    const showRequests: Array<Record<string, unknown>> = [];
    const exportRequests: Array<Record<string, unknown>> = [];
    const editRequests: Array<Record<string, unknown>> = [];

    registerBossInfoCommandHandlers(router, {
      bossInfoService: {
        show(request) {
          showRequests.push({
            guildId: request.guildId,
            hasManageGuildPermission: request.hasManageGuildPermission,
          });
          return {
            kind: "message",
            visibility: "ephemeral",
            content: "bossinfo show",
          };
        },
        exportJson(request) {
          exportRequests.push({
            guildId: request.guildId,
            hasManageGuildPermission: request.hasManageGuildPermission,
          });
          return {
            kind: "message",
            visibility: "ephemeral",
            content: "bossinfo export",
            attachment: {
              filename: "bossinfo-123456789012345678.json",
              content: "{\"phase\":1}",
            },
          };
        },
        startEdit(request) {
          editRequests.push({
            guildId: request.guildId,
            userId: request.userId,
            hasManageGuildPermission: request.hasManageGuildPermission,
          });
          return {
            kind: "message",
            visibility: "ephemeral",
            content: "bossinfo edit",
            view: createBossInfoView("start"),
          };
        },
      },
    });

    const showInteraction = createInteraction({
      commandName: "bossinfo_show",
      guild,
      hasManageGuildPermission: true,
    });
    await router.handle(showInteraction.interaction);

    const exportInteraction = createInteraction({
      commandName: "bossinfo_export_json",
      guild,
      hasManageGuildPermission: true,
    });
    await router.handle(exportInteraction.interaction);

    const editInteraction = createInteraction({
      commandName: "bossinfo_edit",
      guild,
      hasManageGuildPermission: true,
    });
    await router.handle(editInteraction.interaction);

    expect(showRequests).toEqual([
      {
        guildId: guild.id,
        hasManageGuildPermission: true,
      },
    ]);
    expect(exportRequests).toEqual([
      {
        guildId: guild.id,
        hasManageGuildPermission: true,
      },
    ]);
    expect(editRequests).toEqual([
      {
        guildId: guild.id,
        userId: "111111111111111111",
        hasManageGuildPermission: true,
      },
    ]);
    expect(showInteraction.replies).toEqual([{ content: "bossinfo show", ephemeral: true }]);
    expect(exportInteraction.replies[0]).toMatchObject({
      content: "bossinfo export",
      ephemeral: true,
    });
    expect(exportInteraction.replies[0]?.files).toHaveLength(1);
    expect(editInteraction.replies[0]).toMatchObject({
      content: "bossinfo edit",
      ephemeral: true,
    });
    const editComponents = editInteraction.replies[0]?.components as
      | Array<{ toJSON(): { components: Array<{ custom_id: string; label: string }> } }>
      | undefined;
    expect(editComponents).toHaveLength(1);
    expect(editComponents?.[0]?.toJSON()).toMatchObject({
      components: [
        {
          custom_id: createBossInfoButtonCustomId({
            guildId: guild.id,
            userId: "111111111111111111",
            action: "start",
          }),
          label: "開始",
        },
        {
          custom_id: createBossInfoButtonCustomId({
            guildId: guild.id,
            userId: "111111111111111111",
            action: "cancel",
          }),
          label: "キャンセル",
        },
      ],
    });
  });
});
