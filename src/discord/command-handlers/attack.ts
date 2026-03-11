import type { ChatInputCommandInteraction } from "discord.js";

import type { AttackService } from "../../services/attack-service.js";
import type { ProgressMessageService } from "../../services/progress-message-service.js";
import { createChannelCarryOverSelector } from "../carryover-selector.js";
import type { InteractionRouter } from "../interaction-router.js";
import {
  DiscordGuildTextGateway,
  SlashResponseChannelAdapter,
  deferChatInputReply,
  resolveGuildDisplayNames,
  resolveManagedInteractionContext,
  resolveMemberIdentity,
} from "./shared.js";

export interface AttackCommandHandlersOptions {
  attackService: Pick<AttackService, "declare" | "finish" | "defeatBoss" | "undo">;
  progressMessageService: Pick<ProgressMessageService, "resend">;
}

interface AttackCommandContext {
  categoryId: string;
  commandChannelId: string;
  responseChannel: SlashResponseChannelAdapter;
  discordGateway: DiscordGuildTextGateway;
  displayNamesByUserId: ReadonlyMap<string, string>;
}

export function createSlashCarryOverSelector(
  interaction: ChatInputCommandInteraction,
) {
  return createChannelCarryOverSelector(interaction.channel, interaction.user.id, interaction.id);
}

async function createAttackCommandContext(
  interaction: ChatInputCommandInteraction,
): Promise<AttackCommandContext> {
  if (!interaction.guild) {
    throw new Error("Guild interaction is required.");
  }

  const managedContext = await resolveManagedInteractionContext(interaction);
  return {
    categoryId: managedContext.categoryId ?? interaction.channelId,
    commandChannelId: managedContext.commandChannelId,
    responseChannel: new SlashResponseChannelAdapter(interaction, false),
    discordGateway: new DiscordGuildTextGateway(interaction.guild),
    displayNamesByUserId: await resolveGuildDisplayNames(interaction.guild),
  };
}

async function resolveTargetMember(
  interaction: ChatInputCommandInteraction,
) {
  if (!interaction.guild) {
    throw new Error("Guild interaction is required.");
  }

  return resolveMemberIdentity(interaction.guild, interaction.options.getUser("member", true));
}

export async function handleAttackDeclareCommand(
  interaction: ChatInputCommandInteraction,
  options: AttackCommandHandlersOptions,
): Promise<void> {
  await deferChatInputReply(interaction, false);

  const context = await createAttackCommandContext(interaction);
  const member = await resolveTargetMember(interaction);
  const lap = interaction.options.getInteger("lap");
  const bossNumber = interaction.options.getInteger("boss_number");

  await options.attackService.declare({
    ...context,
    channelId: context.commandChannelId,
    member,
    attackType: interaction.options.getString("attack_type", true),
    ...(lap !== null ? { lap } : {}),
    ...(bossNumber !== null ? { bossNumber } : {}),
  });
}

export async function handleAttackFinishCommand(
  interaction: ChatInputCommandInteraction,
  options: AttackCommandHandlersOptions,
): Promise<void> {
  await deferChatInputReply(interaction, false);

  const context = await createAttackCommandContext(interaction);
  const member = await resolveTargetMember(interaction);
  const lap = interaction.options.getInteger("lap");
  const bossNumber = interaction.options.getInteger("boss_number");
  const damage = interaction.options.getInteger("damage");

  await options.attackService.finish({
    ...context,
    channelId: context.commandChannelId,
    member,
    selectCarryOver: createSlashCarryOverSelector(interaction),
    ...(lap !== null ? { lap } : {}),
    ...(bossNumber !== null ? { bossNumber } : {}),
    ...(damage !== null ? { damage } : {}),
  });
}

export async function handleDefeatBossCommand(
  interaction: ChatInputCommandInteraction,
  options: AttackCommandHandlersOptions,
): Promise<void> {
  await deferChatInputReply(interaction, false);

  const context = await createAttackCommandContext(interaction);
  const member = await resolveTargetMember(interaction);
  const lap = interaction.options.getInteger("lap");
  const bossNumber = interaction.options.getInteger("boss_number");

  await options.attackService.defeatBoss({
    ...context,
    channelId: context.commandChannelId,
    member,
    selectCarryOver: createSlashCarryOverSelector(interaction),
    ...(lap !== null ? { lap } : {}),
    ...(bossNumber !== null ? { bossNumber } : {}),
  });
}

export async function handleUndoCommand(
  interaction: ChatInputCommandInteraction,
  options: AttackCommandHandlersOptions,
): Promise<void> {
  await deferChatInputReply(interaction, false);

  const context = await createAttackCommandContext(interaction);
  const member = await resolveTargetMember(interaction);

  await options.attackService.undo({
    ...context,
    member,
  });
}

export async function handleResendProgressMessageCommand(
  interaction: ChatInputCommandInteraction,
  options: AttackCommandHandlersOptions,
): Promise<void> {
  await deferChatInputReply(interaction, false);

  const context = await createAttackCommandContext(interaction);
  const lap = interaction.options.getInteger("lap");
  const bossNumber = interaction.options.getInteger("boss_number");

  await options.progressMessageService.resend({
    ...context,
    channelId: context.commandChannelId,
    ...(lap !== null ? { lap } : {}),
    ...(bossNumber !== null ? { bossNumber } : {}),
  });
}

export function registerAttackCommandHandlers(
  router: InteractionRouter,
  options: AttackCommandHandlersOptions,
): void {
  router.registerButtonHandler(/^carryover-select:/u, async () => {
    // Handled by awaitMessageComponent collectors; suppress router warnings.
  });
  router.registerChatInputCommand("attack_declare", async (interaction) => {
    await handleAttackDeclareCommand(interaction, options);
  });
  router.registerChatInputCommand("attack_fin", async (interaction) => {
    await handleAttackFinishCommand(interaction, options);
  });
  router.registerChatInputCommand("defeat_boss", async (interaction) => {
    await handleDefeatBossCommand(interaction, options);
  });
  router.registerChatInputCommand("undo", async (interaction) => {
    await handleUndoCommand(interaction, options);
  });
  router.registerChatInputCommand("resend", async (interaction) => {
    await handleResendProgressMessageCommand(interaction, options);
  });
  router.registerChatInputCommand("resend_progress_message", async (interaction) => {
    await handleResendProgressMessageCommand(interaction, options);
  });
}
