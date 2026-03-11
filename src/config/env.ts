import { z } from "zod";

const booleanishSchema = z
  .union([z.boolean(), z.string(), z.number()])
  .transform((value, context) => {
    if (typeof value === "boolean") {
      return value;
    }

    if (typeof value === "number") {
      return value !== 0;
    }

    const normalized = value.trim().toLowerCase();

    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }

    if (["0", "false", "no", "off", ""].includes(normalized)) {
      return false;
    }

    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "boolean value is invalid",
    });

    return z.NEVER;
  });

const guildIdsSchema = z
  .string()
  .optional()
  .default("")
  .transform((value, context) => {
    const guildIds = value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    for (const guildId of guildIds) {
      if (!/^\d+$/.test(guildId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `invalid guild id: ${guildId}`,
        });
      }
    }

    return guildIds;
  });

export const envSchema = z.object({
  DISCORD_TOKEN: z.string().trim().min(1, "DISCORD_TOKEN is required"),
  DB_PATH: z.string().trim().min(1).default("clanbattle.sqlite3"),
  GUILD_IDS: guildIdsSchema,
  LOG_DIR: z.string().trim().min(1).default("logs"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DEBUG: booleanishSchema.default(false),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppEnv = z.output<typeof envSchema>;
export type RawEnv = Record<string, string | undefined>;

export function parseEnv(rawEnv: RawEnv = process.env): AppEnv {
  return envSchema.parse(rawEnv);
}
