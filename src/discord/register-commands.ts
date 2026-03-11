import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  PermissionFlagsBits,
  type Client,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";

import type { RuntimeConfig } from "../config/runtime.js";
import { COMMAND_DESCRIPTIONS, OPTION_DESCRIPTIONS } from "../constants/messages.js";
import { AttackType } from "../domain/attack-type.js";
import type { Logger } from "../shared/logger.js";

export type SlashCommandPayload = RESTPostAPIChatInputApplicationCommandsJSONBody;

export interface CommandRegistrationApi {
  setGlobalCommands(commands: readonly SlashCommandPayload[]): Promise<void>;
  setGuildCommands(guildId: string, commands: readonly SlashCommandPayload[]): Promise<void>;
}

export interface RegisterApplicationCommandsOptions {
  commandRegistration: RuntimeConfig["commandRegistration"];
  logger: Logger;
  api: CommandRegistrationApi;
  commands?: readonly SlashCommandPayload[];
}

const GENERIC_OPTION_DESCRIPTION = "…";
const ATTACK_TYPE_CHOICES: Array<{ name: string; value: string }> = [
  { name: "物理", value: AttackType.PHYSICS },
  { name: "魔法", value: AttackType.MAGIC },
  { name: "持ち越し", value: AttackType.CARRYOVER },
];

export const SLASH_COMMAND_PAYLOADS = [
  {
    type: ApplicationCommandType.ChatInput,
    name: "add",
    description: COMMAND_DESCRIPTIONS.add,
    options: [
      {
        type: ApplicationCommandOptionType.Role,
        name: "role",
        description: GENERIC_OPTION_DESCRIPTION,
        required: false,
      },
      {
        type: ApplicationCommandOptionType.User,
        name: "member",
        description: GENERIC_OPTION_DESCRIPTION,
        required: false,
      },
    ],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: "remove",
    description: COMMAND_DESCRIPTIONS.remove,
    options: [
      {
        type: ApplicationCommandOptionType.User,
        name: "member",
        description: GENERIC_OPTION_DESCRIPTION,
        required: false,
      },
      {
        type: ApplicationCommandOptionType.Boolean,
        name: "all",
        description: GENERIC_OPTION_DESCRIPTION,
        required: false,
      },
    ],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: "setup",
    description: COMMAND_DESCRIPTIONS.setup,
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: "category_channel_name",
        description: GENERIC_OPTION_DESCRIPTION,
        required: false,
      },
    ],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: "bossinfo_show",
    description: COMMAND_DESCRIPTIONS.bossinfoShow,
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: "bossinfo_export_json",
    description: COMMAND_DESCRIPTIONS.bossinfoExportJson,
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: "bossinfo_edit",
    description: COMMAND_DESCRIPTIONS.bossinfoEdit,
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: "lap",
    description: COMMAND_DESCRIPTIONS.lap,
    options: [
      {
        type: ApplicationCommandOptionType.Integer,
        name: "lap",
        description: GENERIC_OPTION_DESCRIPTION,
        required: true,
      },
      {
        type: ApplicationCommandOptionType.Integer,
        name: "boss_number",
        description: GENERIC_OPTION_DESCRIPTION,
        required: false,
      },
    ],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: "attack_declare",
    description: COMMAND_DESCRIPTIONS.attackDeclare,
    options: [
      {
        type: ApplicationCommandOptionType.User,
        name: "member",
        description: GENERIC_OPTION_DESCRIPTION,
        required: true,
      },
      {
        type: ApplicationCommandOptionType.String,
        name: "attack_type",
        description: GENERIC_OPTION_DESCRIPTION,
        required: true,
        choices: ATTACK_TYPE_CHOICES,
      },
      {
        type: ApplicationCommandOptionType.Integer,
        name: "lap",
        description: GENERIC_OPTION_DESCRIPTION,
        required: false,
      },
      {
        type: ApplicationCommandOptionType.Integer,
        name: "boss_number",
        description: GENERIC_OPTION_DESCRIPTION,
        required: false,
      },
    ],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: "attack_fin",
    description: COMMAND_DESCRIPTIONS.attackFin,
    options: [
      {
        type: ApplicationCommandOptionType.User,
        name: "member",
        description: GENERIC_OPTION_DESCRIPTION,
        required: true,
      },
      {
        type: ApplicationCommandOptionType.Integer,
        name: "lap",
        description: GENERIC_OPTION_DESCRIPTION,
        required: false,
      },
      {
        type: ApplicationCommandOptionType.Integer,
        name: "boss_number",
        description: GENERIC_OPTION_DESCRIPTION,
        required: false,
      },
      {
        type: ApplicationCommandOptionType.Integer,
        name: "damage",
        description: GENERIC_OPTION_DESCRIPTION,
        required: false,
      },
    ],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: "defeat_boss",
    description: COMMAND_DESCRIPTIONS.defeatBoss,
    options: [
      {
        type: ApplicationCommandOptionType.User,
        name: "member",
        description: GENERIC_OPTION_DESCRIPTION,
        required: true,
      },
      {
        type: ApplicationCommandOptionType.Integer,
        name: "lap",
        description: GENERIC_OPTION_DESCRIPTION,
        required: false,
      },
      {
        type: ApplicationCommandOptionType.Integer,
        name: "boss_number",
        description: GENERIC_OPTION_DESCRIPTION,
        required: false,
      },
    ],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: "undo",
    description: COMMAND_DESCRIPTIONS.undo,
    options: [
      {
        type: ApplicationCommandOptionType.User,
        name: "member",
        description: GENERIC_OPTION_DESCRIPTION,
        required: true,
      },
    ],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: "resend",
    description: COMMAND_DESCRIPTIONS.resendProgressMessage,
    options: [
      {
        type: ApplicationCommandOptionType.Integer,
        name: "lap",
        description: GENERIC_OPTION_DESCRIPTION,
        required: false,
      },
      {
        type: ApplicationCommandOptionType.Integer,
        name: "boss_number",
        description: GENERIC_OPTION_DESCRIPTION,
        required: false,
      },
    ],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: "calc_cot",
    description: COMMAND_DESCRIPTIONS.calcCot,
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: "values",
        description: OPTION_DESCRIPTIONS.calcCot.values,
        required: true,
      },
    ],
  },
] as const satisfies readonly SlashCommandPayload[];

export class DiscordCommandRegistrationApi implements CommandRegistrationApi {
  constructor(private readonly client: Client<true>) {}

  async setGlobalCommands(commands: readonly SlashCommandPayload[]): Promise<void> {
    await this.client.application.commands.set(commands);
  }

  async setGuildCommands(guildId: string, commands: readonly SlashCommandPayload[]): Promise<void> {
    const guild = await this.client.guilds.fetch(guildId);
    await guild.commands.set(commands);
  }
}

export async function registerApplicationCommands(
  options: RegisterApplicationCommandsOptions,
): Promise<void> {
  const commands = options.commands ?? SLASH_COMMAND_PAYLOADS;

  if (options.commandRegistration.mode === "guild") {
    for (const guildId of options.commandRegistration.guildIds) {
      options.logger.info("Registering guild commands.", {
        guildId,
        commandCount: commands.length,
      });
      await options.api.setGuildCommands(guildId, commands);
    }
    return;
  }

  options.logger.info("Registering global commands.", {
    commandCount: commands.length,
  });
  await options.api.setGlobalCommands(commands);
}
