export type SqliteInteger = number | bigint;

function assertSnowflakeString(value: string): void {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`invalid snowflake: ${value}`);
  }
}

function assertFiniteInteger(value: number): void {
  if (!Number.isInteger(value) || !Number.isFinite(value)) {
    throw new Error(`invalid sqlite integer: ${value}`);
  }
}

export function encodeSnowflake(value: string): bigint {
  assertSnowflakeString(value);
  return BigInt(value);
}

export function encodeOptionalSnowflake(value: string | null | undefined): bigint | null {
  if (value == null) {
    return null;
  }

  return encodeSnowflake(value);
}

export function decodeSnowflake(value: string | SqliteInteger): string {
  if (typeof value === "string") {
    assertSnowflakeString(value);
    return value;
  }

  if (typeof value === "number") {
    assertFiniteInteger(value);
    return String(value);
  }

  return value.toString();
}

export function decodeOptionalSnowflake(
  value: string | SqliteInteger | null | undefined,
): string | null {
  if (value == null) {
    return null;
  }

  return decodeSnowflake(value);
}

export function decodeSqliteInteger(value: SqliteInteger): number {
  if (typeof value === "number") {
    assertFiniteInteger(value);
    return value;
  }

  const decoded = Number(value);

  if (!Number.isSafeInteger(decoded)) {
    throw new Error(`sqlite integer exceeds safe range: ${value.toString()}`);
  }

  return decoded;
}

export function decodeOptionalSqliteInteger(
  value: SqliteInteger | null | undefined,
): number | null {
  if (value == null) {
    return null;
  }

  return decodeSqliteInteger(value);
}

export function encodeSqliteBoolean(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

export function decodeSqliteBoolean(value: boolean | SqliteInteger): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  return decodeSqliteInteger(value) !== 0;
}
