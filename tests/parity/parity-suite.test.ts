import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runParityScenarios } from "./scenario-runner.js";

type VerifiedCase = {
  id: string;
  expectedUi: {
    visibility?: "public" | "ephemeral" | "none";
  };
  expectedDb: {
    touchedTables?: string[];
  };
};

type VerifiedCatalog = {
  cases: VerifiedCase[];
};

type Manifest = {
  requiredCaseIds: string[];
  verifiedCatalog: string;
};

function readJson<T>(targetPath: string): T {
  return JSON.parse(readFileSync(targetPath, "utf8")) as T;
}

const parityDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(parityDir, "..", "..");
const manifestPath = path.join(repoRoot, "tests", "parity", "cases", "manifest.json");
const snapshotPath = path.join(repoRoot, "tests", "parity", "snapshots", "major-cases.json");

describe("parity suite", () => {
  const manifest = readJson<Manifest>(manifestPath);
  const verifiedCatalog = readJson<VerifiedCatalog>(
    path.join(repoRoot, manifest.verifiedCatalog),
  );
  const expectedSnapshots = readJson<Record<string, unknown>>(snapshotPath);

  it("replays verified scenarios and matches the stored parity snapshots", async () => {
    const results = await runParityScenarios();
    const actualSnapshots = Object.fromEntries(results.map((result) => [result.id, result.actual]));
    const verifiedById = new Map(verifiedCatalog.cases.map((entry) => [entry.id, entry]));

    expect(results.map((result) => result.id)).toEqual(manifest.requiredCaseIds);

    for (const result of results) {
      const verifiedCase = verifiedById.get(result.id);

      expect(verifiedCase).toBeDefined();
      expect(result.visibility).toBe(verifiedCase?.expectedUi.visibility);
      expect(result.touchedTables).toEqual(verifiedCase?.expectedDb.touchedTables);
    }

    expect(actualSnapshots).toEqual(expectedSnapshots);
  });
});
