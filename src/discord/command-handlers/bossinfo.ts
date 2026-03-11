import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type InteractionReplyOptions,
  type MessageActionRowComponentBuilder,
  type ModalActionRowComponentBuilder,
  type ModalSubmitInteraction,
} from "discord.js";

import type {
  BossInfoMessageResult,
  BossInfoModalFieldSpec,
  BossInfoModalResult,
  BossInfoService,
  BossInfoViewSpec,
} from "../../services/bossinfo-service.js";
import type { InteractionRouter } from "../interaction-router.js";
import { deferChatInputReply } from "./shared.js";

const BOSSINFO_BUTTON_PREFIX = "bossinfo";
const BOSSINFO_MODAL_PREFIX = "bossinfo-modal";

type BossInfoButtonAction = BossInfoViewSpec["buttons"][number]["action"];
type BossInfoModalKind = "phase-count" | "boundary" | "hp";

export interface BossInfoButtonCustomIdParts {
  guildId: string;
  userId: string;
  action: BossInfoButtonAction;
}

export interface BossInfoModalCustomIdParts {
  guildId: string;
  userId: string;
  kind: BossInfoModalKind;
  startIndex?: number;
  endIndex?: number;
  bossIndex?: number;
}

type BossInfoWizardService = Pick<
  BossInfoService,
  | "ensureWizardOwner"
  | "openPhaseCountModal"
  | "getCurrentBoundaryRange"
  | "openBoundaryModal"
  | "getCurrentHpContext"
  | "openHpModal"
  | "submitPhaseCount"
  | "submitBoundaries"
  | "submitHp"
  | "save"
  | "cancel"
>;

export interface BossInfoCommandHandlersOptions {
  bossInfoService: Pick<BossInfoService, "show" | "exportJson" | "startEdit"> &
    Partial<BossInfoWizardService>;
}

function hasManageGuildPermission(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction,
): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

function mapButtonStyle(style: BossInfoViewSpec["buttons"][number]["style"]): ButtonStyle {
  switch (style) {
    case "primary":
      return ButtonStyle.Primary;
    case "secondary":
      return ButtonStyle.Secondary;
    case "success":
      return ButtonStyle.Success;
    default:
      return ButtonStyle.Secondary;
  }
}

function createTextInput(field: BossInfoModalFieldSpec, index: number): TextInputBuilder {
  const input = new TextInputBuilder()
    .setCustomId(`field-${index}`)
    .setLabel(field.label)
    .setRequired(field.required)
    .setPlaceholder(field.placeholder)
    .setMaxLength(field.maxLength)
    .setStyle(TextInputStyle.Short);

  if (field.defaultValue.length > 0) {
    input.setValue(field.defaultValue);
  }

  return input;
}

function createBossInfoComponents(input: {
  guildId: string | null;
  userId: string;
  view: BossInfoViewSpec | undefined;
}): ActionRowBuilder<MessageActionRowComponentBuilder>[] | undefined {
  if (!input.view || !input.guildId) {
    return undefined;
  }

  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>();
  for (const button of input.view.buttons) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(
          createBossInfoButtonCustomId({
            guildId: input.guildId,
            userId: input.userId,
            action: button.action,
          }),
        )
        .setLabel(button.label)
        .setStyle(mapButtonStyle(button.style)),
    );
  }

  return [row];
}

function createBossInfoModal(
  result: BossInfoModalResult,
  customId: string,
): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(result.title);

  for (let index = 0; index < result.fields.length; index += 1) {
    modal.addComponents(
      new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
        createTextInput(result.fields[index]!, index),
      ),
    );
  }

  return modal;
}

function createReplyPayload(
  input: {
    guildId: string | null;
    userId: string;
  },
  result: BossInfoMessageResult,
): InteractionReplyOptions {
  const components = createBossInfoComponents({
    guildId: input.guildId,
    userId: input.userId,
    view: result.view,
  });
  const files = result.attachment
    ? [
        new AttachmentBuilder(Buffer.from(result.attachment.content, "utf8"), {
          name: result.attachment.filename,
        }),
      ]
    : undefined;

  return {
    content: result.content,
    ...(result.visibility === "ephemeral" ? { flags: MessageFlags.Ephemeral } : {}),
    ...(components ? { components } : {}),
    ...(files ? { files } : {}),
  };
}

