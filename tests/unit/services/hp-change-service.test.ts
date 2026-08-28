import { afterEach, describe, expect, it } from "vitest";

import { ClanData } from "../../../src/domain/clan-data.js";
import { resolveCurrentBossHp } from "../../../src/domain/boss-hp.js";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
} from "../../../src/repositories/sqlite/db.js";
import type {
  AttackDiscordGateway,
  AttackEditableMessage,
  AttackTextChannel,
} from "../../../src/services/attack-service.js";
import { HpChangeService } from "../../../src/services/hp-change-service.js";
import { RuntimeStateService } from "../../../src/services/runtime-state-service.js";
import { createFixedClock } from "../../../src/shared/time.js";
import { createCoreRepositorySchema } from "../repositories/sqlite/core-repository-schema.js";
import {
  createTempSqlitePath,
  type TempSqlitePath,
} from "../repositories/sqlite/test-sqlite-path.js";

class FakeEditableMessage implements AttackEditableMessage {
  readonly edits: Array<{ embeds?: unknown[]; components?: unknown[] }> = [];

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

  async addReaction(): Promise<void> {}
}

class FakeTextChannel implements AttackTextChannel {
  readonly messages = new Map<string, FakeEditableMessage>();
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
    this.messages.set(message.id, message);
    if (payload?.embeds || payload?.components) {
      await message.edit(payload);
    }
    return message;
  }
}

class FakeDiscordGateway implements AttackDiscordGateway {
  private readonly channels = new Map<string, FakeTextChannel>();

  register(channel: FakeTextChannel): void {
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

describe("HpChangeService", () => {
  let tempPath: TempSqlitePath | undefined;

  afterEach(() => {
    tempPath?.cleanup();
    tempPath = undefined;
  });

  it("adds signed correction history without consuming an attack resource", async () => {
    tempPath = createTempSqlitePath();
    const database = openSqliteDatabase({ filePath: tempPath.filePath });

    try {
      createCoreRepositorySchema(database);
      const clock = createFixedClock("2026-03-08T12:00:00+09:00");
      const runtimeStateService = new RuntimeStateService({ database, clock });
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
      clanData.bossStatusByLap.get(1)![0]!.maxHp = 5000;
      runtimeStateService.set(clanData);

      const bossChannel = new FakeTextChannel("323");
      bossChannel.messages.set("111", new FakeEditableMessage("111"));
      const summaryChannel = new FakeTextChannel("10323");
      summaryChannel.messages.set("211", new FakeEditableMessage("211"));
      const gateway = new FakeDiscordGateway();
      gateway.register(bossChannel);
      gateway.register(summaryChannel);
      const responses: string[] = [];
      const service = new HpChangeService({ database, runtimeStateService, clock });

      const decrease = await service.changeBossHp({
        categoryId: clanData.categoryId,
        channelId: "323",
        lap: 1,
        bossIndex: 0,
        targetHp: 4000,
        actor: { id: "400", displayName: "Alice" },
        responseChannel: {
          async send(payload) {
            responses.push(payload.content ?? "");
          },
        },
        discordGateway: gateway,
        displayNamesByUserId: new Map([["400", "Alice"]]),
      });
      const increase = await service.changeBossHp({
        categoryId: clanData.categoryId,
        channelId: "323",
        lap: 1,
        bossIndex: 0,
        targetHp: 4500,
        actor: { id: "400", displayName: "Alice" },
        responseChannel: {
          async send(payload) {
            responses.push(payload.content ?? "");
          },
        },
        discordGateway: gateway,
        displayNamesByUserId: new Map([["400", "Alice"]]),
      });

      expect(decrease).toEqual({ beforeHp: 5000, afterHp: 4000, hpDelta: -1000 });
      expect(increase).toEqual({ beforeHp: 4000, afterHp: 4500, hpDelta: 500 });
      expect(responses).toEqual([
        "1ボスのHPを修正しました。\n5,000万 → 4,000万（-1,000万） Alice",
        "1ボスのHPを修正しました。\n4,000万 → 4,500万（+500万） Alice",
      ]);

      const stored = database
        .prepare<[], { damage: bigint; attack_type: string }>(
          "select damage, attack_type from AttackStatus order by created",
        )
        .all();
      expect(stored).toEqual([
        { damage: 1000n, attack_type: "修正" },
        { damage: -500n, attack_type: "修正" },
      ]);
      expect(
        database.prepare<[], { count: bigint }>("select count(*) as count from AttackEntry").get()
          ?.count,
      ).toBe(0n);
      expect(runtimeStateService.getPlayerResourceStates(clanData.categoryId)).toEqual([]);

      const latestProgressEdit = bossChannel.messages.get("111")?.edits.at(-1)?.embeds?.[0] as {
        title?: string;
        description?: string;
      };
      expect(latestProgressEdit.title).toContain("4,500万/5,000万");
      expect(latestProgressEdit.description).toContain("(修正済) -1,000万 Alice");
      expect(latestProgressEdit.description).toContain("(修正済) +500万 Alice");

      await runtimeStateService.ensureDateUpToDate(
        clanData.categoryId,
        createFixedClock("2026-03-09T12:00:00+09:00"),
      );
      expect(resolveCurrentBossHp(clanData.bossStatusByLap.get(1)![0]!)).toBe(4500);
      expect(
        database.prepare<[], { count: bigint }>("select count(*) as count from AttackStatus").get()
          ?.count,
      ).toBe(2n);
    } finally {
      closeSqliteDatabase(database);
    }
  });
});
