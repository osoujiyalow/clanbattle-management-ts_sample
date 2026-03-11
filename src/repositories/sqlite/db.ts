import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

export type SqliteDatabase = Database.Database;

export interface OpenSqliteDatabaseOptions {
  filePath: string;
  readonly?: boolean;
  fileMustExist?: boolean;
  verbose?: Database.Options["verbose"];
  busyTimeoutMs?: number;
  journalMode?: "WAL" | "DELETE" | "TRUNCATE" | "MEMORY";
  safeIntegers?: boolean;
  additionalPragmas?: readonly string[];
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export function openSqliteDatabase(options: OpenSqliteDatabaseOptions): SqliteDatabase {
  const readonly = options.readonly ?? false;

  if (!readonly) {
    fs.mkdirSync(path.dirname(options.filePath), { recursive: true });
  }

  const database = new Database(options.filePath, {
    readonly,
    fileMustExist: options.fileMustExist ?? false,
    verbose: options.verbose,
  });

  database.pragma(`busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);
  database.pragma("foreign_keys = ON");

  if (!readonly) {
    database.pragma(`journal_mode = ${options.journalMode ?? "WAL"}`);
  }

  database.defaultSafeIntegers(options.safeIntegers ?? true);

  for (const pragma of options.additionalPragmas ?? []) {
    database.pragma(pragma);
  }

  return database;
}

export function closeSqliteDatabase(database: SqliteDatabase): void {
  if (database.open) {
    database.close();
  }
}

export function runInTransaction<TResult>(
  database: SqliteDatabase,
  operation: (database: SqliteDatabase) => TResult,
): TResult {
  const transaction = database.transaction(() => operation(database));
  return transaction();
}
