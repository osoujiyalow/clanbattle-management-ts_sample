import {
  type ActionRowBuilder,
  type APIEmbed,
  ChannelType,
  DiscordAPIError,
  MessageFlags,
  type MessageActionRowComponentBuilder,
  type JSONEncodable,
  type APIRole,
  type CategoryChannel,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type InteractionReplyOptions,
  type InteractionDeferReplyOptions,
  type InteractionEditReplyOptions,
  type Message,
  type Role,
  type TextBasedChannel,
  type User,
} from "discord.js";

import { SetupHttpError, SetupPermissionError } from "../../services/clan-setup-service.js";

type ReplyPayload = Pick<InteractionReplyOptions, "content" | "flags">;
type EditReplyPayload = Pick<InteractionEditReplyOptions, "content">;

interface UserDisplayNameSource {
  id: string;
  globalName?: string | null;
}

interface GuildMemberDisplayNameSource {
  id: string;
  nickname?: string | null;
  displayName?: string | null;
  user?: UserDisplayNameSource | null;
}

export interface DiscordMemberIdentity {
  id: string;
  displayName: string;
}

interface SendableInteraction {
  deferred: boolean;
  replied: boolean;
  deferReply(payload?: InteractionDeferReplyOptions): Promise<unknown>;
  reply(payload: ReplyPayload): Promise<unknown>;
  editReply(payload: EditReplyPayload): Promise<unknown>;
  followUp(payload: ReplyPayload): Promise<unknown>;
  deleteReply?(): Promise<unknown>;
}

interface DeleteableResponse {
  delete(): Promise<unknown>;
}

function formatInteractionResponsePayload(payload: { content?: string }, ephemeral: boolean): ReplyPayload {
  return {
    content: payload.content ?? "",
    ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
  };
}

function formatInteractionEditPayload(payload: { content?: string }): EditReplyPayload {
  return {
    content: payload.content ?? null,
  };
}

function scheduleTransientInteractionDeletion(
  interaction: SendableInteraction,
  response: unknown,
  deleteAfterMs: number,
): void {
  const isDeleteableResponse = (value: unknown): value is DeleteableResponse =>
    typeof value === "object" &&
    value !== null &&
    "delete" in value &&
    typeof value.delete === "function";

  const deleteableResponse =
    isDeleteableResponse(response)
      ? response
      : null;

  if (deleteableResponse) {
    setTimeout(() => {
      void deleteableResponse.delete().catch(() => {});
    }, deleteAfterMs);
    return;
  }

  if (typeof interaction.deleteReply === "function") {
    setTimeout(() => {
      void interaction.deleteReply?.().catch(() => {});
    }, deleteAfterMs);
  }
}

export async function deferChatInputReply(
  interaction: ChatInputCommandInteraction,
  ephemeral: boolean,
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    return;
  }

  await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
}

function isGuildMember(value: unknown): value is GuildMember {
  return typeof value === "object" && value !== null && "displayName" in value;
}

function isDiscordTextBasedChannel(
  channel: GuildBasedChannel | null,
): channel is TextBasedChannel & GuildBasedChannel {
  return channel !== null && channel.isTextBased();
}

export function resolvePreferredUserDisplayName(user: UserDisplayNameSource): string {
  return user.globalName ?? user.id;
}

export function resolvePreferredGuildMemberDisplayName(
  member: GuildMemberDisplayNameSource,
): string {
  return member.nickname ?? member.user?.globalName ?? member.displayName ?? member.id;
}

export function getDisplayNameFromInteraction(interaction: ChatInputCommandInteraction): string {
  if (isGuildMember(interaction.member)) {
    return resolvePreferredGuildMemberDisplayName(interaction.member);
  }

  return resolvePreferredUserDisplayName(interaction.user);
}

export function getInteractionChannelName(interaction: ChatInputCommandInteraction): string {
  return interaction.channel?.isTextBased() && "name" in interaction.channel
    ? interaction.channel.name ?? interaction.channelId
    : interaction.channelId;
}

export async function resolveMemberIdentity(
  guild: Guild,
  user: User,
): Promise<DiscordMemberIdentity> {
  const cachedMember = guild.members.cache.get(user.id);
  if (cachedMember) {
    return {
      id: user.id,
      displayName: resolvePreferredGuildMemberDisplayName(cachedMember),
    };
  }

  const guildMember = await guild.members.fetch(user.id).catch(() => null);
  return {
    id: user.id,
    displayName: guildMember
      ? resolvePreferredGuildMemberDisplayName(guildMember)
      : resolvePreferredUserDisplayName(user),
  };
}

export async function resolveRoleMembers(
  guild: Guild,
  role: Role | APIRole,
): Promise<readonly DiscordMemberIdentity[]> {
  const guildMembers = await guild.members.fetch();
  return guildMembers
    .filter((member) => member.roles.cache.has(role.id))
    .map((member) => ({
      id: member.id,
      displayName: resolvePreferredGuildMemberDisplayName(member),
    }));
}

