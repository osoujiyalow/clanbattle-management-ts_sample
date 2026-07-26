import {
  Collection,
  type ButtonInteraction,
  type Guild,
  type GuildMember,
  type ModalBuilder,
  type ModalSubmitInteraction,
} from "discord.js";
import { describe, expect, it } from "vitest";

import { AttackEntryKind, AttackEntryStatus } from "../../../src/domain/attack-entry.js";
import { AttackStatus } from "../../../src/domain/attack-status.js";
import { AttackType } from "../../../src/domain/attack-type.js";
import { ClanData } from "../../../src/domain/clan-data.js";
import { OperationLog, OperationLogType } from "../../../src/domain/operation-log.js";
import { PlayerData } from "../../../src/domain/player-data.js";
import { PlayerResourceState } from "../../../src/domain/player-resource-state.js";
import {
  createAgentActionButtonCustomId,
  handleAgentButtonInteraction,
  handleAgentDamageModalSubmit,
  parseAgentActionButtonCustomId,
  renderAgentPanel,
} from "../../../src/discord/command-handlers/agent.js";

function createGuildMember(id: string, displayName: string): GuildMember {
  return {
    id,
    displayName,
    user: {
      id,
      globalName: displayName,
    },
  } as unknown as GuildMember;
}

function createGuildFixture(members: readonly GuildMember[]): Guild {
  const memberMap = new Map(members.map((member) => [member.id, member]));
  return {
    id: "100",
    members: {
      cache: new Collection(memberMap),
      async fetch(userId: string) {
        const member = memberMap.get(userId);
        if (!member) {
          throw new Error(`Unknown member: ${userId}`);
        }
        return member;
      },
    },
  } as unknown as Guild;
}

function createAgentButtonInteraction(options: {
  customId: string;
  guild: Guild;
}): ButtonInteraction & {
  deferredUpdates: number;
  deletedReplies: number;
  editReplies: unknown[];
  followUps: unknown[];
  shownModals: ModalBuilder[];
} {
  let deferred = false;
  let deletedReplies = 0;
  const editReplies: unknown[] = [];
  const followUps: unknown[] = [];
  const shownModals: ModalBuilder[] = [];

  return {
    customId: options.customId,
    guild: options.guild,
    guildId: options.guild.id,
    channelId: "18",
    user: {
      id: "999",
      globalName: "Operator",
    },
    get deferred() {
      return deferred;
    },
    replied: false,
    get deferredUpdates() {
      return deferred ? 1 : 0;
    },
    get deletedReplies() {
      return deletedReplies;
    },
    get editReplies() {
      return editReplies;
    },
    get followUps() {
      return followUps;
    },
    get shownModals() {
      return shownModals;
    },
    isButton: () => true,
    isChatInputCommand: () => false,
    isModalSubmit: () => false,
    isAnySelectMenu: () => false,
    isRepliable: () => true,
    async deferUpdate() {
      deferred = true;
    },
    async editReply(payload: unknown) {
      editReplies.push(payload);
    },
    async followUp(payload: unknown) {
      followUps.push(payload);
    },
    async reply(payload: unknown) {
      followUps.push(payload);
    },
    async deleteReply() {
      deletedReplies += 1;
    },
    async showModal(modal: ModalBuilder) {
      shownModals.push(modal);
    },
  } as unknown as ButtonInteraction & {
    deferredUpdates: number;
    deletedReplies: number;
    editReplies: unknown[];
    followUps: unknown[];
    shownModals: ModalBuilder[];
  };
}

