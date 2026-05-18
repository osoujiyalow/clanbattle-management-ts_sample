import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TempSqlitePath {
  readonly filePath: string;
  cleanup(): void;
}

export function createTempSqlitePath(prefix: string = "cb-sqlite-"): TempSqlitePath {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const filePath = path.join(directory, "test.sqlite3");

  return {
    filePath,
    cleanup: () => {
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