export async function resolveGuildDisplayNames(guild: Guild): Promise<ReadonlyMap<string, string>> {
  return resolveCachedGuildDisplayNames(guild);
}

export function resolveCachedGuildDisplayNames(guild: Guild): ReadonlyMap<string, string> {
  return new Map(
    Array.from(guild.members.cache.values()).map(
      (member) => [member.id, resolvePreferredGuildMemberDisplayName(member)] as const,
    ),
  );
}

export async function resolveGuildDisplayNamesForUserIds(
  guild: Guild,
  userIds: Iterable<string>,
): Promise<ReadonlyMap<string, string>> {
  const displayNamesByUserId = new Map<string, string>();
  const missingUserIds: string[] = [];

  for (const userId of new Set(userIds)) {
    const cachedMember = guild.members.cache.get(userId);
    if (cachedMember) {
      displayNamesByUserId.set(userId, resolvePreferredGuildMemberDisplayName(cachedMember));
      continue;
    }

    missingUserIds.push(userId);
  }

  if (missingUserIds.length === 0) {
    return displayNamesByUserId;
  }

  try {
    const fetchedMembers = await guild.members.fetch({ user: missingUserIds });
    for (const member of fetchedMembers.values()) {
      displayNamesByUserId.set(member.id, resolvePreferredGuildMemberDisplayName(member));
    }
    return displayNamesByUserId;
  } catch {
    for (const userId of missingUserIds) {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member) {
        displayNamesByUserId.set(userId, resolvePreferredGuildMemberDisplayName(member));
      }
    }

    return displayNamesByUserId;
  }
}

export interface ManagedInteractionContext {
  categoryId: string | null;
  commandChannelId: string;
}

function isThreadChannel(channel: GuildBasedChannel): boolean {
  return (
    channel.type === ChannelType.AnnouncementThread ||
    channel.type === ChannelType.PrivateThread ||
    channel.type === ChannelType.PublicThread
  );
}

function resolveCategoryIdFromChannel(
  channel: GuildBasedChannel,
  fallbackChannelId: string,
): string {
  return "parentId" in channel ? channel.parentId ?? fallbackChannelId : fallbackChannelId;
}

export async function resolveManagedInteractionContext(
  interaction: ChatInputCommandInteraction,
): Promise<ManagedInteractionContext> {
  const guild = interaction.guild;
  if (!guild) {
    return {
      categoryId: null,
      commandChannelId: interaction.channelId,
    };
  }

  const channel = await guild.channels.fetch(interaction.channelId);
  if (!channel) {
    return {
      categoryId: null,
      commandChannelId: interaction.channelId,
    };
  }

  if (isThreadChannel(channel)) {
    if (!channel.parentId) {
      return {
        categoryId: null,
        commandChannelId: interaction.channelId,
      };
    }

    const parentChannel = await guild.channels.fetch(channel.parentId);
    if (!parentChannel) {
      return {
        categoryId: null,
        commandChannelId: channel.parentId,
      };
    }

    return {
      categoryId: resolveCategoryIdFromChannel(parentChannel, parentChannel.id),
      commandChannelId: parentChannel.id,
    };
  }

  return {
    categoryId: resolveCategoryIdFromChannel(channel, interaction.channelId),
    commandChannelId: interaction.channelId,
  };
}

export async function resolveManagedCategoryId(
  interaction: ChatInputCommandInteraction,
): Promise<string | null> {
  const context = await resolveManagedInteractionContext(interaction);
  return context.categoryId;
}

function asSetupError(error: unknown): SetupPermissionError | SetupHttpError | unknown {
  if (!(error instanceof DiscordAPIError)) {
    return error;
  }

  if (error.code === 50013) {
    return new SetupPermissionError();
  }

  const responseText =
    typeof error.rawError === "string" ? error.rawError : JSON.stringify(error.rawError ?? error.message);
  return new SetupHttpError(responseText);
}

class DiscordMessageAdapter {
  constructor(private readonly message: Message) {}

  get id(): string {
    return this.message.id;
  }

  async addReaction(emoji: string): Promise<void> {
    await this.message.react(emoji);
  }

  async edit(payload: {
    embeds?: readonly (APIEmbed | JSONEncodable<APIEmbed>)[];
    components?: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[];
  }): Promise<void> {
    await this.message.edit({
      ...(payload.embeds ? { embeds: payload.embeds } : {}),
      ...(payload.components ? { components: payload.components } : {}),
    });
  }

  async delete(): Promise<void> {
    await this.message.delete();
  }
}

export class DiscordTextChannelAdapter {
  constructor(private readonly channel: TextBasedChannel & GuildBasedChannel) {}

  get id(): string {
    return this.channel.id;
  }

  get name(): string {
    return (this.channel as { name?: string }).name ?? this.channel.id;
  }

  async send(payload: {
    content?: string;
    embeds?: readonly (APIEmbed | JSONEncodable<APIEmbed>)[];
    components?: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[];
  }): Promise<DiscordMessageAdapter> {
    const message = await this.channel.send({
      ...(payload.content ? { content: payload.content } : {}),
      ...(payload.embeds ? { embeds: payload.embeds } : {}),
      ...(payload.components ? { components: payload.components } : {}),
    });
    return new DiscordMessageAdapter(message);
  }

