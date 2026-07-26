import fs from "node:fs";
import path from "node:path";

import {
  ChannelType,
  GatewayIntentBits,
  IntentsBitField,
  MessageFlags,
  Partials,
  type AnySelectMenuInteraction,
  type BaseInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import { describe, expect, it } from "vitest";

import { createRuntimeConfig } from "../../../../src/config/runtime.js";
import {
  REQUIRED_GATEWAY_INTENTS,
  REQUIRED_PARTIALS,
  createDiscordClient,
  createDiscordOrphanedCategoryScanClassifier,
  createDiscordReadyHook,
} from "../../../../src/discord/client.js";
import { InteractionRouter } from "../../../../src/discord/interaction-router.js";
import {
  SLASH_COMMAND_PAYLOADS,
  registerApplicationCommands,
  type CommandRegistrationApi,
} from "../../../../src/discord/register-commands.js";
import type { Logger, LogContext } from "../../../../src/shared/logger.js";

function createMemoryLogger(): { logger: Logger; records: Array<{ level: string; message: string; context?: LogContext }> } {
  const records: Array<{ level: string; message: string; context?: LogContext }> = [];

  const logger: Logger = {
    debug(message, context) {
      records.push({ level: "debug", message, context });
    },
    info(message, context) {
      records.push({ level: "info", message, context });
    },
    warn(message, context) {
      records.push({ level: "warn", message, context });
    },
    error(message, context) {
      records.push({ level: "error", message, context });
    },
  };

  return { logger, records };
}

function createBaseInteractionStub(): Pick<
  BaseInteraction,
  | "channelId"
  | "guildId"
  | "isAnySelectMenu"
  | "isButton"
  | "isChatInputCommand"
  | "isModalSubmit"
  | "isRepliable"
  | "user"
> {
  return {
    guildId: "123456789012345678",
    channelId: "223456789012345678",
    user: {
      id: "323456789012345678",
    } as BaseInteraction["user"],
    isChatInputCommand: () => false,
    isAnySelectMenu: () => false,
    isButton: () => false,
    isModalSubmit: () => false,
    isRepliable: () => true,
  };
}

function isEphemeralPayload(payload: { ephemeral?: boolean; flags?: MessageFlags }): boolean {
  return payload.ephemeral ?? payload.flags === MessageFlags.Ephemeral;
}

describe("discord bootstrap", () => {
  it("creates a client with the required intents and partials", () => {
    const { logger } = createMemoryLogger();
    const router = new InteractionRouter({ logger });
    const client = createDiscordClient({ logger, router });
    const intents = new IntentsBitField(client.options.intents);

    expect(REQUIRED_GATEWAY_INTENTS).toEqual([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
    ]);
    expect(REQUIRED_PARTIALS).toEqual([Partials.Channel, Partials.Message, Partials.Reaction]);
    expect(intents.has(GatewayIntentBits.Guilds)).toBe(true);
    expect(intents.has(GatewayIntentBits.GuildMembers)).toBe(true);
    expect(intents.has(GatewayIntentBits.GuildMessages)).toBe(true);
    expect(intents.has(GatewayIntentBits.GuildMessageReactions)).toBe(true);
    expect(intents.has(GatewayIntentBits.MessageContent)).toBe(true);
    expect(client.options.partials).toEqual([Partials.Channel, Partials.Message, Partials.Reaction]);

    client.destroy();
  });

  it("builds the slash command inventory from the fixed command spec", () => {
    expect(SLASH_COMMAND_PAYLOADS.map((payload) => [payload.name, payload.description])).toEqual([
      [
        "add",
        "凸管理するメンバーを追加します。オプションがない場合、コマンドを実行した人が追加されます。",
      ],
      [
        "remove",
        "凸管理するメンバーを削除します。オプションがない場合、コマンドを実行した人が削除されます。",
      ],
      ["setup", "凸管理のセットアップを実施します。"],
      ["bossinfo_show", "サーバーごとのボスHP/段階設定を表示します。"],
      ["bossinfo_export_json", "このサーバーのボスHP/段階設定をJSONで出力します。"],
      ["bossinfo_edit", "サーバーごとのボスHP/段階設定をウィザードで編集します。"],
      ["lap", "周回数を変更します"],
      ["agent", "代理操作パネルを表示します。"],
      ["attack_declare", "ボスに凸宣言した時の処理を実施します"],
      ["attack_fin", "ボスに凸した時の処理を実施します。"],
      ["defeat_boss", "ボスを討伐した時の処理を実施します。"],
      ["undo", "元に戻す処理を実施します。"],
      ["resend", "進行用のメッセージを再送します。"],
      ["time", "オーバーキルでの持越し時間を計算します"],
      ["tl", "持越秒数ぶんTLの時刻をずらして表示します。"],
      ["adjust_remain_attack_count", "メンバーの残凸数を直接修正します。"],
      ["correct_attack_kind", "自分の攻撃の本戦・持越区分を入れ替えます。"],
      ["admin_correct_attack_kind", "メンバー指定で攻撃の本戦・持越区分を入れ替えます。"],
    ]);
    expect(SLASH_COMMAND_PAYLOADS).toHaveLength(18);
    expect(SLASH_COMMAND_PAYLOADS.find((payload) => payload.name === "time")?.options).toEqual([
      {
        type: 3,
        name: "values",
        description:
          "先頭にボスHP、その後にダメージを半角スペース区切りで入力 例: 1200000 300000 450000 600000",
        required: true,
      },
    ]);
    expect(SLASH_COMMAND_PAYLOADS.find((payload) => payload.name === "tl")?.options).toBeUndefined();
    expect(SLASH_COMMAND_PAYLOADS.find((payload) => payload.name === "adjust_remain_attack_count")?.options).toEqual([
      {
        type: 6,
        name: "member",
        description: "…",
        required: true,
      },
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

  it("registers guild commands from the ready hook when GUILD_IDS are configured", async () => {
    const { logger, records } = createMemoryLogger();
    const calls: Array<{ kind: "global" | "guild"; guildId?: string; commands: readonly unknown[] }> = [];
    const readyPhaseCalls: string[] = [];
    const api: CommandRegistrationApi = {
      async setGlobalCommands(commands) {
        calls.push({ kind: "global", commands });
      },
      async setGuildCommands(guildId, commands) {
        calls.push({ kind: "guild", guildId, commands });
      },
    };

    const runtimeConfig = createRuntimeConfig({
      DISCORD_TOKEN: "test-token",
      DB_PATH: "clanbattle.sqlite3",
      GUILD_IDS: "111,222",
      LOG_DIR: "logs",
      LOG_LEVEL: "debug",
      DEBUG: "1",
      NODE_ENV: "test",
    });

    await registerApplicationCommands({
      commandRegistration: runtimeConfig.commandRegistration,
      logger,
      api,
    });

    expect(calls).toEqual([
      { kind: "guild", guildId: "111", commands: SLASH_COMMAND_PAYLOADS },
      { kind: "guild", guildId: "222", commands: SLASH_COMMAND_PAYLOADS },
    ]);
    expect(records.filter((record) => record.level === "info")).toHaveLength(2);

    const readyHook = createDiscordReadyHook({
      runtimeConfig,
      logger,
      apiFactory: () => api,
      onReady: async () => {
        readyPhaseCalls.push("post-ready");
      },
    });

    await readyHook({
      user: {
        username: "TestBot",
        id: "999999999999999999",
      },
    } as never);

    expect(records.some((record) => record.message === "Login was successful.")).toBe(true);
    expect(records.some((record) => record.message === "bot name: TestBot")).toBe(true);
    expect(records.some((record) => record.message === "bot id: 999999999999999999")).toBe(true);
    expect(readyPhaseCalls).toEqual(["post-ready"]);
  });

  it("classifies active, orphaned, and scan-deferred categories for startup scan", async () => {
    const activeClassifier = createDiscordOrphanedCategoryScanClassifier({
      guilds: {
        fetch: async () => ({
          channels: {
            fetch: async () => ({
              type: ChannelType.GuildCategory,
            }),
          },
        }),
      },
    } as never);
    const orphanedClassifier = createDiscordOrphanedCategoryScanClassifier({
      guilds: {
        fetch: async () => ({
          channels: {
            fetch: async () => null,
          },
        }),
      },
    } as never);
    const deferredClassifier = createDiscordOrphanedCategoryScanClassifier({
      guilds: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    } as never);

    await expect(
      activeClassifier.classify({
        guildId: "123456789012345678",
        categoryId: "223456789012345678",
      } as never),
    ).resolves.toEqual({
      status: "active",
      reason: "category-resolved",
    });
    await expect(
      orphanedClassifier.classify({
        guildId: "123456789012345678",
        categoryId: "223456789012345678",
      } as never),
    ).resolves.toEqual({
      status: "orphaned",
      reason: "category-not-found",
    });
    await expect(
      deferredClassifier.classify({
        guildId: "123456789012345678",
        categoryId: "223456789012345678",
      } as never),
    ).resolves.toMatchObject({
      status: "scan-deferred",
      reason: "guild-fetch-failed",
    });
  });

  it("replies with the generic tree error message when a slash handler throws", async () => {
    const { logger, records } = createMemoryLogger();
    const router = new InteractionRouter({ logger });
    const replies: Array<{ kind: "reply" | "followUp"; content: string; ephemeral: boolean }> = [];

    router.registerChatInputCommand("setup", async () => {
      throw new Error("boom");
    });

    const interaction = {
      ...createBaseInteractionStub(),
      commandName: "setup",
      replied: false,
      deferred: false,
      isChatInputCommand: () => true,
      reply: async (payload: { content: string; ephemeral?: boolean; flags?: MessageFlags }) => {
        replies.push({ kind: "reply", content: payload.content, ephemeral: isEphemeralPayload(payload) });
      },
      followUp: async (payload: { content: string; ephemeral?: boolean; flags?: MessageFlags }) => {
        replies.push({ kind: "followUp", content: payload.content, ephemeral: isEphemeralPayload(payload) });
      },
    } as unknown as ChatInputCommandInteraction;

    await router.handle(interaction);

    expect(replies).toEqual([
      {
        kind: "reply",
        content: "コマンド実行中にエラーが発生しました。",
        ephemeral: true,
      },
    ]);
    expect(records.some((record) => record.level === "error")).toBe(true);
  });

  it("routes button, select menu, and modal handlers by custom id matcher", async () => {
    const { logger } = createMemoryLogger();
    const router = new InteractionRouter({ logger });
    const calls: string[] = [];

    router.registerButtonHandler(/^bossinfo:/u, async () => {
      calls.push("button");
    });
    router.registerSelectMenuHandler(/^agent:/u, async () => {
      calls.push("select");
    });
    router.registerModalHandler("bossinfo:phase-count", async () => {
      calls.push("modal");
    });

    const buttonInteraction = {
      ...createBaseInteractionStub(),
      customId: "bossinfo:start",
      isButton: () => true,
    } as unknown as ButtonInteraction;
    const selectMenuInteraction = {
      ...createBaseInteractionStub(),
      customId: "agent:member:123456789012345678",
      isAnySelectMenu: () => true,
    } as unknown as AnySelectMenuInteraction;
    const modalInteraction = {
      ...createBaseInteractionStub(),
      customId: "bossinfo:phase-count",
      isModalSubmit: () => true,
    } as unknown as ModalSubmitInteraction;

    await router.handle(buttonInteraction);
    await router.handle(selectMenuInteraction);
    await router.handle(modalInteraction);

    expect(calls).toEqual(["button", "select", "modal"]);
  });

  it("documents privileged intents in the operations doc", () => {
    const operationsPath = path.resolve(process.cwd(), "docs/operations.md");
    const operations = fs.readFileSync(operationsPath, "utf8");

    expect(operations).toContain("GuildMembers");
    expect(operations).toContain("MessageContent");
  });
});