function createAgentDamageModalInteraction(options: {
  customId: string;
  guild: Guild;
  damage: string;
}): ModalSubmitInteraction & {
  deferredUpdates: number;
  editReplies: unknown[];
  followUps: unknown[];
} {
  let deferred = false;
  const editReplies: unknown[] = [];
  const followUps: unknown[] = [];

  return {
    customId: options.customId,
    guild: options.guild,
    guildId: options.guild.id,
    channelId: "18",
    user: {
      id: "999",
      globalName: "Operator",
    },
    fields: {
      getTextInputValue(customId: string) {
        if (customId !== "damage") {
          throw new Error(`Unknown field: ${customId}`);
        }
        return options.damage;
      },
    },
    get deferred() {
      return deferred;
    },
    replied: false,
    get deferredUpdates() {
      return deferred ? 1 : 0;
    },
    get editReplies() {
      return editReplies;
    },
    get followUps() {
      return followUps;
    },
    isButton: () => false,
    isChatInputCommand: () => false,
    isModalSubmit: () => true,
    isAnySelectMenu: () => false,
    isRepliable: () => true,
    async deferUpdate() {
      deferred = true;
    },
    async editReply(payload: unknown) {
      editReplies.push(payload);
    },
    async followUp(payload: unknown) {
      followUps.push(payload);
    },
    async reply(payload: unknown) {
      followUps.push(payload);
    },
  } as unknown as ModalSubmitInteraction & {
    deferredUpdates: number;
    editReplies: unknown[];
    followUps: unknown[];
  };
}

