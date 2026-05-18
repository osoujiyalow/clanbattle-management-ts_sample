import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

type RawCase = {
  id: string;
  pythonSourceRefs: string[];
  capturedArtifacts: string[];
};

type RawCatalog = {
  schemaVersion: number;
  catalogKind: "raw";
  cases: RawCase[];
};

type VerifiedCase = {
  id: string;
  pythonSourceRefs: string[];
  commandSpecRefs: string[];
  expectedUi: Record<string, unknown>;
  expectedDb: Record<string, unknown>;
  review: {
    status: string;
    uiReviewed: boolean;
    dbReviewed: boolean;
  };
};

type VerifiedCatalog = {
  schemaVersion: number;
  catalogKind: "verified";
  cases: VerifiedCase[];
};

type ManifestCase = {
  id: string;
  raw: boolean;
  verified: boolean;
  reviewedUi: boolean;
  reviewedDb: boolean;
  parityFocus: string[];
};

type Manifest = {
  schemaVersion: number;
  rawCatalog: string;
  verifiedCatalog: string;
  requiredCaseIds: string[];
  cases: ManifestCase[];
};

function readJson<T>(targetPath: string): T {
  return JSON.parse(readFileSync(targetPath, "utf8")) as T;
}

const parityDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(parityDir, "..", "..");
const manifestPath = path.join(repoRoot, "tests", "parity", "cases", "manifest.json");

describe("parity fixture manifest", () => {
  const manifest = readJson<Manifest>(manifestPath);
  const rawCatalog = readJson<RawCatalog>(path.join(repoRoot, manifest.rawCatalog));
  const verifiedCatalog = readJson<VerifiedCatalog>(
    path.join(repoRoot, manifest.verifiedCatalog),
  );

  it("keeps manifest and catalogs on the same schema version", () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(rawCatalog.schemaVersion).toBe(manifest.schemaVersion);
    expect(verifiedCatalog.schemaVersion).toBe(manifest.schemaVersion);
    expect(rawCatalog.catalogKind).toBe("raw");
    expect(verifiedCatalog.catalogKind).toBe("verified");
  });

  it("covers every required case in raw and verified catalogs", () => {
    const rawIds = new Set(rawCatalog.cases.map((entry) => entry.id));
    const verifiedIds = new Set(verifiedCatalog.cases.map((entry) => entry.id));
    const manifestIds = new Set(manifest.cases.map((entry) => entry.id));

    for (const caseId of manifest.requiredCaseIds) {
      expect(manifestIds.has(caseId)).toBe(true);
      expect(rawIds.has(caseId)).toBe(true);
      expect(verifiedIds.has(caseId)).toBe(true);
    }
  });

  it("requires verified cases to be reviewed for both UI and DB", () => {
    const verifiedById = new Map(verifiedCatalog.cases.map((entry) => [entry.id, entry]));

    for (const caseId of manifest.requiredCaseIds) {
      const verifiedCase = verifiedById.get(caseId);

      expect(verifiedCase).toBeDefined();
      expect(verifiedCase?.pythonSourceRefs.length).toBeGreaterThan(0);
      expect(verifiedCase?.commandSpecRefs.length).toBeGreaterThan(0);
      expect(Object.keys(verifiedCase?.expectedUi ?? {})).not.toHaveLength(0);
      expect(Object.keys(verifiedCase?.expectedDb ?? {})).not.toHaveLength(0);
      expect(verifiedCase?.review.status).toBe("verified");
      expect(verifiedCase?.review.uiReviewed).toBe(true);
      expect(verifiedCase?.review.dbReviewed).toBe(true);
    }
  });

  it("requires raw cases to keep capture references and artifacts", () => {
    for (const rawCase of rawCatalog.cases) {
      expect(rawCase.pythonSourceRefs.length).toBeGreaterThan(0);
      expect(rawCase.capturedArtifacts.length).toBeGreaterThan(0);
    }
  });

  it("keeps manifest review flags aligned with verified catalog review flags", () => {
    const verifiedById = new Map(verifiedCatalog.cases.map((entry) => [entry.id, entry]));

    for (const manifestCase of manifest.cases) {
      const verifiedCase = verifiedById.get(manifestCase.id);

      expect(manifestCase.raw).toBe(true);
      expect(manifestCase.verified).toBe(true);
      expect(manifestCase.parityFocus.length).toBeGreaterThan(0);
      expect(verifiedCase?.review.uiReviewed).toBe(manifestCase.reviewedUi);
      expect(verifiedCase?.review.dbReviewed).toBe(manifestCase.reviewedDb);
    }
  });
});