function createWizardUpdatePayload(
  input: {
    guildId: string | null;
    userId: string;
  },
  result: BossInfoMessageResult,
): {
  content: string;
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
} {
  return {
    content: result.content,
    components:
      createBossInfoComponents({
        guildId: input.guildId,
        userId: input.userId,
        view: result.view,
      }) ?? [],
  };
}

function createWizardSessionRequest(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction,
) {
  return {
    guildId: interaction.guildId,
    userId: interaction.user.id,
    hasManageGuildPermission: hasManageGuildPermission(interaction),
  };
}

function isUnknownMessageError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 10008;
}

function collectModalFieldValues(
  interaction: ModalSubmitInteraction,
  fieldCount: number,
): string[] {
  return Array.from({ length: fieldCount }, (_, index) =>
    interaction.fields.getTextInputValue(`field-${index}`),
  );
}

function parseBossInfoButtonCustomId(customId: string): BossInfoButtonCustomIdParts | null {
  const parts = customId.split(":");
  if (parts.length !== 4 || parts[0] !== BOSSINFO_BUTTON_PREFIX) {
    return null;
  }

  const [, guildId, userId, action] = parts;
  if (!guildId || !userId || !action) {
    return null;
  }

  if (
    action !== "start" &&
    action !== "cancel" &&
    action !== "open-boundary" &&
    action !== "open-hp" &&
    action !== "save"
  ) {
    return null;
  }

  return {
    guildId,
    userId,
    action,
  };
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseBossInfoModalCustomId(customId: string): BossInfoModalCustomIdParts | null {
  const parts = customId.split(":");
  if (parts.length < 4 || parts[0] !== BOSSINFO_MODAL_PREFIX) {
    return null;
  }

  const [, guildId, userId, kind] = parts;
  if (!guildId || !userId || !kind) {
    return null;
  }

  if (kind === "phase-count" && parts.length === 4) {
    return {
      guildId,
      userId,
      kind,
    };
  }

  if (kind === "boundary" && parts.length === 6) {
    const startIndex = parseOptionalInteger(parts[4]);
    const endIndex = parseOptionalInteger(parts[5]);
    if (startIndex === undefined || endIndex === undefined) {
      return null;
    }

    return {
      guildId,
      userId,
      kind,
      startIndex,
      endIndex,
    };
  }

  if (kind === "hp" && parts.length === 7) {
    const bossIndex = parseOptionalInteger(parts[4]);
    const startIndex = parseOptionalInteger(parts[5]);
    const endIndex = parseOptionalInteger(parts[6]);
    if (bossIndex === undefined || startIndex === undefined || endIndex === undefined) {
      return null;
    }

    return {
      guildId,
      userId,
      kind,
      bossIndex,
      startIndex,
      endIndex,
    };
  }

  return null;
}

function createModalCustomIdFromResult(
  input: {
    guildId: string;
    userId: string;
  },
  result: BossInfoModalResult,
  fallback: BossInfoModalCustomIdParts,
): string {
  return createBossInfoModalCustomId({
    guildId: input.guildId,
    userId: input.userId,
    ...(result.context ?? fallback),
  });
}

async function replyBossInfoResult(
  interaction: ChatInputCommandInteraction,
  result: BossInfoMessageResult,
): Promise<void> {
  const payload = createReplyPayload(
    {
      guildId: interaction.guildId,
      userId: interaction.user.id,
    },
    result,
  );

  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply({
      content: payload.content ?? null,
      ...(payload.components ? { components: payload.components } : {}),
      ...(payload.files ? { files: payload.files } : {}),
    });
    return;
  }

  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload);
    return;
  }

  await interaction.reply(payload);
}

async function replyBossInfoEphemeral(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  result: BossInfoMessageResult,
): Promise<void> {
  const payload = createReplyPayload(
    {
      guildId: interaction.guildId,
      userId: interaction.user.id,
    },
    result,
  );

  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload);
    return;
  }

  await interaction.reply(payload);
}

async function updateBossInfoWizard(
  interaction: ButtonInteraction,
  result: BossInfoMessageResult,
): Promise<void> {
  await interaction.update(
    createWizardUpdatePayload(
      {
        guildId: interaction.guildId,
        userId: interaction.user.id,
      },
      result,
    ),
  );
}

