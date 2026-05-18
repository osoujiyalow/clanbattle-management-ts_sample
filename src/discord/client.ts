import {
  Client,
  ChannelType,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  Partials,
  type Client as DiscordJsClient,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from "discord.js";

import type { RuntimeConfig } from "../config/runtime.js";
import type { ClanData } from "../domain/clan-data.js";
import type {
  OrphanedCategoryScanClassification,
  OrphanedCategoryScanClassifier,
} from "../services/runtime-state-service.js";
import type { Logger } from "../shared/logger.js";
import type { InteractionRouter } from "./interaction-router.js";
import {
  DiscordCommandRegistrationApi,
  type CommandRegistrationApi,
  registerApplicationCommands,
} from "./register-commands.js";

export const REQUIRED_GATEWAY_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.MessageContent,
] as const;

export const REQUIRED_PARTIALS = [
  Partials.Channel,
  Partials.Message,
  Partials.Reaction,
] as const;

type ReadyClient = DiscordJsClient<true>;
type ReadyHook = (client: ReadyClient) => Promise<void> | void;
type MessageCreateHook = (message: Message) => Promise<void> | void;
type ReactionHook = (
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
) => Promise<void> | void;

export interface CreateDiscordClientOptions {
  logger: Logger;
  router: InteractionRouter;
  onReady?: ReadyHook;
  onMessageCreate?: MessageCreateHook;
  onReactionAdd?: ReactionHook;
  onReactionRemove?: ReactionHook;
}

export interface DiscordBootstrapOptions {
  runtimeConfig: RuntimeConfig;
  logger: Logger;
  router: InteractionRouter;
  onReady?: ReadyHook;
  onMessageCreate?: MessageCreateHook;
  onReactionAdd?: ReactionHook;
  onReactionRemove?: ReactionHook;
}

export function createDiscordReadyHook(options: {
  runtimeConfig: RuntimeConfig;
  logger: Logger;
  apiFactory?: (client: ReadyClient) => CommandRegistrationApi;
  onReady?: ReadyHook;
}): ReadyHook {
  return async (client) => {
    options.logger.info("Login was successful.");
    options.logger.info(`bot name: ${client.user.username}`);
    options.logger.info(`bot id: ${client.user.id}`);

    await registerApplicationCommands({
      commandRegistration: options.runtimeConfig.commandRegistration,
      logger: options.logger,
      api: options.apiFactory?.(client) ?? new DiscordCommandRegistrationApi(client),
    });

    await options.onReady?.(client);
  };
}

function isUnknownChannelError(error: unknown): error is DiscordAPIError {
  return error instanceof DiscordAPIError && error.code === 10_003;
}

export function createDiscordOrphanedCategoryScanClassifier(
  client: ReadyClient,
): OrphanedCategoryScanClassifier {
  return {
    async classify(clanData: ClanData): Promise<OrphanedCategoryScanClassification> {
      let guild;
      try {
        guild = await client.guilds.fetch(clanData.guildId);
      } catch (error) {
        return {
          status: "scan-deferred",
          reason: "guild-fetch-failed",
          details: { error },
        };
      }

      try {
        const category = await guild.channels.fetch(clanData.categoryId);
        if (!category) {
          return {
            status: "orphaned",
            reason: "category-not-found",
          };
        }

        if (category.type !== ChannelType.GuildCategory) {
          return {
            status: "orphaned",
            reason: "category-id-not-category",
            details: {
              resolvedChannelType: category.type,
            },
          };
        }

        return {
          status: "active",
          reason: "category-resolved",
        };
      } catch (error) {
        if (isUnknownChannelError(error)) {
          return {
            status: "orphaned",
            reason: "category-not-found",
            details: { errorCode: error.code },
          };
        }

        return {
          status: "scan-deferred",
          reason: "category-fetch-failed",
          details: { error },
        };
      }
    },
  };
}

export function createDiscordClient(options: CreateDiscordClientOptions): DiscordJsClient {
  const client = new Client({
    intents: REQUIRED_GATEWAY_INTENTS,
    partials: REQUIRED_PARTIALS,
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    await options.router.handle(interaction);
  });

  client.on(Events.MessageCreate, async (message) => {
    if (!options.onMessageCreate) {
      return;
    }

    try {
      await options.onMessageCreate(message);
    } catch (error) {
      options.logger.error("Failed during messageCreate handler.", {
        error,
        guildId: message.guildId,
        channelId: message.channelId,
        authorId: message.author.id,
      });
    }
  });

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    if (!options.onReactionAdd) {
      return;
    }

    try {
      await options.onReactionAdd(reaction, user);
    } catch (error) {
      options.logger.error("Failed during messageReactionAdd handler.", {
        error,
        channelId: reaction.message.channelId,
        messageId: reaction.message.id,
        userId: user.id,
      });
    }
  });

  client.on(Events.MessageReactionRemove, async (reaction, user) => {
    if (!options.onReactionRemove) {
      return;
    }

    try {
      await options.onReactionRemove(reaction, user);
    } catch (error) {
      options.logger.error("Failed during messageReactionRemove handler.", {
        error,
        channelId: reaction.message.channelId,
        messageId: reaction.message.id,
        userId: user.id,
      });
    }
  });

  client.once(Events.ClientReady, async (readyClient) => {
    if (!options.onReady) {
      return;
    }

    try {
      await options.onReady(readyClient);
    } catch (error) {
      options.logger.error("Failed during Discord ready hook.", {
        error,
      });
    }
  });

  return client;
}

export async function bootstrapDiscordRuntime(
  options: DiscordBootstrapOptions,
): Promise<DiscordJsClient> {
  const client = createDiscordClient({
    logger: options.logger,
    router: options.router,
    ...(options.onMessageCreate ? { onMessageCreate: options.onMessageCreate } : {}),
    ...(options.onReactionAdd ? { onReactionAdd: options.onReactionAdd } : {}),
    ...(options.onReactionRemove ? { onReactionRemove: options.onReactionRemove } : {}),
    onReady: createDiscordReadyHook({
      runtimeConfig: options.runtimeConfig,
      logger: options.logger,
      ...(options.onReady ? { onReady: options.onReady } : {}),
    }),
  });

  await client.login(options.runtimeConfig.env.DISCORD_TOKEN);
  return client;
}