describe("agent panel", () => {
  it("renders progress and selected member state with operation controls", () => {
    const alice = new PlayerData({ userId: "300", battleAttackCount: 1 });
    const bob = new PlayerData({ userId: "301" });
    const clanData = new ClanData({
      guildId: "100",
      categoryId: "200",
      bossChannelIds: ["11", "12", "13", "14", "15"],
      remainAttackChannelId: "16",
      commandChannelId: "18",
      summaryChannelId: "19",
      playerDataMap: new Map([
        [alice.userId, alice],
        [bob.userId, bob],
      ]),
      progressMessageIdsByLap: new Map([[2, ["p21", "p22", "p23", "p24", "p25"]]]),
      date: "2026-03-08",
    });
    clanData.initializeBossStatusData(2);
    clanData.bossStatusByLap.get(2)?.[0]?.attackPlayers.push(
      new AttackStatus({
        playerData: alice,
        attackType: AttackType.BATTLE,
        carryOver: false,
      }),
    );

    const payload = renderAgentPanel({
      clanData,
      displayNamesByUserId: new Map([
        ["300", "Alice"],
        ["301", "Bob"],
      ]),
      operationLogs: [
        new OperationLog({
          operationId: "op-1",
          categoryId: "200",
          userId: "300",
          dayKey: "2026-03-08",
          lap: 1,
          bossIndex: 4,
          targetAttackEntryId: "entry-1",
          operationType: OperationLogType.DEFEAT,
          beforeKind: AttackEntryKind.BATTLE,
          afterKind: AttackEntryKind.BATTLE,
          beforeStatus: AttackEntryStatus.DECLARED,
          afterStatus: AttackEntryStatus.DEFEATED,
          occurredAt: new Date("2026-03-08T12:00:00+09:00"),
        }),
      ],
      playerResourceState: new PlayerResourceState({
        categoryId: "200",
        userId: "300",
        dayKey: "2026-03-08",
        battleConsumedCount: 1,
        battleReservedCount: 1,
        carryAvailableCount: 1,
      }),
      selection: {
        memberId: "300",
        bossIndex: 0,
        lap: 99,
      },
    });

    const embedJson = payload.embeds?.[0]?.toJSON();
    expect(embedJson?.title).toBe("代理操作パネル");
    expect(embedJson?.description).toContain("1ボス（2周） 次段階まで5周\nHP");
    expect(embedJson?.description).toContain("宣言: Alice");
    expect(embedJson?.description).toContain("対象メンバー: Alice");
    expect(embedJson?.description).toContain("本戦: 使用可 1 / 宣言中 1 / 済み 1");
    expect(embedJson?.description).toContain("持越: 使用可 1 / 宣言中 0");
    expect(embedJson?.description).toContain("未消化宣言: 2周 1ボス");
    expect(embedJson?.description).toContain("今日の操作: 1周 5ボス 討伐");
    expect(embedJson?.description).toContain("操作対象: 2周 1ボス");
    expect(payload.components).toHaveLength(5);

    const componentJson = payload.components?.map((component) => component.toJSON()) as Array<{
      components: Array<{
        label?: string;
        options?: Array<{ default?: boolean; label: string; value: string }>;
      }>;
    }>;
    expect(componentJson[1]?.components[0]?.options?.map((option) => option.value)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
    ]);
    expect(componentJson[2]?.components[0]?.options?.map((option) => option.value)).toEqual([
      "1",
      "2",
    ]);
    expect(componentJson[2]?.components[0]?.options).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "3" })]),
    );
    expect(componentJson[2]?.components[0]?.options).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "2", default: true })]),
    );
    expect(componentJson[3]?.components).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "ダメ入力" })]),
    );
    expect(componentJson[4]?.components).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "削除" })]),
    );
  });

  it("round-trips agent action button custom ids", () => {
    const customId = createAgentActionButtonCustomId({
      categoryId: "200",
      memberId: "300",
      bossIndex: 2,
      lap: 7,
      operation: "battle",
    });

    expect(parseAgentActionButtonCustomId(customId)).toEqual({
      categoryId: "200",
      memberId: "300",
      bossIndex: 2,
      lap: 7,
      operation: "battle",
    });
  });

  it("maps an agent action button to the attack service and refreshes the panel", async () => {
    const alice = new PlayerData({ userId: "300" });
    const clanData = new ClanData({
      guildId: "100",
      categoryId: "200",
      bossChannelIds: ["11", "12", "13", "14", "15"],
      remainAttackChannelId: "16",
      commandChannelId: "18",
      summaryChannelId: "19",
      playerDataMap: new Map([[alice.userId, alice]]),
      progressMessageIdsByLap: new Map([[2, ["p21", "p22", "p23", "p24", "p25"]]]),
      date: "2026-03-08",
    });
    clanData.initializeBossStatusData(2);
    const guild = createGuildFixture([createGuildMember("300", "Alice")]);
    const declareRequests: Array<{
      categoryId: string;
      channelId: string;
      lap: number | undefined;
      bossNumber: number | undefined;
      memberId: string;
      attackType: string;
    }> = [];
    const interaction = createAgentButtonInteraction({
      guild,
      customId: createAgentActionButtonCustomId({
        categoryId: "200",
        memberId: "300",
        bossIndex: 0,
        lap: 2,
        operation: "battle",
      }),
    });

    await handleAgentButtonInteraction(interaction, {
      attackService: {
        async declare(request) {
          declareRequests.push({
            categoryId: request.categoryId,
            channelId: request.channelId,
            lap: request.lap,
            bossNumber: request.bossNumber,
            memberId: request.member.id,
            attackType: request.attackType,
          });
          return null;
        },
        async finish() {
          throw new Error("finish should not be called");
        },
        async defeatBoss() {
          throw new Error("defeatBoss should not be called");
        },
        async setPendingDamage() {
          throw new Error("setPendingDamage should not be called");
        },
        async undo() {
          throw new Error("undo should not be called");
        },
      },
      runtimeStateService: {
        get(categoryId) {
          return categoryId === "200" ? clanData : undefined;
        },
        getOperationLogs() {
          return [];
        },
        getPlayerResourceState() {
          return undefined;
        },
      },
    });

    expect(interaction.deferredUpdates).toBe(1);
    expect(declareRequests).toEqual([
      {
        categoryId: "200",
        channelId: "18",
        lap: 2,
        bossNumber: 1,
        memberId: "300",
        attackType: "BATTLE",
      },
    ]);
    expect(interaction.editReplies).toHaveLength(1);
  });

  it("deletes the agent panel from the delete button", async () => {
    const guild = createGuildFixture([createGuildMember("300", "Alice")]);
    const interaction = createAgentButtonInteraction({
      guild,
      customId: "agent:delete",
    });

    await handleAgentButtonInteraction(interaction, {
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
        async setPendingDamage() {
          throw new Error("setPendingDamage should not be called");
        },
        async undo() {
          throw new Error("undo should not be called");
        },
      },
      runtimeStateService: {
        get() {
          return undefined;
        },
        getOperationLogs() {
          return [];
        },
        getPlayerResourceState() {
          return undefined;
        },
      },
    });

    expect(interaction.deferredUpdates).toBe(1);
    expect(interaction.deletedReplies).toBe(1);
  });

  it("opens a damage modal from the damage input button", async () => {
    const clanData = new ClanData({
      guildId: "100",
      categoryId: "200",
      bossChannelIds: ["11", "12", "13", "14", "15"],
      remainAttackChannelId: "16",
      commandChannelId: "18",
      summaryChannelId: "19",
      playerDataMap: new Map([["300", new PlayerData({ userId: "300" })]]),
      progressMessageIdsByLap: new Map([[2, ["p21", "p22", "p23", "p24", "p25"]]]),
      date: "2026-03-08",
    });
    clanData.initializeBossStatusData(2);
    const guild = createGuildFixture([createGuildMember("300", "Alice")]);
    const interaction = createAgentButtonInteraction({
      guild,
      customId: createAgentActionButtonCustomId({
        categoryId: "200",
        memberId: "300",
        bossIndex: 0,
        lap: 2,
        operation: "damage",
      }),
    });

    await handleAgentButtonInteraction(interaction, {
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
        async setPendingDamage() {
          throw new Error("setPendingDamage should not be called");
        },
        async undo() {
          throw new Error("undo should not be called");
        },
      },
      runtimeStateService: {
        get(categoryId) {
          return categoryId === "200" ? clanData : undefined;
        },
        getOperationLogs() {
          return [];
        },
        getPlayerResourceState() {
          return undefined;
        },
      },
    });

    expect(interaction.shownModals).toHaveLength(1);
    expect(interaction.shownModals[0]?.toJSON().title).toContain("ダメージ入力");
  });

  it("stores damage input on the pending attack and refreshes the panel", async () => {
    const alice = new PlayerData({ userId: "300" });
    const clanData = new ClanData({
      guildId: "100",
      categoryId: "200",
      bossChannelIds: ["11", "12", "13", "14", "15"],
      remainAttackChannelId: "16",
      commandChannelId: "18",
      summaryChannelId: "19",
      playerDataMap: new Map([[alice.userId, alice]]),
      progressMessageIdsByLap: new Map([[2, ["p21", "p22", "p23", "p24", "p25"]]]),
      date: "2026-03-08",
    });
    clanData.initializeBossStatusData(2);
    const guild = createGuildFixture([createGuildMember("300", "Alice")]);
    const damageRequests: Array<{
      damage: number;
      lap: number | undefined;
      bossNumber: number | undefined;
      memberId: string;
    }> = [];
    const interaction = createAgentDamageModalInteraction({
      guild,
      damage: "1,234,567",
      customId: "agent:damage:200:300:0:2",
    });

    await handleAgentDamageModalSubmit(interaction, {
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
        async setPendingDamage(request) {
          damageRequests.push({
            damage: request.damage,
            lap: request.lap,
            bossNumber: request.bossNumber,
            memberId: request.member.id,
          });
          return null;
        },
        async undo() {
          throw new Error("undo should not be called");
        },
      },
      runtimeStateService: {
        get(categoryId) {
          return categoryId === "200" ? clanData : undefined;
        },
        getOperationLogs() {
          return [];
        },
        getPlayerResourceState() {
          return undefined;
        },
      },
    });

    expect(interaction.deferredUpdates).toBe(1);
    expect(damageRequests).toEqual([
      {
        damage: 1234567,
        lap: 2,
        bossNumber: 1,
        memberId: "300",
      },
    ]);
    expect(interaction.editReplies).toHaveLength(1);
  });
});