async function applyBossInfoModalResult(
  interaction: ModalSubmitInteraction,
  result: BossInfoMessageResult,
): Promise<void> {
  const wizardUpdatePayload = createWizardUpdatePayload(
    {
      guildId: interaction.guildId,
      userId: interaction.user.id,
    },
    result,
  );

  if (interaction.message) {
    await interaction.deferUpdate();
    try {
      await interaction.message.edit(wizardUpdatePayload);
      return;
    } catch (error) {
      if (!isUnknownMessageError(error)) {
        throw error;
      }

      await interaction.followUp({
        ...wizardUpdatePayload,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  await replyBossInfoEphemeral(interaction, result);
}

function requireWizardService(
  service: BossInfoCommandHandlersOptions["bossInfoService"],
): service is Pick<BossInfoService, "show" | "exportJson" | "startEdit"> & BossInfoWizardService {
  return (
    typeof service.ensureWizardOwner === "function" &&
    typeof service.openPhaseCountModal === "function" &&
    typeof service.getCurrentBoundaryRange === "function" &&
    typeof service.openBoundaryModal === "function" &&
    typeof service.getCurrentHpContext === "function" &&
    typeof service.openHpModal === "function" &&
    typeof service.submitPhaseCount === "function" &&
    typeof service.submitBoundaries === "function" &&
    typeof service.submitHp === "function" &&
    typeof service.save === "function" &&
    typeof service.cancel === "function"
  );
}

export function createBossInfoButtonCustomId(parts: BossInfoButtonCustomIdParts): string {
  return `${BOSSINFO_BUTTON_PREFIX}:${parts.guildId}:${parts.userId}:${parts.action}`;
}

export function createBossInfoModalCustomId(parts: BossInfoModalCustomIdParts): string {
  switch (parts.kind) {
    case "phase-count":
      return `${BOSSINFO_MODAL_PREFIX}:${parts.guildId}:${parts.userId}:${parts.kind}`;
    case "boundary":
      return `${BOSSINFO_MODAL_PREFIX}:${parts.guildId}:${parts.userId}:${parts.kind}:${parts.startIndex}:${parts.endIndex}`;
    case "hp":
      return `${BOSSINFO_MODAL_PREFIX}:${parts.guildId}:${parts.userId}:${parts.kind}:${parts.bossIndex}:${parts.startIndex}:${parts.endIndex}`;
    default:
      return `${BOSSINFO_MODAL_PREFIX}:${parts.guildId}:${parts.userId}:${parts.kind}`;
  }
}

export async function handleBossInfoShowCommand(
  interaction: ChatInputCommandInteraction,
  options: BossInfoCommandHandlersOptions,
): Promise<void> {
  await deferChatInputReply(interaction, true);

  await replyBossInfoResult(
    interaction,
    options.bossInfoService.show({
      guildId: interaction.guildId,
      hasManageGuildPermission: hasManageGuildPermission(interaction),
    }),
  );
}

export async function handleBossInfoExportJsonCommand(
  interaction: ChatInputCommandInteraction,
  options: BossInfoCommandHandlersOptions,
): Promise<void> {
  await deferChatInputReply(interaction, true);

  await replyBossInfoResult(
    interaction,
    options.bossInfoService.exportJson({
      guildId: interaction.guildId,
      hasManageGuildPermission: hasManageGuildPermission(interaction),
    }),
  );
}

export async function handleBossInfoEditCommand(
  interaction: ChatInputCommandInteraction,
  options: BossInfoCommandHandlersOptions,
): Promise<void> {
  await deferChatInputReply(interaction, true);

  await replyBossInfoResult(
    interaction,
    options.bossInfoService.startEdit({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      hasManageGuildPermission: hasManageGuildPermission(interaction),
    }),
  );
}

export async function handleBossInfoButtonInteraction(
  interaction: ButtonInteraction,
  service: BossInfoWizardService,
): Promise<void> {
  const customId = parseBossInfoButtonCustomId(interaction.customId);
  if (!customId) {
    return;
  }

  const ownerError = service.ensureWizardOwner(
    customId.guildId,
    customId.userId,
    interaction.guildId,
    interaction.user.id,
  );
  if (ownerError) {
    await replyBossInfoEphemeral(interaction, ownerError);
    return;
  }

  const request = createWizardSessionRequest(interaction);

  if (customId.action === "start") {
    const result = service.openPhaseCountModal(request);
    if (result.kind === "message") {
      await updateBossInfoWizard(interaction, result);
      return;
    }

    await interaction.showModal(
      createBossInfoModal(
        result,
        createModalCustomIdFromResult(
          {
            guildId: customId.guildId,
            userId: customId.userId,
          },
          result,
          {
            guildId: customId.guildId,
            userId: customId.userId,
            kind: "phase-count",
          },
        ),
      ),
    );
    return;
  }

  if (customId.action === "open-boundary") {
    const rangeResult = service.getCurrentBoundaryRange(request);
    if ("kind" in rangeResult) {
      await updateBossInfoWizard(interaction, rangeResult);
      return;
    }

    const result = service.openBoundaryModal(request);
    if (result.kind === "message") {
      await updateBossInfoWizard(interaction, result);
      return;
    }

    await interaction.showModal(
      createBossInfoModal(
        result,
        createModalCustomIdFromResult(
          {
            guildId: customId.guildId,
            userId: customId.userId,
          },
          result,
          {
            guildId: customId.guildId,
            userId: customId.userId,
            kind: "boundary",
            startIndex: rangeResult.startIndex,
            endIndex: rangeResult.endIndex,
          },
        ),
      ),
    );
    return;
  }

  if (customId.action === "open-hp") {
    const contextResult = service.getCurrentHpContext(request);
    if ("kind" in contextResult) {
      await updateBossInfoWizard(interaction, contextResult);
      return;
    }

    const result = service.openHpModal(request);
    if (result.kind === "message") {
      await updateBossInfoWizard(interaction, result);
      return;
    }

    await interaction.showModal(
      createBossInfoModal(
        result,
        createModalCustomIdFromResult(
          {
            guildId: customId.guildId,
            userId: customId.userId,
          },
          result,
          {
            guildId: customId.guildId,
            userId: customId.userId,
            kind: "hp",
            bossIndex: contextResult.bossIndex,
            startIndex: contextResult.startIndex,
            endIndex: contextResult.endIndex,
          },
        ),
      ),
    );
    return;
  }

  if (customId.action === "save") {
    await updateBossInfoWizard(interaction, service.save(request));
    return;
  }

  await updateBossInfoWizard(interaction, service.cancel(request));
}

export async function handleBossInfoModalInteraction(
  interaction: ModalSubmitInteraction,
  service: BossInfoWizardService,
): Promise<void> {
  const customId = parseBossInfoModalCustomId(interaction.customId);
  if (!customId) {
    return;
  }

  const ownerError = service.ensureWizardOwner(
    customId.guildId,
    customId.userId,
    interaction.guildId,
    interaction.user.id,
  );
  if (ownerError) {
    await replyBossInfoEphemeral(interaction, ownerError);
    return;
  }

  const request = createWizardSessionRequest(interaction);
  let result: BossInfoMessageResult;

  if (customId.kind === "phase-count") {
    result = service.submitPhaseCount({
      ...request,
      rawValue: interaction.fields.getTextInputValue("field-0"),
    });
    await applyBossInfoModalResult(interaction, result);
    return;
  }

  if (customId.kind === "boundary") {
    const fieldCount = customId.endIndex! - customId.startIndex! + 1;
    result = service.submitBoundaries({
      ...request,
      startIndex: customId.startIndex!,
      endIndex: customId.endIndex!,
      values: collectModalFieldValues(interaction, fieldCount),
    });
    await applyBossInfoModalResult(interaction, result);
    return;
  }

  const fieldCount = customId.endIndex! - customId.startIndex! + 1;
  result = service.submitHp({
    ...request,
    bossIndex: customId.bossIndex!,
    startIndex: customId.startIndex!,
    endIndex: customId.endIndex!,
    values: collectModalFieldValues(interaction, fieldCount),
  });
  await applyBossInfoModalResult(interaction, result);
}

export function registerBossInfoCommandHandlers(
  router: InteractionRouter,
  options: BossInfoCommandHandlersOptions,
): void {
  router.registerChatInputCommand("bossinfo_show", async (interaction) => {
    await handleBossInfoShowCommand(interaction, options);
  });
  router.registerChatInputCommand("bossinfo_export_json", async (interaction) => {
    await handleBossInfoExportJsonCommand(interaction, options);
  });
  router.registerChatInputCommand("bossinfo_edit", async (interaction) => {
    await handleBossInfoEditCommand(interaction, options);
  });

  if (!requireWizardService(options.bossInfoService)) {
    return;
  }

  const bossInfoWizardService = options.bossInfoService;

  router.registerButtonHandler(/^bossinfo:/u, async (interaction) => {
    await handleBossInfoButtonInteraction(interaction, bossInfoWizardService);
  });
  router.registerModalHandler(/^bossinfo-modal:/u, async (interaction) => {
    await handleBossInfoModalInteraction(interaction, bossInfoWizardService);
  });
}
