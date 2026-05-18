import { describe, expect, it } from "vitest";

import { parseEnv } from "../../../src/config/env.js";

describe("parseEnv", () => {
  it("parses defaults and required values", () => {
    const env = parseEnv({
      DISCORD_TOKEN: "token",
    });

    expect(env.DB_PATH).toBe("clanbattle.sqlite3");
    expect(env.GUILD_IDS).toEqual([]);
    expect(env.LOG_DIR).toBe("logs");
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.DEBUG).toBe(false);
    expect(env.NODE_ENV).toBe("development");
  });

  it("parses guild ids and boolean flags", () => {
    const env = parseEnv({
      DISCORD_TOKEN: "token",
      GUILD_IDS: "123, 456",
      DEBUG: "true",
      LOG_LEVEL: "debug",
      NODE_ENV: "test",
    });

    expect(env.GUILD_IDS).toEqual(["123", "456"]);
    expect(env.DEBUG).toBe(true);
    expect(env.LOG_LEVEL).toBe("debug");
    expect(env.NODE_ENV).toBe("test");
  });

  it("rejects invalid guild ids", () => {
    expect(() =>
      parseEnv({
        DISCORD_TOKEN: "token",
        GUILD_IDS: "123,abc",
      }),
    ).toThrow(/invalid guild id/i);
  });
});
