import { afterEach, describe, expect, it } from "vitest";
import {
  MessageFlags,
  type ButtonInteraction,
  type Guild,
  type ModalBuilder,
  type ModalSubmitInteraction,
  type User,
} from "discord.js";

import { ClanBattleData } from "../../../../src/domain/clan-battle-data.js";
import { ClanData } from "../../../../src/domain/clan-data.js";
import { InteractionRouter } from "../../../../src/discord/interaction-router.js";
import {
  createBossInfoButtonCustomId,
  createBossInfoModalCustomId,
  registerBossInfoCommandHandlers,
} from "../../../../src/discord/command-handlers/bossinfo.js";
import { GuildBossInfoRepository } from "../../../../src/repositories/sqlite/guild-bossinfo-repository.js";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
  type SqliteDatabase,
} from "../../../../src/repositories/sqlite/db.js";
import { BossInfoService } from "../../../../src/services/bossinfo-service.js";
import { RuntimeStateService } from "../../../../src/services/runtime-state-service.js";
import type { Logger } from "../../../../src/shared/logger.js";
import { createCoreRepositorySchema } from "../../../unit/repositories/sqlite/core-repository-schema.js";
import { createTempSqlitePath, type TempSqlitePath } from "../../../unit/repositories/sqlite/test-sqlite-path.js";

type RecordedReply = {
  content: string;
  ephemeral: boolean;
  components?: unknown[];
};

function normalizeRecordedReply(payload: {
  content?: string;
  ephemeral?: boolean;
  flags?: MessageFlags;
  components?: unknown[];
}): RecordedReply {
  return {
    content: payload.content ?? "",
    ephemeral: payload.ephemeral ?? payload.flags === MessageFlags.Ephemeral,
    ...(payload.components ? { components: payload.components } : {}),
  };
}

class FakeWizardMessage {
  readonly edits: Array<{ content?: string; components?: unknown[] }> = [];

  async edit(payload: { content?: string; components?: readonly { toJSON(): unknown }[] }): Promise<void> {
    this.edits.push({
      content: payload.content,
      components: payload.components?.map((component) => component.toJSON()),
    });
  }
}

class FakeMissingWizardMessage {
  async edit(): Promise<void> {
    throw {
      code: 10008,
      message: "Unknown Message",
    };
  }
}

function createMemoryLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function createClanData(params?: Partial<ConstructorParameters<typeof ClanData>[0]>): ClanData {
  return new ClanData({
    guildId: "123456789012345678",
    categoryId: "223456789012345678",
    bossChannelIds: ["323", "423", "523", "623", "723"],
    remainAttackChannelId: "823",
    commandChannelId: "923",
    summaryChannelId: "10323",
    date: "2026-03-08",
    ...params,
  });
}

function createUser(id: string, displayName: string): User {
  return {
    id,
    username: displayName,
    globalName: displayName,
    displayName,
  } as unknown as User;
}

function createGuild(): Guild {
  return {
    id: "123456789012345678",
    name: "Test Guild",
  } as Guild;
}

function createButtonInteraction(options: {
  customId: string;
  userId?: string;
  guildId?: string | null;
  hasManageGuildPermission?: boolean;
}): {
  interaction: ButtonInteraction;
  replies: RecordedReply[];
  updates: Array<{ content?: string; components?: unknown[] }>;
  shownModals: ModalBuilder[];
} {
  const replies: RecordedReply[] = [];
  const updates: Array<{ content?: string; components?: unknown[] }> = [];
  const shownModals: ModalBuilder[] = [];
  let replied = false;

  const interaction = {
    customId: options.customId,
    guildId: options.guildId ?? "123456789012345678",
    guild: createGuild(),
    channelId: "923",
    user: createUser(options.userId ?? "111", "Invoker"),
    memberPermissions: {
      has() {
        return options.hasManageGuildPermission ?? true;
      },
    },
    deferred: false,
    get replied() {
      return replied;
    },
    isButton: () => true,
    isChatInputCommand: () => false,
    isModalSubmit: () => false,
    isRepliable: () => true,
    async reply(payload: {
      content?: string;
      ephemeral?: boolean;
      flags?: MessageFlags;
      components?: unknown[];
    }) {
      replied = true;
      replies.push(normalizeRecordedReply(payload));
    },
    async followUp(payload: {
      content?: string;
      ephemeral?: boolean;
      flags?: MessageFlags;
      components?: unknown[];
    }) {
      replies.push(normalizeRecordedReply(payload));
    },
    async update(payload: { content?: string; components?: readonly { toJSON(): unknown }[] }) {
      replied = true;
      updates.push({
        content: payload.content,
        components: payload.components?.map((component) => component.toJSON()),
      });
    },
    async showModal(modal: ModalBuilder) {
      shownModals.push(modal);
    },
  } as unknown as ButtonInteraction;

  return {
    interaction,
    replies,
    updates,
    shownModals,
  };
}

