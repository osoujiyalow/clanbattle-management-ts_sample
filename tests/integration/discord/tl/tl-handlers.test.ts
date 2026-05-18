import {
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalBuilder,
  type ModalSubmitInteraction,
} from "discord.js";
import { describe, expect, it } from "vitest";

import { InteractionRouter } from "../../../../src/discord/interaction-router.js";
import {
  createTlActionButtonCustomId,
  registerTlCommandHandlers,
} from "../../../../src/discord/command-handlers/tl.js";
import { TlConversionService } from "../../../../src/services/tl-conversion-service.js";
import type { Logger } from "../../../../src/shared/logger.js";

type RecordedReply = {
  content: string;
  ephemeral: boolean;
};

function normalizeRecordedReply(payload: {
  content?: string;
  flags?: MessageFlags;
  ephemeral?: boolean;
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

function createSlashInteraction(): {
  interaction: ChatInputCommandInteraction;
  shownModals: ModalBuilder[];
} {
  const shownModals: ModalBuilder[] = [];

  const interaction = {
    commandName: "tl",
    isChatInputCommand: () => true,
    isButton: () => false,
    isModalSubmit: () => false,
    isRepliable: () => true,
    async showModal(modal: ModalBuilder) {
      shownModals.push(modal);
    },
  } as unknown as ChatInputCommandInteraction;

  return {
    interaction,
    shownModals,
  };
}

function createModalInteraction(options: {
  carryoverSeconds: string;
  tlBody: string;
}): {
  interaction: ModalSubmitInteraction;
  replies: RecordedReply[];
  channelSends: Array<{ content?: string; components?: unknown[] }>;
  deferredReplies: number;
  deletedReplies: number;
} {
  const replies: RecordedReply[] = [];
  const channelSends: Array<{ content?: string; components?: unknown[] }> = [];
  let deferredReplies = 0;
  let deletedReplies = 0;

  const interaction = {
    customId: "tl-modal",
    channel: {
      isTextBased: () => true,
      async send(payload: {
        content?: string;
        components?: readonly { toJSON(): unknown }[];
        allowedMentions?: unknown;
      }) {
        channelSends.push({
          content: payload.content,
          components: payload.components?.map((component) => component.toJSON()),
        });
      },
    },
    fields: {
      getTextInputValue(customId: string) {
        if (customId === "carryover-seconds") {
          return options.carryoverSeconds;
        }
        if (customId === "tl-body") {
          return options.tlBody;
        }
        return "";
      },
    },
    isChatInputCommand: () => false,
    isButton: () => false,
    isModalSubmit: () => true,
    isRepliable: () => true,
    async reply(payload: { content?: string; flags?: MessageFlags; ephemeral?: boolean }) {
      replies.push(normalizeRecordedReply(payload));
    },
    async deferReply() {
      deferredReplies += 1;
    },
    async deleteReply() {
      deletedReplies += 1;
    },
  } as unknown as ModalSubmitInteraction;

  return {
    interaction,
    replies,
    channelSends,
    get deferredReplies() {
      return deferredReplies;
    },
    get deletedReplies() {
      return deletedReplies;
    },
  };
}

function createButtonInteraction(customId: string): {
  interaction: ButtonInteraction;
  shownModals: ModalBuilder[];
  deletedMessageIds: string[];
  deferredUpdates: number;
} {
  const shownModals: ModalBuilder[] = [];
  const deletedMessageIds: string[] = [];
  let deferredUpdates = 0;

  const interaction = {
    customId,
    message: {
      id: "tl-output-1",
      async delete() {
        deletedMessageIds.push("tl-output-1");
      },
    },
    isChatInputCommand: () => false,
    isButton: () => true,
    isModalSubmit: () => false,
    isRepliable: () => true,
    async showModal(modal: ModalBuilder) {
      shownModals.push(modal);
    },
    async deferUpdate() {
      deferredUpdates += 1;
    },
  } as unknown as ButtonInteraction;

  return {
    interaction,
    shownModals,
    deletedMessageIds,
    get deferredUpdates() {
      return deferredUpdates;
    },
  };
}

describe("tl command handlers", () => {
  it("opens the TL modal from the slash command", async () => {
    const router = new InteractionRouter({ logger: createMemoryLogger() });
    registerTlCommandHandlers(router, {
      tlConversionService: new TlConversionService(),
    });

    const slash = createSlashInteraction();
    await router.handle(slash.interaction);

    expect(slash.shownModals).toHaveLength(1);
    expect(slash.shownModals[0]?.toJSON()).toMatchObject({
      custom_id: "tl-modal",
      title: "TL変換",
    });
    expect(slash.shownModals[0]?.toJSON().components).toHaveLength(2);
  });

  it("posts the converted TL with new/delete buttons after modal submit", async () => {
    const router = new InteractionRouter({ logger: createMemoryLogger() });
    registerTlCommandHandlers(router, {
      tlConversionService: new TlConversionService(),
    });

    const modal = createModalInteraction({
      carryoverSeconds: "７０",
      tlBody: "１：１０ ライラ 😀\n0:41 フィオ オートOFF",
    });
    await router.handle(modal.interaction);

    expect(modal.replies).toEqual([]);
    expect(modal.deferredReplies).toBe(1);
    expect(modal.deletedReplies).toBe(1);
    expect(modal.channelSends).toHaveLength(1);
    expect(modal.channelSends[0]?.content).toBe(
      "TL変換しました。(70秒持越)\n```\n0:50 ライラ 😀\n0:21 フィオ オートOFF\n```",
    );
    expect(modal.channelSends[0]?.components?.[0]).toMatchObject({
      components: [
        { custom_id: createTlActionButtonCustomId("new"), label: "新規" },
        { custom_id: createTlActionButtonCustomId("delete"), label: "削除" },
      ],
    });
  });

  it("opens the TL modal again from the new button", async () => {
    const router = new InteractionRouter({ logger: createMemoryLogger() });
    registerTlCommandHandlers(router, {
      tlConversionService: new TlConversionService(),
    });

    const button = createButtonInteraction(createTlActionButtonCustomId("new"));
    await router.handle(button.interaction);

    expect(button.shownModals).toHaveLength(1);
    expect(button.shownModals[0]?.toJSON()).toMatchObject({
      custom_id: "tl-modal",
      title: "TL変換",
    });
  });

  it("deletes the pressed TL output message from the delete button", async () => {
    const router = new InteractionRouter({ logger: createMemoryLogger() });
    registerTlCommandHandlers(router, {
      tlConversionService: new TlConversionService(),
    });

    const button = createButtonInteraction(createTlActionButtonCustomId("delete"));
    await router.handle(button.interaction);

    expect(button.deferredUpdates).toBe(1);
    expect(button.deletedMessageIds).toEqual(["tl-output-1"]);
  });
});
