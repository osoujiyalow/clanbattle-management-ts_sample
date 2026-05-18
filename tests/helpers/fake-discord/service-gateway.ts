export interface FakeEmbedLike {
  toJSON(): unknown;
}

export interface FakeSendPayload {
  content?: string;
  embeds?: readonly FakeEmbedLike[];
  components?: readonly { toJSON(): unknown }[];
}

export interface RecordedPayload {
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
}

export class FakeResponseChannel {
  readonly sentPayloads: RecordedPayload[] = [];

  async send(payload: { content?: string }): Promise<void> {
    this.sentPayloads.push({ content: payload.content });
  }
}

export class FakeServiceMessage {
  readonly reactions: string[] = [];
  readonly edits: RecordedPayload[] = [];
  deleted = false;

  constructor(
    readonly id: string,
    readonly payload: RecordedPayload = {},
  ) {}

  async edit(payload: FakeSendPayload): Promise<void> {
    this.edits.push({
      content: payload.content,
      embeds: payload.embeds?.map((embed) => embed.toJSON()),
      components: payload.components?.map((component) => component.toJSON()),
    });
  }

  async delete(): Promise<void> {
    this.deleted = true;
  }

  async addReaction(emoji: string): Promise<void> {
    this.reactions.push(emoji);
  }
}

export class FakeServiceTextChannel {
  readonly sentPayloads: RecordedPayload[] = [];
  readonly sentMessages: FakeServiceMessage[] = [];
  readonly messages = new Map<string, FakeServiceMessage>();

  constructor(
    readonly id: string,
    private readonly idFactory: () => string = createSnowflakeFactory(),
  ) {}

  async send(payload: FakeSendPayload): Promise<FakeServiceMessage> {
    return this.sendMessage(payload);
  }

  async sendMessage(payload: FakeSendPayload): Promise<FakeServiceMessage> {
    const message = new FakeServiceMessage(this.idFactory(), {
      content: payload.content,
      embeds: payload.embeds?.map((embed) => embed.toJSON()),
      components: payload.components?.map((component) => component.toJSON()),
    });

    this.sentPayloads.push(message.payload);
    this.sentMessages.push(message);
    this.messages.set(message.id, message);

    return message;
  }

  async fetchMessage(messageId: string): Promise<FakeServiceMessage> {
    const message = this.messages.get(messageId);
    if (!message) {
      throw new Error(`Unknown message id: ${messageId}`);
    }

    return message;
  }

  attachMessage(message: FakeServiceMessage): void {
    this.messages.set(message.id, message);
  }
}

export class FakeDiscordGateway {
  private readonly channels = new Map<string, FakeServiceTextChannel>();

  registerChannel(channel: FakeServiceTextChannel): void {
    this.channels.set(channel.id, channel);
  }

  async getTextChannel(channelId: string): Promise<FakeServiceTextChannel> {
    const channel = this.channels.get(channelId);
    if (!channel) {
      throw new Error(`Unknown channel id: ${channelId}`);
    }

    return channel;
  }
}

export function createSnowflakeFactory(
  start = 1000000000000000000n,
): () => string {
  let current = start;

  return () => {
    const value = current.toString();
    current += 1n;
    return value;
  };
}
