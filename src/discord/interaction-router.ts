import type {
  BaseInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
} from "discord.js";
import { MessageFlags } from "discord.js";

import { USER_MESSAGES } from "../constants/messages.js";
import type { Logger } from "../shared/logger.js";

type ButtonHandler = (interaction: ButtonInteraction) => Promise<void> | void;
type ChatInputHandler = (interaction: ChatInputCommandInteraction) => Promise<void> | void;
type ModalHandler = (interaction: ModalSubmitInteraction) => Promise<void> | void;
type CustomIdMatcher = RegExp | string | ((customId: string) => boolean);

interface CustomIdRoute<TInteraction> {
  matcher: CustomIdMatcher;
  handler: (interaction: TInteraction) => Promise<void> | void;
}

export interface InteractionRouterOptions {
  logger: Logger;
  commandExecutionFailedMessage?: string;
}

function matchesCustomId(matcher: CustomIdMatcher, customId: string): boolean {
  if (typeof matcher === "string") {
    return matcher === customId;
  }

  if (matcher instanceof RegExp) {
    return matcher.test(customId);
  }

  return matcher(customId);
}

async function replyWithGenericError(
  interaction: BaseInteraction,
  message: string,
): Promise<void> {
  if (!interaction.isRepliable()) {
    return;
  }

  if (interaction.isChatInputCommand() && interaction.deferred && !interaction.replied) {
    await interaction.editReply({
      content: message,
    });
    return;
  }

  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({
      content: message,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: message,
    flags: MessageFlags.Ephemeral,
  });
}

export class InteractionRouter {
  private readonly chatInputHandlers = new Map<string, ChatInputHandler>();
  private readonly buttonHandlers: CustomIdRoute<ButtonInteraction>[] = [];
  private readonly modalHandlers: CustomIdRoute<ModalSubmitInteraction>[] = [];

  constructor(private readonly options: InteractionRouterOptions) {}

  registerChatInputCommand(name: string, handler: ChatInputHandler): this {
    this.chatInputHandlers.set(name, handler);
    return this;
  }

  registerButtonHandler(matcher: CustomIdMatcher, handler: ButtonHandler): this {
    this.buttonHandlers.push({ matcher, handler });
    return this;
  }

  registerModalHandler(matcher: CustomIdMatcher, handler: ModalHandler): this {
    this.modalHandlers.push({ matcher, handler });
    return this;
  }

  async handle(interaction: BaseInteraction): Promise<void> {
    try {
      if (interaction.isChatInputCommand()) {
        await this.handleChatInput(interaction);
        return;
      }

      if (interaction.isButton()) {
        await this.handleButton(interaction);
        return;
      }

      if (interaction.isModalSubmit()) {
        await this.handleModal(interaction);
      }
    } catch (error) {
      this.options.logger.error("Interaction handler failed.", {
        error,
        commandName: interaction.isChatInputCommand() ? interaction.commandName : undefined,
        customId:
          interaction.isButton() || interaction.isModalSubmit() ? interaction.customId : undefined,
        userId: interaction.user.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
      });
      try {
        await replyWithGenericError(
          interaction,
          this.options.commandExecutionFailedMessage ?? USER_MESSAGES.errors.commandExecutionFailed,
        );
      } catch (replyError) {
        this.options.logger.warn("Failed to send generic interaction error response.", {
          error: replyError,
          commandName: interaction.isChatInputCommand() ? interaction.commandName : undefined,
          customId:
            interaction.isButton() || interaction.isModalSubmit() ? interaction.customId : undefined,
          userId: interaction.user.id,
          guildId: interaction.guildId,
          channelId: interaction.channelId,
        });
      }
    }
  }

  private async handleChatInput(interaction: ChatInputCommandInteraction): Promise<void> {
    const handler = this.chatInputHandlers.get(interaction.commandName);
    if (!handler) {
      this.options.logger.warn("No chat input handler registered.", {
        commandName: interaction.commandName,
      });
      return;
    }

    await handler(interaction);
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    const route = this.buttonHandlers.find((candidate) =>
      matchesCustomId(candidate.matcher, interaction.customId),
    );
    if (!route) {
      this.options.logger.warn("No button handler registered.", {
        customId: interaction.customId,
      });
      return;
    }

    await route.handler(interaction);
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const route = this.modalHandlers.find((candidate) =>
      matchesCustomId(candidate.matcher, interaction.customId),
    );
    if (!route) {
      this.options.logger.warn("No modal handler registered.", {
        customId: interaction.customId,
      });
      return;
    }

    await route.handler(interaction);
  }
}