  async sendMessage(payload: {
    content?: string;
    embeds?: readonly (APIEmbed | JSONEncodable<APIEmbed>)[];
    components?: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[];
  }): Promise<DiscordMessageAdapter> {
    return this.send(payload);
  }

  async fetchMessage(messageId: string): Promise<DiscordMessageAdapter> {
    const message = await this.channel.messages.fetch(messageId);
    return new DiscordMessageAdapter(message);
  }

  async delete(): Promise<void> {
    await this.channel.delete();
  }
}

class DiscordCategoryAdapter {
  constructor(
    private readonly guild: Guild,
    private readonly category: CategoryChannel,
  ) {}

  get id(): string {
    return this.category.id;
  }

  get name(): string {
    return this.category.name;
  }

  async createTextChannel(name: string): Promise<DiscordTextChannelAdapter> {
    try {
      const channel = await this.guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: this.category.id,
      });

      if (!isDiscordTextBasedChannel(channel)) {
        throw new Error("Created channel is not text based.");
      }

      return new DiscordTextChannelAdapter(channel);
    } catch (error) {
      throw asSetupError(error);
    }
  }

  async delete(): Promise<void> {
    try {
      await this.category.delete();
    } catch (error) {
      throw asSetupError(error);
    }
  }
}

export class DiscordGuildAdapter {
  constructor(private readonly guild: Guild) {}

  get id(): string {
    return this.guild.id;
  }

  get name(): string {
    return this.guild.name;
  }

  async createCategory(name: string): Promise<DiscordCategoryAdapter> {
    try {
      const category = await this.guild.channels.create({
        name,
        type: ChannelType.GuildCategory,
      });

      if (category.type !== ChannelType.GuildCategory) {
        throw new Error("Created channel is not a category.");
      }

      return new DiscordCategoryAdapter(this.guild, category);
    } catch (error) {
      throw asSetupError(error);
    }
  }
}

export class SlashSetupResponseChannelAdapter {
  constructor(
    private readonly interaction: SendableInteraction,
    private readonly ephemeral: boolean,
    public readonly id: string,
    public readonly name: string,
  ) {}

  async send(payload: { content?: string }): Promise<{ id: string; addReaction(emoji: string): Promise<void> }> {
    const normalizedPayload = formatInteractionResponsePayload(payload, this.ephemeral);
    const normalizedEditPayload = formatInteractionEditPayload(payload);

    if (!this.interaction.deferred && !this.interaction.replied) {
      await this.interaction.reply(normalizedPayload);
    } else if (this.interaction.deferred && !this.interaction.replied) {
      await this.interaction.editReply(normalizedEditPayload);
    } else {
      await this.interaction.followUp(normalizedPayload);
    }

    return {
      id: `interaction:${this.id}:${Date.now()}`,
      async addReaction() {},
    };
  }

  async delete(): Promise<void> {}
}

export class SlashResponseChannelAdapter {
  constructor(
    private readonly interaction: SendableInteraction,
    private readonly ephemeral: boolean,
  ) {}

  async send(payload: { content?: string }): Promise<void> {
    const normalizedPayload = formatInteractionResponsePayload(payload, this.ephemeral);
    const normalizedEditPayload = formatInteractionEditPayload(payload);

    if (!this.interaction.deferred && !this.interaction.replied) {
      await this.interaction.reply(normalizedPayload);
      return;
    }

    if (this.interaction.deferred && !this.interaction.replied) {
      await this.interaction.editReply(normalizedEditPayload);
      return;
    }

    await this.interaction.followUp(normalizedPayload);
  }

  async sendTransient(payload: { content?: string }, deleteAfterMs = 15_000): Promise<void> {
    const normalizedPayload = formatInteractionResponsePayload(payload, true);

    if (!this.interaction.deferred && !this.interaction.replied) {
      const response = await this.interaction.reply(normalizedPayload);
      scheduleTransientInteractionDeletion(this.interaction, response, deleteAfterMs);
      return;
    }

    const response = await this.interaction.followUp(normalizedPayload);
    scheduleTransientInteractionDeletion(this.interaction, response, deleteAfterMs);
  }
}

export class DiscordGuildTextGateway {
  constructor(private readonly guild: Guild) {}

  async getTextChannel(channelId: string): Promise<DiscordTextChannelAdapter> {
    const channel = await this.guild.channels.fetch(channelId);
    if (!isDiscordTextBasedChannel(channel)) {
      throw new Error(`Channel ${channelId} is not text based.`);
    }

    return new DiscordTextChannelAdapter(channel);
  }
}

export function collectDisplayNames(
  actor: DiscordMemberIdentity,
  members: readonly DiscordMemberIdentity[],
): ReadonlyMap<string, string> {
  const entries: Array<readonly [string, string]> = [[actor.id, actor.displayName]];

  for (const member of members) {
    entries.push([member.id, member.displayName]);
  }

  return new Map(entries);
}
