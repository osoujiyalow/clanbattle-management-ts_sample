export const DEFAULT_DISCORD_MESSAGE_RETRY_COUNT = 3;
export const DEFAULT_DISCORD_MESSAGE_RETRY_DELAY_MS = 10;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export function isDiscordMessageMissingError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error && error.code === 10008) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes("Unknown message id") || error.message.includes("Unknown Message");
}

export interface DiscordMessageFetchChannel<TMessage> {
  fetchMessage(messageId: string): Promise<TMessage>;
}

interface DiscordEditableMessage<TPayload> {
  edit(payload: TPayload): Promise<void>;
}

interface DiscordDeleteableMessage {
  delete?(): Promise<void>;
}

export interface DiscordMessageMutationResult {
  success: boolean;
  missing: boolean;
  error?: unknown;
}

export interface DiscordMessageDeleteResult extends DiscordMessageMutationResult {
  deleteUnsupported: boolean;
}

async function retryMutation(
  operation: () => Promise<void>,
  retryCount: number,
  retryDelayMs: number,
): Promise<DiscordMessageMutationResult> {
  let lastError: unknown;
  let missing = false;

  for (let attempt = 0; attempt < retryCount; attempt += 1) {
    try {
      await operation();
      return {
        success: true,
        missing: false,
      };
    } catch (error) {
      lastError = error;
      missing = isDiscordMessageMissingError(error);

      if (attempt < retryCount - 1) {
        await sleep(retryDelayMs);
      }
    }
  }

  return {
    success: false,
    missing,
    error: lastError,
  };
}

export async function retryEditDiscordMessage<
  TPayload,
  TMessage extends DiscordEditableMessage<TPayload>,
  TChannel extends DiscordMessageFetchChannel<TMessage>,
>(options: {
  channel: TChannel;
  messageId: string;
  payload: TPayload;
  retryCount?: number;
  retryDelayMs?: number;
}): Promise<DiscordMessageMutationResult> {
  return retryMutation(
    async () => {
      const message = await options.channel.fetchMessage(options.messageId);
      await message.edit(options.payload);
    },
    options.retryCount ?? DEFAULT_DISCORD_MESSAGE_RETRY_COUNT,
    options.retryDelayMs ?? DEFAULT_DISCORD_MESSAGE_RETRY_DELAY_MS,
  );
}

export async function retryDeleteDiscordMessage<
  TMessage extends DiscordDeleteableMessage,
  TChannel extends DiscordMessageFetchChannel<TMessage>,
>(options: {
  channel: TChannel;
  messageId: string;
  retryCount?: number;
  retryDelayMs?: number;
}): Promise<DiscordMessageDeleteResult> {
  let lastError: unknown;
  let missing = false;

  const retryCount = options.retryCount ?? DEFAULT_DISCORD_MESSAGE_RETRY_COUNT;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_DISCORD_MESSAGE_RETRY_DELAY_MS;

  for (let attempt = 0; attempt < retryCount; attempt += 1) {
    try {
      const message = await options.channel.fetchMessage(options.messageId);
      if (typeof message.delete !== "function") {
        return {
          success: false,
          missing: false,
          deleteUnsupported: true,
        };
      }

      await message.delete();
      return {
        success: true,
        missing: false,
        deleteUnsupported: false,
      };
    } catch (error) {
      lastError = error;
      missing = isDiscordMessageMissingError(error);

      if (attempt < retryCount - 1) {
        await sleep(retryDelayMs);
      }
    }
  }

  return {
    success: false,
    missing,
    error: lastError,
    deleteUnsupported: false,
  };
}
