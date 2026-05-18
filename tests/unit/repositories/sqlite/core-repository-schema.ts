import type { SqliteDatabase } from "../../../../src/repositories/sqlite/db.js";
import { ensureCoreSchema } from "../../../../src/repositories/sqlite/core-schema.js";

export function createCoreRepositorySchema(database: SqliteDatabase): void {
  ensureCoreSchema(database);
}
