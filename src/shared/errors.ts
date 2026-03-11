export class UserFacingError extends Error {
  readonly kind = "user-facing";

  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "UserFacingError";
  }
}

export class InternalError extends Error {
  readonly kind = "internal";
  readonly details: Record<string, unknown> | undefined;

  constructor(
    public readonly code: string,
    message: string,
    options?: {
      cause?: unknown;
      details?: Record<string, unknown>;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = "InternalError";
    this.details = options?.details;
  }
}

export function isUserFacingError(error: unknown): error is UserFacingError {
  return error instanceof UserFacingError;
}

export function getUserFacingMessage(error: unknown, fallbackMessage: string): string {
  if (isUserFacingError(error)) {
    return error.message;
  }

  return fallbackMessage;
}