function createModalInteraction(options: {
  customId: string;
  values: string[];
  message?: FakeWizardMessage | null;
  userId?: string;
  guildId?: string | null;
  hasManageGuildPermission?: boolean;
}): {
  interaction: ModalSubmitInteraction;
  replies: RecordedReply[];
  deferredUpdates: number;
} {
  const replies: RecordedReply[] = [];
  let replied = false;
  let deferredUpdates = 0;

  const interaction = {
    customId: options.customId,
    guildId: options.guildId ?? "123456789012345678",
    guild: createGuild(),
    channelId: "923",
    user: createUser(options.userId ?? "111", "Invoker"),
    memberPermissions: {
      has() {
        return options.hasManageGuildPermission ?? true;
      },
    },
    message: (options.message ?? new FakeWizardMessage()) as unknown as ModalSubmitInteraction["message"],
    fields: {
      getTextInputValue(customId: string) {
        const index = Number.parseInt(customId.replace("field-", ""), 10);
        return options.values[index] ?? "";
      },
    },
    deferred: false,
    get replied() {
      return replied;
    },
    isButton: () => false,
    isChatInputCommand: () => false,
    isModalSubmit: () => true,
    isRepliable: () => true,
    async reply(payload: {
      content?: string;
      ephemeral?: boolean;
      flags?: MessageFlags;
      components?: unknown[];
    }) {
      replied = true;
      replies.push(normalizeRecordedReply(payload));
    },
    async followUp(payload: {
      content?: string;
      ephemeral?: boolean;
      flags?: MessageFlags;
      components?: unknown[];
    }) {
      replies.push(normalizeRecordedReply(payload));
    },
    async deferUpdate() {
      deferredUpdates += 1;
    },
  } as unknown as ModalSubmitInteraction;

  return {
    interaction,
    replies,
    get deferredUpdates() {
      return deferredUpdates;
    },
  };
}

