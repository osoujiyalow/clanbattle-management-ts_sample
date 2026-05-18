import {
  closeSqliteDatabase,
  openSqliteDatabase,
  type SqliteDatabase,
} from "../../../src/repositories/sqlite/db.js";
import { createCoreRepositorySchema } from "../../unit/repositories/sqlite/core-repository-schema.js";
import {
  createTempSqlitePath,
} from "../../unit/repositories/sqlite/test-sqlite-path.js";

export interface IntegrationSqliteHarness {
  readonly database: SqliteDatabase;
  readonly filePath: string;
  cleanup(): void;
}

export function createIntegrationSqliteHarness(): IntegrationSqliteHarness {
  const tempPath = createTempSqlitePath("cb-integration-sqlite-");
  const database = openSqliteDatabase({ filePath: tempPath.filePath });
  let cleaned = false;

  createCoreRepositorySchema(database);

  return {
    database,
    filePath: tempPath.filePath,
    cleanup() {
      if (cleaned) {
        return;
      }

      cleaned = true;
      closeSqliteDatabase(database);
      tempPath.cleanup();
    },
  };
}

export async function withIntegrationSqliteHarness<T>(
  run: (harness: IntegrationSqliteHarness) => Promise<T>,
): Promise<T> {
  const harness = createIntegrationSqliteHarness();

  try {
    return await run(harness);
  } finally {
    harness.cleanup();
  }
}
