import { describe, expect, it } from "vitest";

import {
  decodeOptionalSnowflake,
  decodeOptionalSqliteInteger,
  decodeSnowflake,
  decodeSqliteBoolean,
  decodeSqliteInteger,
  encodeOptionalSnowflake,
  encodeSnowflake,
  encodeSqliteBoolean,
} from "../../../../src/repositories/sqlite/sqlite-codec.js";

describe("sqlite-codec", () => {
  it("round-trips snowflake ids without precision loss", () => {
    const snowflake = "1234567890123456789";

    expect(encodeSnowflake(snowflake)).toBe(1234567890123456789n);
    expect(decodeSnowflake(1234567890123456789n)).toBe(snowflake);
    expect(decodeOptionalSnowflake(encodeOptionalSnowflake(snowflake))).toBe(snowflake);
  });

  it("converts sqlite integers into JS numbers when safe", () => {
    expect(decodeSqliteInteger(42n)).toBe(42);
    expect(decodeOptionalSqliteInteger(null)).toBeNull();
    expect(() => decodeSqliteInteger(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(
      "sqlite integer exceeds safe range",
    );
  });

  it("encodes and decodes sqlite booleans", () => {
    expect(encodeSqliteBoolean(true)).toBe(1);
    expect(encodeSqliteBoolean(false)).toBe(0);
    expect(decodeSqliteBoolean(1n)).toBe(true);
    expect(decodeSqliteBoolean(0)).toBe(false);
  });
});
