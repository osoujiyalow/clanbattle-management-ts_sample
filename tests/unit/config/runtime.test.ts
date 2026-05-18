import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeConfig } from "../../../src/config/runtime.js";

describe("createRuntimeConfig", () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    while (createdDirs.length > 0) {
      const target = createdDirs.pop();
      if (!target) {
        continue;
      }

      rmSync(target, { recursive: true, force: true });
    }
  });

  it("loads .env from the provided root directory when using process.env", () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "cb-runtime-config-"));
    createdDirs.push(rootDir);

    writeFileSync(
      path.join(rootDir, ".env"),
      [
        "DISCORD_TOKEN=test-token",
        "DB_PATH=./staging.sqlite3",
        "GUILD_IDS=123456789012345678",
        "LOG_DIR=logs",
        "LOG_LEVEL=debug",
        "DEBUG=true",
        "NODE_ENV=development",
      ].join("\n"),
      "utf8",
    );

    const previousValues = {
      DISCORD_TOKEN: process.env.DISCORD_TOKEN,
      DB_PATH: process.env.DB_PATH,
      GUILD_IDS: process.env.GUILD_IDS,
      LOG_DIR: process.env.LOG_DIR,
      LOG_LEVEL: process.env.LOG_LEVEL,
      DEBUG: process.env.DEBUG,
      NODE_ENV: process.env.NODE_ENV,
    };

    delete process.env.DISCORD_TOKEN;
    delete process.env.DB_PATH;
    delete process.env.GUILD_IDS;
    delete process.env.LOG_DIR;
    delete process.env.LOG_LEVEL;
    delete process.env.DEBUG;
    delete process.env.NODE_ENV;

    try {
      const runtimeConfig = createRuntimeConfig(process.env, rootDir);

      expect(runtimeConfig.env.DISCORD_TOKEN).toBe("test-token");
      expect(runtimeConfig.commandRegistration.guildIds).toEqual(["123456789012345678"]);
      expect(runtimeConfig.commandRegistration.mode).toBe("guild");
      expect(runtimeConfig.paths.dbPath).toBe(path.resolve(rootDir, "staging.sqlite3"));
      expect(runtimeConfig.logging.level).toBe("debug");
      expect(runtimeConfig.debug).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(previousValues)) {
        if (value === undefined) {
          delete process.env[key];
          continue;
        }

        process.env[key] = value;
      }
    }
  });

  it("does not depend on .env when an explicit raw env object is supplied", () => {
    const runtimeConfig = createRuntimeConfig(
      {
        DISCORD_TOKEN: "inline-token",
        GUILD_IDS: "123,456",
        DEBUG: "false",
      },
      "D:/workspace",
    );

    expect(runtimeConfig.env.DISCORD_TOKEN).toBe("inline-token");
    expect(runtimeConfig.commandRegistration.guildIds).toEqual(["123", "456"]);
    expect(runtimeConfig.commandRegistration.mode).toBe("guild");
    expect(runtimeConfig.debug).toBe(false);
  });
});
