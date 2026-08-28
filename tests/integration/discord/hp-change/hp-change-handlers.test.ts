import { ChannelType, PermissionFlagsBits } from "discord.js";
import { describe, expect, it } from "vitest";

import { ClanData } from "../../../../src/domain/clan-data.js";
import {
  handleHpChangeCommand,
  handleHpChangeModal,
} from "../../../../src/discord/command-handlers/hp-change.js";

function createClanData(): ClanData {
  const clanData = new ClanData({
    guildId: "123456789012345678",
    categoryId: "223456789012345678",
    bossChannelIds: ["323", "423", "523", "623", "723"],
    remainAttackChannelId: "823",
    commandChannelId: "923",
    summaryChannelId: "10323",
    progressMessageIdsByLap: new Map([[7, ["111", "112", "113", "114", "115"]]]),
    date: "2026-03-08",
  });
  clanData.initializeBossStatusData(7);
  clanData.bossStatusByLap.get(7)![0]!.maxHp = 5000;
  return clanData;
}

function createManageGuildPermissions() {
  return {
    has(permission: bigint) {
      return permission === PermissionFlagsBits.ManageGuild;
    },
  };
}

describe("hp_change handlers", () => {
  it("opens a boss-scoped modal with the current HP as its initial value", async () => {
    const clanData = createClanData();
    const shownModals: unknown[] = [];
    const interaction = {
      guildId: clanData.guildId,
      guild: {
        channels: {
          async fetch() {
            return {
              id: "323",
              type: ChannelType.GuildText,
              parentId: clanData.categoryId,
            };
          },
        },
      },
      channelId: "323",
      memberPermissions: createManageGuildPermissions(),
      user: { id: "400" },
      async reply() {},
      async showModal(modal: { toJSON(): unknown }) {
        shownModals.push(modal.toJSON());
      },
    };

    await handleHpChangeCommand(interaction as never, {
      hpChangeService: { async changeBossHp() { return null; } },
      runtimeStateService: { get: () => clanData },
    });

    expect(shownModals).toEqual([
      expect.objectContaining({
        custom_id: `hp-change:${clanData.categoryId}:400:7:0`,
        title: "7周目 1ボス HP修正",
        components: [
          expect.objectContaining({
            components: [
              expect.objectContaining({
                custom_id: "target-hp",
                label: "修正後HP（万）",
                value: "5000",
              }),
            ],
          }),
        ],
      }),
    ]);
  });

  it("submits comma-separated full-width HP with the modal owner as actor", async () => {
    const clanData = createClanData();
    const requests: Array<Record<string, unknown>> = [];
    const cachedMember = {
      id: "400",
      nickname: "Alice",
      displayName: "Alice",
      user: { id: "400", globalName: "Alice" },
    };
    const interaction = {
      customId: `hp-change:${clanData.categoryId}:400:7:0`,
      guild: {
        members: {
          cache: new Map([["400", cachedMember]]),
          async fetch() {
            return cachedMember;
          },
        },
        channels: { async fetch() { return null; } },
      },
      channelId: "323",
      memberPermissions: createManageGuildPermissions(),
      user: { id: "400", globalName: "Alice" },
      fields: {
        getTextInputValue() {
          return "４，５００";
        },
      },
      deferred: false,
      replied: false,
      async reply() {},
      async deferReply() {
        this.deferred = true;
      },
      async editReply() {},
      async followUp() {},
    };

    await handleHpChangeModal(interaction as never, {
      hpChangeService: {
        async changeBossHp(request) {
          requests.push(request as unknown as Record<string, unknown>);
          return null;
        },
      },
      runtimeStateService: { get: () => clanData },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      categoryId: clanData.categoryId,
      channelId: "323",
      lap: 7,
      bossIndex: 0,
      targetHp: 4500,
      actor: { id: "400", displayName: "Alice" },
    });
  });
});
