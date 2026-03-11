import fs from "node:fs";
import path from "node:path";

import { type Clock, systemClock } from "./time.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

export interface LoggerOptions {
  scope: string;
  logDir: string;
  minLevel?: LogLevel;
  clock?: Clock;
  logFileName?: string;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function shouldLog(level: LogLevel, minLevel: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minLevel];
}

function ensureLogDirectory(logDir: string): void {
  fs.mkdirSync(logDir, { recursive: true });
}

function serializeContext(context: LogContext | undefined): string {
  if (!context || Object.keys(context).length === 0) {
    return "";
  }

  const pairs = Object.entries(context).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  return ` ${pairs.join(" ")}`;
}

function serializeError(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: serializeError(value.cause),
    };
  }

  return value;
}

export function createLogger(options: LoggerOptions): Logger {
  const minLevel = options.minLevel ?? "info";
  const clock = options.clock ?? systemClock;
  const logFileName = options.logFileName ?? "app.jsonl";
  const logFilePath = path.join(options.logDir, logFileName);

  function write(level: LogLevel, message: string, context?: LogContext): void {
    if (!shouldLog(level, minLevel)) {
      return;
    }

    const timestamp = clock.now().toISOString();
    const consoleLine = `[${timestamp}] [${level.toUpperCase()}] [${options.scope}] ${message}${serializeContext(context)}`;
    const jsonLine = JSON.stringify({
      timestamp,
      level,
      scope: options.scope,
      message,
      context: context ? serializeError(context) : undefined,
    });

    if (level === "error") {
      console.error(consoleLine);
    } else if (level === "warn") {
      console.warn(consoleLine);
    } else {
      console.log(consoleLine);
    }

    ensureLogDirectory(options.logDir);
    fs.appendFileSync(logFilePath, `${jsonLine}\n`, "utf8");
  }

  return {
    debug(message, context) {
      write("debug", message, context);
    },
    info(message, context) {
      write("info", message, context);
    },
    warn(message, context) {
      write("warn", message, context);
    },
    error(message, context) {
      write("error", message, context);
    },
  };
}