describe("bossinfo wizard discord handlers", () => {
  let tempPath: TempSqlitePath | undefined;
  let database: SqliteDatabase | undefined;

  afterEach(() => {
    ClanBattleData.loadGuildConfigMap(new Map());
    if (database) {
      closeSqliteDatabase(database);
    }
    database = undefined;
    tempPath?.cleanup();
    tempPath = undefined;
  });

  function createFixture() {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    runtimeStateService.set(createClanData());
    runtimeStateService.set(
      createClanData({
        categoryId: "323456789012345678",
      }),
    );

    const repository = new GuildBossInfoRepository(database);
    const service = new BossInfoService({
      runtimeStateService,
      guildBossInfoRepository: repository,
    });
    const router = new InteractionRouter({
      logger: createMemoryLogger(),
    });

    registerBossInfoCommandHandlers(router, {
      bossInfoService: service,
    });

    return {
      repository,
      service,
      router,
    };
  }

  it("opens the phase-count modal from the start button", async () => {
    const { service, router } = createFixture();
    service.startEdit({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
    });

    const button = createButtonInteraction({
      customId: createBossInfoButtonCustomId({
        guildId: "123456789012345678",
        userId: "111",
        action: "start",
      }),
    });

    await router.handle(button.interaction);

    expect(button.shownModals).toHaveLength(1);
    expect(button.shownModals[0]?.toJSON()).toMatchObject({
      custom_id: createBossInfoModalCustomId({
        guildId: "123456789012345678",
        userId: "111",
        kind: "phase-count",
      }),
    });
    expect(button.shownModals[0]?.toJSON().title).toContain("ボス情報書き換え:");
  });

  it("updates the wizard message after phase-count modal submit", async () => {
    const { service, router } = createFixture();
    service.startEdit({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
    });

    const wizardMessage = new FakeWizardMessage();
    const modal = createModalInteraction({
      customId: createBossInfoModalCustomId({
        guildId: "123456789012345678",
        userId: "111",
        kind: "phase-count",
      }),
      values: ["4"],
      message: wizardMessage,
    });

    await router.handle(modal.interaction);

    expect(modal.deferredUpdates).toBe(1);
    expect(wizardMessage.edits).toHaveLength(1);
    expect(wizardMessage.edits[0]?.content).toContain("段階数を下書きに反映しました");
    expect(wizardMessage.edits[0]?.components?.[0]).toMatchObject({
      components: expect.arrayContaining([
        expect.objectContaining({
          custom_id: createBossInfoButtonCustomId({
            guildId: "123456789012345678",
            userId: "111",
            action: "open-boundary",
          }),
        }),
      ]),
    });
  });

  it("falls back to an ephemeral follow-up when the wizard message is missing", async () => {
    const { service, router } = createFixture();
    service.startEdit({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
    });

    const modal = createModalInteraction({
      customId: createBossInfoModalCustomId({
        guildId: "123456789012345678",
        userId: "111",
        kind: "phase-count",
      }),
      values: ["4"],
      message: new FakeMissingWizardMessage() as unknown as FakeWizardMessage,
    });

    await router.handle(modal.interaction);

    expect(modal.deferredUpdates).toBe(1);
    expect(modal.replies).toHaveLength(1);
    expect(modal.replies[0]).toMatchObject({
      ephemeral: true,
    });
    expect(modal.replies[0]?.content).toContain("段階数を下書きに反映しました");
  });

  it("opens boundary and hp modals from wizard buttons", async () => {
    const { service, router } = createFixture();
    service.startEdit({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
    });
    service.submitPhaseCount({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
      rawValue: "4",
    });

    const boundaryButton = createButtonInteraction({
      customId: createBossInfoButtonCustomId({
        guildId: "123456789012345678",
        userId: "111",
        action: "open-boundary",
      }),
    });
    await router.handle(boundaryButton.interaction);

    expect(boundaryButton.shownModals).toHaveLength(1);
    expect(boundaryButton.shownModals[0]?.toJSON()).toMatchObject({
      custom_id: createBossInfoModalCustomId({
        guildId: "123456789012345678",
        userId: "111",
        kind: "boundary",
        startIndex: 0,
        endIndex: 3,
      }),
    });

    service.submitBoundaries({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
      startIndex: 0,
      endIndex: 3,
      values: ["1 6", "7 22", "23 30", "31 -1"],
    });

    const hpButton = createButtonInteraction({
      customId: createBossInfoButtonCustomId({
        guildId: "123456789012345678",
        userId: "111",
        action: "open-hp",
      }),
    });
    await router.handle(hpButton.interaction);

    expect(hpButton.shownModals).toHaveLength(1);
    expect(hpButton.shownModals[0]?.toJSON()).toMatchObject({
      custom_id: createBossInfoModalCustomId({
        guildId: "123456789012345678",
        userId: "111",
        kind: "hp",
        bossIndex: -1,
        startIndex: 0,
        endIndex: 3,
      }),
    });
  });

  it("persists the config on save after the modal flow", async () => {
    const { repository, service, router } = createFixture();
    service.startEdit({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
    });

    const wizardMessage = new FakeWizardMessage();

    await router.handle(
      createModalInteraction({
        customId: createBossInfoModalCustomId({
          guildId: "123456789012345678",
          userId: "111",
          kind: "phase-count",
        }),
        values: ["1"],
        message: wizardMessage,
      }).interaction,
    );

    await router.handle(
      createModalInteraction({
        customId: createBossInfoModalCustomId({
          guildId: "123456789012345678",
          userId: "111",
          kind: "boundary",
          startIndex: 0,
          endIndex: 0,
        }),
        values: ["1 -1"],
        message: wizardMessage,
      }).interaction,
    );

    await router.handle(
      createModalInteraction({
        customId: createBossInfoModalCustomId({
          guildId: "123456789012345678",
          userId: "111",
          kind: "hp",
          bossIndex: -1,
          startIndex: 0,
          endIndex: 0,
        }),
        values: ["1200 1500 2000 2300 3000"],
        message: wizardMessage,
      }).interaction,
    );

    const previewButton = createButtonInteraction({
      customId: createBossInfoButtonCustomId({
        guildId: "123456789012345678",
        userId: "111",
        action: "preview-save",
      }),
    });
    await router.handle(previewButton.interaction);

    expect(previewButton.updates[0]?.content).toContain("保存前プレビュー");

    const saveButton = createButtonInteraction({
      customId: createBossInfoButtonCustomId({
        guildId: "123456789012345678",
        userId: "111",
        action: "save",
      }),
    });
    await router.handle(saveButton.interaction);

    const savedConfig = repository.loadAll().get("123456789012345678");
    expect(saveButton.updates).toHaveLength(1);
    expect(saveButton.updates[0]?.content).toContain("bossinfo 設定を保存しました");
    expect(savedConfig?.boundaries).toEqual([[1, -1]]);
    expect(savedConfig?.hp).toEqual([[1200, 1500, 2000, 2300, 3000]]);
    expect(service.getActiveSessionCount()).toBe(0);
  });

  it("replies ephemerally when another user clicks the wizard", async () => {
    const { service, router } = createFixture();
    service.startEdit({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
    });

    const button = createButtonInteraction({
      customId: createBossInfoButtonCustomId({
        guildId: "123456789012345678",
        userId: "111",
        action: "start",
      }),
      userId: "222",
    });

    await router.handle(button.interaction);

    expect(button.replies).toHaveLength(1);
    expect(button.replies[0]).toMatchObject({
      ephemeral: true,
    });
    expect(button.replies[0]?.content.length).toBeGreaterThan(0);
  });
});
