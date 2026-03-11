import path from "node:path";

import { parseEnv, type AppEnv, type RawEnv } from "./env.js";

export interface RuntimeConfig {
  env: AppEnv;
  paths: {
    rootDir: string;
    dbPath: string;
    logDir: string;
  };
  commandRegistration: {
    guildIds: readonly string[];
    mode: "guild" | "global";
  };
  logging: {
    level: AppEnv["LOG_LEVEL"];
  };
  debug: boolean;
}

function isProcessEnv(rawEnv: RawEnv): boolean {
  return rawEnv === process.env;
}

function loadDotenvIfPresent(rootDir: string): void {
  const envPath = path.resolve(rootDir, ".env");

  try {
    process.loadEnvFile(envPath);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }

    throw error;
  }
}

export function createRuntimeConfig(
  rawEnv: RawEnv = process.env,
  rootDir: string = process.cwd(),
): RuntimeConfig {
  if (isProcessEnv(rawEnv)) {
    loadDotenvIfPresent(rootDir);
  }

  const env = parseEnv(rawEnv);
  const guildIds = [...env.GUILD_IDS];

  return {
    env,
    paths: {
      rootDir,
      dbPath: path.resolve(rootDir, env.DB_PATH),
      logDir: path.resolve(rootDir, env.LOG_DIR),
    },
    commandRegistration: {
      guildIds,
      mode: guildIds.length > 0 ? "guild" : "global",
    },
    logging: {
      level: env.LOG_LEVEL,
    },
    debug: env.DEBUG,
  };
}
